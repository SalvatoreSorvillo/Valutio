@echo off
setlocal
rem Explorer-friendly launcher; %~dp0 keeps paths with spaces quoted correctly.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-valutio-wallet.ps1" %*
if errorlevel 1 (
  echo.
  echo Valutio could not start. Review the error above.
  pause
)
exit /b %errorlevel%
