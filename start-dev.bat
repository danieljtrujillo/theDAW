@echo off
title StableDAW - Dev Launcher
echo ========================================
echo   StableDAW - Development Server
echo ========================================
echo.

:: Kill any stale processes on our ports
echo Cleaning up stale processes...
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr ":5173 " ^| findstr "LISTENING"') do (
    echo   Killing PID %%a on port 5173
    taskkill /F /PID %%a >nul 2>&1
)
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr ":8600 " ^| findstr "LISTENING"') do (
    echo   Killing PID %%a on port 8600
    taskkill /F /PID %%a >nul 2>&1
)
timeout /t 1 /nobreak >nul

:: Start the backend API server (port 8600)
echo [1/3] Starting backend API server on port 8600...
start "SA3 Backend" cmd /k "cd /d %~dp0 && .venv\Scripts\activate && python -m backend.run"

:: Give backend a moment to bind
timeout /t 3 /nobreak >nul

:: Start the frontend dev server (port 5173)
echo [2/3] Starting frontend dev server on port 5173...
start "SA3 Frontend" cmd /k "cd /d %~dp0frontend && npm run dev"

:: Give Vite a moment to bind
timeout /t 3 /nobreak >nul

:: Start public tunnel (localtunnel)
echo [3/3] Starting public tunnel...
start "SA3 Tunnel" cmd /k "lt --port 5173 --subdomain stabledaw --print-requests"

echo.
echo All servers starting:
echo   Backend API:    http://localhost:8600
echo   Frontend UI:    http://localhost:5173
echo   Public Link:    https://stabledaw.localtunnel.me
echo.
echo   Each browser/tab gets independent app state.
echo   Share the public link with others to collaborate.
echo.
echo Press any key to open the UI in your browser...
pause >nul
start http://localhost:5173