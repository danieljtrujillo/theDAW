@echo off
title theDAW
echo ========================================
echo   theDAW
echo ========================================
echo.

:: Run from the repo root (this script's folder) so the checks + bootstrap
:: below resolve .venv / frontend\node_modules relative to the project.
cd /d "%~dp0"

:: -- Preflight: required tools ------------------------------------------
:: uv  = Python env manager (creates .venv, installs torch/CUDA + flash-attn)
:: node/npm = frontend dev server + the VJ sidecar
:: ffmpeg = all audio I/O (effects, exports, library ingest, MIDI, YouTube)
:: The public tunnel (localtunnel "lt") is optional and auto-detected by the
:: dev stack at the end.
echo Checking prerequisites...
set "MISSING="
where uv   >nul 2>&1 || set "MISSING=%MISSING% uv"
where node >nul 2>&1 || set "MISSING=%MISSING% node"
where npm  >nul 2>&1 || set "MISSING=%MISSING% npm"
if defined MISSING (
    echo   Missing required tools:%MISSING%
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
where ffmpeg >nul 2>&1 || echo   [!] ffmpeg not on PATH - audio effects/exports/ingest fail until installed. Run Setup-theDAW.bat to add it.
echo   [OK] required tools present.
echo.

:: -- Bootstrap dependencies if this is a fresh / incomplete tree --------
if not exist ".venv\Scripts\activate" (
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
echo.

:: -- Kill any stale processes on our ports ------------------------------
echo Cleaning up stale processes...
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr ":5173 " ^| findstr "LISTENING"') do taskkill /F /PID %%a >nul 2>&1
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr ":8600 " ^| findstr "LISTENING"') do taskkill /F /PID %%a >nul 2>&1
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr ":5187 " ^| findstr "LISTENING"') do taskkill /F /PID %%a >nul 2>&1
timeout /t 1 /nobreak >nul

:: -- Launch the whole stack in THIS one console ------------------------
:: backend._devstack runs the backend (with the rc=88 restart contract so the
:: in-app Restart button works), the Vite frontend, and the optional
:: localtunnel, streaming all three as prefixed [backend] / [frontend] /
:: [tunnel] log lines here. It opens http://localhost:5173 once Vite is ready.
:: Ctrl-C in this window stops everything.
echo Starting theDAW (backend + frontend + tunnel) in this console...
echo   Backend API:  http://localhost:8600
echo   Frontend UI:  http://localhost:5173
echo   VJ sidecar:   http://localhost:5187  ^(auto-spawned by backend^)
echo.
call .venv\Scripts\activate
python -m backend._devstack

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
echo   Double-click Setup-theDAW.bat to install the prerequisites, then run theDAW.bat.
echo.
pause
exit /b 1
