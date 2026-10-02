@echo off
REM Keep this file ASCII-only - see the note in the deploy .bat.
chcp 65001 >nul
title HikiTravel - Stop Services

cd /d "%~dp0"

echo ==================================================
echo   Stopping the three services
echo ==================================================
echo.

REM Why this file exists: the three services are started detached, so closing
REM the watchdog window or pressing Ctrl+C does NOT stop them - that is the
REM price of the keep-alive. To really stop them you have to find the process
REM by its port and kill it.
for %%P in (8800 8001) do (
  set FOUND=
  for /f "tokens=5" %%I in ('netstat -ano ^| findstr ":%%P " ^| findstr LISTENING') do (
    taskkill /F /PID %%I >nul 2>&1
    if not errorlevel 1 (
      echo   Stopped port %%P  ^(PID %%I^)
      set FOUND=1
    )
  )
  if not defined FOUND echo   Port %%P was not running
)

echo.
echo   Ollama ^(11434^) is left alone - other programs may still be using it.
echo   To stop it yourself:  ollama stop
echo.
pause