@echo off
setlocal EnableDelayedExpansion
title VST UI Foundry

echo.
echo  ===============================================
echo   VST UI FOUNDRY
echo  ===============================================
echo.

:: ── Require Node.js ────────────────────────────────────────────────────────────
where node >nul 2>&1
if errorlevel 1 (
    echo  [ERROR] Node.js not found.
    echo         Download and install from: https://nodejs.org
    echo.
    pause
    exit /b 1
)
for /f "tokens=*" %%v in ('node --version 2^>nul') do set NODE_VER=%%v
echo  Node.js %NODE_VER%

:: ── Install dependencies ───────────────────────────────────────────────────────
if not exist "node_modules" (
    echo  Installing dependencies...
    call :do_install
    if errorlevel 1 goto :install_failed
) else (
    echo  Dependencies present.
)

:: ── Verify native binaries are actually loadable ───────────────────────────────
:: npm has a known bug where optional native deps can install silently broken.
:: A quick node probe catches it before the server tries to start.
node -e "require('./node_modules/@tailwindcss/oxide/index.js')" >nul 2>&1
if errorlevel 1 (
    echo  [WARN] Native binaries broken ^(known npm optional-dep bug^).
    echo         Performing clean reinstall...
    call :do_clean_install
    if errorlevel 1 goto :install_failed
)

:: ── Check for Claude Code CLI ──────────────────────────────────────────────────
where claude >nul 2>&1
if errorlevel 1 (
    echo.
    echo  [WARN] Claude Code CLI not found.
    echo         The "Claude Code" provider will not work until you install it:
    echo           npm install -g @anthropic-ai/claude-code
    echo.
) else (
    for /f "tokens=*" %%v in ('claude --version 2^>nul') do echo  Claude Code: %%v
)

:: ── Launch ─────────────────────────────────────────────────────────────────────
echo.
echo  Starting VST UI Foundry...
echo  Open: http://localhost:5472
echo  Stop: Ctrl+C
echo.
start "" cmd /c "timeout /t 3 /nobreak >nul && start http://localhost:5472"
npm run dev
if errorlevel 1 (
    echo.
    echo  [ERROR] Server exited with an error. See output above.
    pause
    exit /b 1
)
goto :eof

:: ── Subroutines ────────────────────────────────────────────────────────────────
:do_install
npm install
exit /b %errorlevel%

:do_clean_install
if exist "node_modules" rmdir /s /q node_modules
if exist "package-lock.json" del /f /q package-lock.json
npm install
exit /b %errorlevel%

:install_failed
echo.
echo  [ERROR] npm install failed. Check the output above for details.
echo          Common fixes:
echo            - Run this script as Administrator
echo            - Check your internet connection
echo            - Delete node_modules and package-lock.json manually, then retry
echo.
pause
exit /b 1
