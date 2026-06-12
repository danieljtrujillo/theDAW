@echo off
rem ===========================================================================
rem  theDAW Setup. Double-click this ONCE to install what theDAW needs.
rem  It checks your PC, shows what it will install, asks first, then installs
rem  uv / Node / FFmpeg / Git for you. No typing required. After it finishes,
rem  double-click theDAW.bat to run the app.
rem ===========================================================================
title theDAW Setup
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install\setup.ps1" %*
echo.
pause
