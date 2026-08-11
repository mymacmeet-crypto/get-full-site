@echo off
REM Launches runner.ps1 - for double-clicking from Explorer, or `runner` from
REM cmd.exe. In PowerShell you can just run .\runner.ps1 directly.

setlocal
set "PS=pwsh"
where pwsh >nul 2>nul || set "PS=powershell"

"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0runner.ps1" %*
set "CODE=%ERRORLEVEL%"

REM Explorer double-click passes no arguments and closes the window the moment
REM the crawl ends, so hold it open in that case. A run with flags is being
REM driven by a shell or a script, which keeps its own window - never pause
REM there or an unattended run would hang forever.
if "%~1"=="" pause

exit /b %CODE%
