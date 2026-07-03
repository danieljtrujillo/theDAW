@echo off
title theDAW (Desktop)

:: ===========================================================================
:: Dedicated Electron / desktop launcher for theDAW.
:: ===========================================================================
:: theDAW.bat reads launch_mode from data\settings.json and defaults to the WEB
:: stack (backend + Vite + browser). THIS launcher always starts the desktop
:: Electron shell directly — no need to change any setting. It does NOT modify
:: your saved launch_mode; double-click theDAW.bat any time to go back to web.
::
:: It mirrors theDAW.bat's preflight + desktop branch, and it kills any stale
:: backend on :8600 FIRST so the Electron shell spawns a fresh, supervised
:: backend (which loads every backend module — e.g. the VST Foundry tab)
:: instead of reattaching to an old process that started before those modules
:: existed. (The Electron main process reuses an already-running backend; a
:: stale one is exactly why a newly-added tab can stay broken across restarts.)
:: ===========================================================================

:: Run from the repo root (this script's folder).
cd /d "%~dp0"

:: -- Preflight: required tools ------------------------------------------
set "MISSING="
where uv     >nul 2>&1 || set "MISSING=%MISSING% uv"
where node   >nul 2>&1 || set "MISSING=%MISSING% node"
where npm    >nul 2>&1 || set "MISSING=%MISSING% npm"
where ffmpeg >nul 2>&1 || set "MISSING=%MISSING% ffmpeg"
where git    >nul 2>&1 || set "MISSING=%MISSING% git"
if defined MISSING (
    echo   Missing tools:%MISSING%
    echo   Run theDAW.bat once first ^(it installs prerequisites^), then retry this launcher.
    echo.
    pause
    exit /b 1
)

:: -- Bootstrap Python deps if the venv is missing OR incomplete --------
:: The Electron main process also self-heals the Python env, but doing it here
:: keeps startup output in this console and fails fast with a clear message.
set "NEED_SYNC=0"
if not exist ".venv\Scripts\activate"   set "NEED_SYNC=1"
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

:: -- Kill any stale processes on our ports ------------------------------
:: Critical for desktop mode: the Electron shell reuses an already-running
:: backend on :8600 instead of spawning a fresh one. Killing it forces a fresh,
:: SUPERVISED backend that loads every module (and makes the in-app Restart
:: button work again).
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr ":8600 " ^| findstr "LISTENING"') do taskkill /F /PID %%a >nul 2>&1
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr ":5173 " ^| findstr "LISTENING"') do taskkill /F /PID %%a >nul 2>&1
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr ":5187 " ^| findstr "LISTENING"') do taskkill /F /PID %%a >nul 2>&1
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr ":5472 " ^| findstr "LISTENING"') do taskkill /F /PID %%a >nul 2>&1
timeout /t 1 /nobreak >nul

echo.
echo Launch mode: DESKTOP ^(Electron^)  -  dedicated launcher
echo.

:: -- Ensure desktop deps are installed / up to date --------------------
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

:: -- Self-heal the Electron binary if a previous download was interrupted
:: An interrupted install leaves the package present but WITHOUT its binary,
:: which makes electron-vite throw "Electron uninstall". Re-run electron's own
:: installer (idempotent + resumable).
if not exist "electron-ui\node_modules\electron\dist\electron.exe" (
    echo Repairing Electron download ^(a previous run may have been interrupted^)...
    pushd electron-ui
    if exist "node_modules\electron\install.js" node node_modules\electron\install.js
    popd
)

if not exist "electron-ui\node_modules\electron\dist\electron.exe" (
    echo.
    echo   [X] Electron still isn't installed. From the repo root run:
    echo         pushd electron-ui ^&^& npm install ^&^& popd
    echo       then re-run this launcher.
    echo.
    pause
    exit /b 1
)

:: -- Launch the Electron desktop shell ---------------------------------
:: electron-vite serves the frontend in the Electron window, and the Electron
:: main process spawns a fresh supervised backend
:: (uv run python -m backend._supervisor) because none is running now.
:: Close the window or Ctrl-C to stop.
pushd electron-ui
call npm run dev
popd

echo.
echo theDAW (desktop) stopped. Press any key to close this window...
pause >nul
exit /b 0
