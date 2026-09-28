@echo off
title theDAW

:: Run from the repo root (this script's folder) so the checks + bootstrap
:: below resolve .venv / frontend\node_modules relative to the project.
cd /d "%~dp0"

:: -- Git hooks: the repo ships them in .githooks (ruff on every commit, the
:: cross-platform lock check when pyproject/uv.lock are staged). One config
:: line per clone, safe to repeat; ignored when git is absent.
git config core.hooksPath .githooks >nul 2>&1

:: -- uv cache on THIS repo's drive --------------------------------------
:: uv installs wheels into .venv by hardlinking from its cache, but a hardlink
:: cannot cross volumes. uv's default cache lives on the system drive, which is
:: often a different drive than this repo (e.g. app on D:, cache on C:) - so uv
:: prints "Failed to hardlink files; falling back to full copy" and every wheel
:: is copied in full (slow, extra disk). Pointing the cache at a same-drive
:: folder lets the hardlink succeed: fast installs, no fallback. Inherited by
:: the setup.ps1 child that builds underfit\.venv, so it fixes that sync too.
:: An explicit user-set UV_CACHE_DIR is respected.
if not defined UV_CACHE_DIR set "UV_CACHE_DIR=%~dp0.uv-cache"

:: -- Preflight: required tools ------------------------------------------
:: uv  = Python env manager (creates .venv, installs torch/CUDA + flash-attn)
:: node/npm = frontend dev server + the VJ sidecar
:: ffmpeg = all audio I/O (effects, exports, library ingest, MIDI, YouTube).
::   It must be a build with libsoxr: Classical Upsample, Super-Res and
::   High-Quality SRC resample with it, and gyan.dev's "essentials" build, which
::   other apps put on PATH, has none. The quick check resamples 50 ms of sine
::   through soxr with the first ffmpeg on PATH; only when that fails does
::   setup.ps1 -FFmpegCheck look in the other places the backend looks (winget's
::   Gyan.FFmpeg, scoop, Chocolatey, THEDAW_FFMPEG). No libsoxr anywhere counts
::   as missing, so setup.ps1 offers the full build with the usual consent.
:: The public tunnel (localtunnel "lt") is optional and auto-detected by the
:: dev stack at the end.
set "MISSING="
where uv     >nul 2>&1 || set "MISSING=%MISSING% uv"
where node   >nul 2>&1 || set "MISSING=%MISSING% node"
where npm    >nul 2>&1 || set "MISSING=%MISSING% npm"
set "FFMPEG_SOXR=0"
where ffmpeg >nul 2>&1 && ffmpeg -hide_banner -nostdin -loglevel error -f lavfi -i sine=d=0.05 -af aresample=48000:resampler=soxr -f null - >nul 2>&1 && set "FFMPEG_SOXR=1"
if "%FFMPEG_SOXR%"=="0" powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install\setup.ps1" -FFmpegCheck >nul 2>&1 && set "FFMPEG_SOXR=1"
if "%FFMPEG_SOXR%"=="0" set "MISSING=%MISSING% ffmpeg-full-build"
where git    >nul 2>&1 || set "MISSING=%MISSING% git"
if defined MISSING (
    echo   Missing tools:%MISSING%
    echo   Running the one-time setup helper ^(detects hardware + installs prerequisites with your consent^)...
    echo.
    powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install\setup.ps1"
    if errorlevel 10 goto :rerun
    if errorlevel 2 goto :needtools
)
:: Re-verify the hard-required tools before bootstrapping.
where uv   >nul 2>&1 || goto :needtools
where node >nul 2>&1 || goto :needtools
where npm  >nul 2>&1 || goto :needtools
:: A declined FFmpeg offer is not fatal; say what stays broken. FFMPEG_SOXR is
:: from the check above: setup.ps1 sends a launch that installed something back
:: through :rerun, so a value still at 0 here means nothing was installed. The
:: IF governs the whole line, && and || included.
if "%FFMPEG_SOXR%"=="0" where ffmpeg >nul 2>&1 && echo   [!] This FFmpeg has no libsoxr - Classical Upsample, Super-Res and High-Quality SRC fail until the full FFmpeg build is installed. || echo   [!] ffmpeg not on PATH - audio effects/exports/ingest fail until installed.

:: -- Bootstrap Python deps if the venv is missing OR incomplete --------
:: A previous `uv sync` can be interrupted AFTER uv creates the venv but
:: BEFORE it installs packages, leaving .venv\Scripts\activate present while
:: uvicorn / fastapi and the other declared deps are absent. The old
:: "venv exists -> skip sync" check then launched the backend against a
:: half-built env and crashed on `import uvicorn`. So sync when a core import
:: fails too, not only when the venv is missing entirely.
set "NEED_SYNC=0"
if not exist ".venv\Scripts\activate" set "NEED_SYNC=1"
if not exist ".venv\Scripts\python.exe" set "NEED_SYNC=1"
if "%NEED_SYNC%"=="0" (
    .venv\Scripts\python.exe -c "import uvicorn, fastapi" >nul 2>&1
    if errorlevel 1 set "NEED_SYNC=1"
)
if "%NEED_SYNC%"=="1" (
    echo Bootstrapping Python env: uv sync --group dev
    echo   First run downloads torch + CUDA wheels and can take several minutes...
    call uv sync --group dev
    if errorlevel 1 (
        echo.
        echo   [X] uv sync failed - see the error above.
        pause
        exit /b 1
    )
)

:: -- Underfit trainer tab: create its optional venv if the vendored underfit\
::    is present but underfit\.venv is missing. Delegated to setup.ps1 (consent
::    prompt + uv sync --inexact); best-effort - never blocks the launch.
if exist "underfit\pyproject.toml" if not exist "underfit\.venv\Scripts\python.exe" (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install\setup.ps1" -UnderfitVenv
)
if not exist "frontend\node_modules" (
    echo Installing frontend dependencies: npm install
    pushd frontend
    call npm install
    if errorlevel 1 (
        popd
        echo.
        echo   [X] npm install failed - see the error above.
        pause
        exit /b 1
    )
    popd
)
if not exist "VST-Foundry-UI\VST-UI-FOUNDRY\node_modules" (
    echo Installing VST Foundry dependencies: npm install
    pushd VST-Foundry-UI\VST-UI-FOUNDRY
    call npm install
    if errorlevel 1 (
        popd
        echo.
        echo   [X] VST Foundry npm install failed - see the error above.
        pause
        exit /b 1
    )
    popd
)
echo.

:: -- Native live-VST host: advisory status line ------------------------
:: Mirrors theDAW.sh, which prints the same advisory line at this exact
:: point in its launch order: after the dependency bootstrap, before the
:: port sweep. scripts\check_vst_host.py imports nothing from backend and
:: always exits 0; it runs on the launcher's own interpreter, guarded the
:: same way as the launch-mode read below, so a launch that has no venv
:: yet skips the whole thing in silence.
:: Live VST hosting is an OPTIONAL capability: nothing in this block may
:: print an error, stop for input twice, or leave an ERRORLEVEL behind -
:: plugins still work offline without the host. THEDAW_SKIP_VST_HOST_BUILD=1
:: suppresses the build offer; the status line is printed either way.
:: Delayed expansion is scoped to this block alone. The status line can
:: carry the host exe's own --version text, and !var! is substituted AFTER
:: cmd has parsed the command, so a stray & | < > ^ in it stays text
:: instead of turning into an operator. The one character that costs
:: something is ! itself: that same pass eats it, so a version string
:: containing one is echoed without it. Cosmetic, and only in the text
:: printed here - nothing downstream reads this line.
:: For the SAME reason no command below may use %~dp0. Percent expansion
:: runs FIRST and pastes the repo path in, and the delayed pass then
:: strips any ! out of THAT, so a checkout at C:\hi!\theDAW would hand
:: powershell a -File path that does not exist. cwd is already the repo
:: root (cd /d "%~dp0" at the top of this script), so every path below is
:: relative - the same way the launch-mode read reaches its interpreter.
if not exist ".venv\Scripts\python.exe" goto :vsthostdone
setlocal enabledelayedexpansion
set "VST_HOST_LINE="
:: NOTE: the python path must be UNQUOTED inside the backticks - the same
:: cmd parser limitation called out at the launch-mode read below.
for /f "usebackq delims=" %%v in (`.venv\Scripts\python.exe scripts\check_vst_host.py 2^>nul`) do set "VST_HOST_LINE=%%v"
if not defined VST_HOST_LINE goto :vsthostend
echo !VST_HOST_LINE!
:: Offer the build only for a missing exe, and only when CMake is actually
:: there to build it. setup.ps1 asks for consent and prints one line when
:: it is declined or the build fails; either way the launch carries on.
if "!THEDAW_SKIP_VST_HOST_BUILD!"=="1" goto :vsthostend
if "!VST_HOST_LINE:not built=!"=="!VST_HOST_LINE!" goto :vsthostend
:: Ask once. An interactive decline leaves this marker behind; deleting it,
:: or running install\setup.ps1 -VstHost by hand, brings the offer back, and
:: a successful build clears it. Only the launcher consults the marker - the
:: script run by hand always asks.
if exist "native\vst-host\.build-declined" goto :vsthostend
where cmake >nul 2>&1 || goto :vsthostend
powershell -NoProfile -ExecutionPolicy Bypass -File "install\setup.ps1" -VstHost
:vsthostend
endlocal
:vsthostdone
:: Clear whatever the block left behind - a skipped check, a failed `where`,
:: or a powershell that could not start - so none of it reads as a launch
:: failure to the steps below.
ver >nul

:: -- Stop theDAW's OWN stale listeners -- and nothing else -------------
:: backend.ports --free stops a listener ONLY when its command line or working
:: directory is inside THIS checkout: the PID is revalidated just before the
:: signal, and a backend is asked to shut down cleanly first. Any other
:: program on these ports -- another project's Vite, another Electron app's
:: server -- is LEFT ALONE and named in the log. This used to be a blind
:: netstat ^| taskkill that killed whatever held the port.
:: Without the venv nothing of ours can be running from this checkout.
if exist ".venv\Scripts\python.exe" ".venv\Scripts\python.exe" -m backend.ports --free --all-ports

:: -- Read the saved launch mode (web | desktop) from data\settings.json -
:: Set in-app via Settings -> Startup. Defaults to web if unset/missing.
set "LAUNCH_MODE=web"
if not exist "data\settings.json" goto :modeready
if not exist ".venv\Scripts\python.exe" goto :modeready
:: NOTE: the python path must be UNQUOTED here — a quoted exe inside a `for /f`
:: backtick command breaks cmd's parser (and 2^>nul would then hide the error,
:: silently falling back to web). The path has no spaces, so unquoted is safe.
for /f "usebackq delims=" %%m in (`.venv\Scripts\python.exe -c "import json;print((json.load(open('data/settings.json')).get('app') or {}).get('launch_mode','web'))" 2^>nul`) do set "LAUNCH_MODE=%%m"
:modeready

if /i "%LAUNCH_MODE%"=="desktop" goto :desktop

:: -- WEB mode: backend + Vite + browser in THIS one console -----------
:: backend._devstack runs the backend (with the rc=88 restart contract so the
:: in-app Restart button works), the Vite frontend, and the optional
:: localtunnel, streaming all three as prefixed [backend] / [frontend] /
:: [tunnel] log lines here. It opens http://localhost:5173 once Vite is ready.
:: Ctrl-C in this window stops everything.
echo Launch mode: WEB ^(browser^)  -  change in Settings ^> Startup
call .venv\Scripts\activate
python -m backend._devstack
goto :stopped

:desktop
:: -- DESKTOP mode: the Electron shell (it spawns the backend itself) ---
:: electron-vite serves the same frontend and Electron starts the backend
:: (backend._supervisor) if one isn't already running. Close the window or
:: Ctrl-C to stop. Switch back to the browser in Settings ^> Startup.
echo Launch mode: DESKTOP ^(Electron^)  -  change in Settings ^> Startup
:: Auto-install/refresh desktop deps so startup never needs a terminal.
:: Reinstall when node_modules is missing OR electron-ui\package.json changed
:: since the last install (npm writes node_modules\.package-lock.json on install).
set "NEED_DESKTOP_NPM=0"
if not exist "electron-ui\node_modules" set "NEED_DESKTOP_NPM=1"
if not exist "electron-ui\node_modules\.package-lock.json" goto :desktop_npm_ready
if not exist ".venv\Scripts\python.exe" goto :desktop_npm_ready
for /f "usebackq delims=" %%s in (`.venv\Scripts\python.exe -c "import os;print(1 if os.path.getmtime('electron-ui/package.json')>os.path.getmtime('electron-ui/node_modules/.package-lock.json') else 0)" 2^>nul`) do set "NEED_DESKTOP_NPM=%%s"
:desktop_npm_ready
if "%NEED_DESKTOP_NPM%"=="1" (
    echo Installing/updating desktop app dependencies - first run or after an update can take a few minutes...
    pushd electron-ui
    call npm install
    popd
)

:: Ensure the Electron binary is actually present. An interrupted download
:: leaves the package installed but WITHOUT its binary, which makes electron-vite
:: throw "Electron uninstall". Self-heal by re-running electron's own installer
:: (idempotent + resumable) - this must never take down the launch.
if not exist "electron-ui\node_modules\electron\dist\electron.exe" (
    echo Repairing Electron download ^(a previous run may have been interrupted^)...
    pushd electron-ui
    if exist "node_modules\electron\install.js" node node_modules\electron\install.js
    popd
)

:: If the desktop app still can't run, fall back to the browser - NEVER fail.
if not exist "electron-ui\node_modules\electron\dist\electron.exe" (
    echo.
    echo   Desktop app isn't ready yet - starting theDAW in your browser instead.
    echo   Re-run theDAW.bat later to retry the desktop app.
    echo.
    call .venv\Scripts\activate
    python -m backend._devstack
    goto :stopped
)

:: The desktop window loads http://localhost:5173 as well, and its saved
:: settings and mic/MIDI permissions belong to that address. When another
:: program holds 5173 the launch stops here with that program's name, since
:: on any other port the window would open with all of them empty.
ver >nul
if exist ".venv\Scripts\python.exe" ".venv\Scripts\python.exe" -m backend.ports --require-frontend-port
if errorlevel 1 goto :stopped

pushd electron-ui
call npm run dev
popd
goto :stopped

:stopped
echo.
echo theDAW stopped. Press any key to close this window...
pause >nul
exit /b 0

:rerun
echo.
echo   Setup installed new tools. Close this window and double-click theDAW.bat again to launch.
echo.
pause
exit /b 0

:needtools
echo.
echo   theDAW needs uv + Node to run, and they are not installed yet.
echo   Double-click theDAW.bat again to retry the installer, or install uv + Node by hand.
echo.
pause
exit /b 1
