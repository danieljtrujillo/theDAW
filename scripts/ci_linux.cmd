@echo off
rem The pull-request pytest job, run on Linux (WSL) before a PR opens.
rem   scripts\ci_linux.cmd [branch] [-DryRun]
rem The branch (default: the current one) must be committed locally first:
rem the mirror's origin is this Windows repository. See scripts\ci_linux.ps1.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0ci_linux.ps1" %*
exit /b %ERRORLEVEL%
