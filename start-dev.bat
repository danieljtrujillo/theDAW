@echo off
title theDAW - Dev Launcher
echo ========================================
echo   theDAW - Development Server
echo ========================================
echo.

:: Run from the repo root (this script's folder) so the checks + bootstrap
:: below resolve .venv / frontend\node_modules relative to the project.
cd /d "%~dp0"

:: ── Preflight: required tools ──────────────────────────────────────────
:: uv  = Python env manager (creates .venv, installs torch/CUDA)
:: node/npm = frontend dev server + the VJ sidecar
:: ffmpeg = all audio I/O (effects, exports, library ingest, MIDI, YouTube)
:: The public tunnel (localtunnel `lt`) is optional and gated further down.
echo Checking prerequisites...
set "MISSING="
where uv   >nul 2>&1 || set "MISSING=%MISSING% uv"
where node >nul 2>&1 || set "MISSING=%MISSING% node"
where npm  >nul 2>&1 || set "MISSING=%MISSING% npm"
if defined MISSING (
    echo.
    echo   [X] Missing required tools:%MISSING%
    echo.
    echo   Install these, put each on your PATH, then re-run start-dev.bat:
    echo     uv     -^> https://docs.astral.sh/uv/getting-started/installation/
    echo     node   -^> https://nodejs.org/   ^(v20.19+ or v22.12+, includes npm^)
    echo.
    pause
    exit /b 1
)
where ffmpeg >nul 2>&1 || echo   [!] ffmpeg not on PATH — audio effects/exports/ingest WILL fail. Get a build at https://www.gyan.dev/ffmpeg/builds/ and add its bin\ to PATH.
echo   [OK] uv, node, npm found.
echo.

:: ── Bootstrap dependencies if this is a fresh / incomplete tree ─────────
if not exist ".venv\Scripts\activate" (
    echo Bootstrapping Python env: uv sync --group dev
    echo   First run downloads torch + CUDA wheels and can take several minutes...
    call uv sync --group dev
    if errorlevel 1 (
        echo.
        echo   [X] uv sync failed — see the error above.
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
        echo   [X] npm install failed — see the error above.
        pause
        exit /b 1
    )
    popd
)
echo.

:: ── Kill any stale processes on our ports ──────────────────────────────
echo Cleaning up stale processes...
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr ":5173 " ^| findstr "LISTENING"') do (
    echo   Killing PID %%a on port 5173
    taskkill /F /PID %%a >nul 2>&1
)
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr ":8600 " ^| findstr "LISTENING"') do (
    echo   Killing PID %%a on port 8600
    taskkill /F /PID %%a >nul 2>&1
)
:: VJ sidecar (default port 5187). Kill stale instances so the
:: backend's vj module can spawn a fresh one on startup.
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr ":5187 " ^| findstr "LISTENING"') do (
    echo   Killing PID %%a on port 5187 ^(VJ sidecar^)
    taskkill /F /PID %%a >nul 2>&1
)
timeout /t 1 /nobreak >nul

:: Start the backend API server (port 8600) under the supervisor so
:: the in-app "Restart server" button can respawn it inside this same
:: console window without losing the visible log.
echo [1/3] Starting backend API server on port 8600 (with supervisor)...
start "SA3 Backend" cmd /k "cd /d %~dp0 && .venv\Scripts\activate && python -m backend._supervisor"

:: Give backend a moment to bind
timeout /t 3 /nobreak >nul

:: Start the frontend dev server (port 5173).
:: ENABLE_HMR=true turns Vite file-watching ON (the repo default is OFF so
:: agent edits don't nuke app state) — without it, code changes on disk are
:: silently never served until a manual Vite restart.
echo [2/3] Starting frontend dev server on port 5173 (HMR on)...
start "SA3 Frontend" cmd /k "cd /d %~dp0frontend && set ENABLE_HMR=true&& npm run dev"

:: Give Vite a moment to bind
timeout /t 3 /nobreak >nul

:: Start public tunnel (localtunnel) — OPTIONAL. Only if `lt` is installed;
:: the app is fully usable on localhost without it.
where lt >nul 2>&1
if errorlevel 1 (
    echo [3/3] Public tunnel skipped — localtunnel not installed.
    echo       Run "npm i -g localtunnel" if you want a shareable public link.
    set "TUNNEL=off"
) else (
    echo [3/3] Starting public tunnel...
    start "SA3 Tunnel" cmd /k "lt --port 5173 --subdomain stabledaw --print-requests"
    set "TUNNEL=on"
)

echo.
echo All servers starting:
echo   Backend API:    http://localhost:8600
echo   Frontend UI:    http://localhost:5173
echo   VJ sidecar:     http://localhost:5187  ^(auto-spawned by backend^)
if "%TUNNEL%"=="on" echo   Public Link:    https://stabledaw.localtunnel.me
echo.
echo   Each browser/tab gets independent app state.
if "%TUNNEL%"=="on" echo   Share the public link with others to collaborate.
echo.
echo Press any key to open the UI in your browser...
pause >nul
start http://localhost:5173
