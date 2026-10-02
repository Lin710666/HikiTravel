@echo off
REM Keep this file ASCII-only - see the note in the deploy .bat.
chcp 65001 >nul
title HikiTravel - Poster ^& Itinerary v8.0

cd /d "%~dp0"

echo ==================================================
echo   HikiTravel - Poster and Itinerary  v8.0
echo ==================================================
echo.

REM Deploy first, then start. The user should not have to remember whether
REM dependencies were installed. deploy.mjs probes each step, so re-running
REM is safe and fast.
echo [1/2] Checking deployment...
node deploy.mjs
if errorlevel 1 (
  echo.
  echo   Deploy FAILED. Each step above says why. Fix it and run this file again
  echo   steps already done are skipped automatically - no need to start over.
  echo.
  pause
  exit /b 1
)

echo.
echo [2/2] Starting services...
echo.
echo   Portal        http://127.0.0.1:8800/hub.html
echo   Poster        http://127.0.0.1:8800/
echo   Trip planner  http://127.0.0.1:8800/wenlv/
echo.
echo   The three services can exit on their own - observed: they receive Ctrl+C,
echo   it is not a crash - so this watchdog checks every 20 seconds and
echo   restarts whichever one stopped.
echo   Press Ctrl+C to stop the watchdog; running services are left alone.
echo.

start "" http://127.0.0.1:8800/hub.html
node start.mjs

echo.
echo Watchdog exited.
pause