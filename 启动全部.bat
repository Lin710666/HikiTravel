@echo off
REM Keep this file ASCII-only.
REM
REM Why: cmd parses a .bat with the console code page (GBK on a Chinese
REM Windows); non-ASCII characters shift the parser offset and break the
REM lines that follow. The UTF-8 code page below is for the CHILD processes
REM (node prints UTF-8), not for this file itself.
chcp 65001 >nul
title HikiTravel - Poster and Itinerary v8.0

cd /d "%~dp0"

REM ------------------------------------------------------------------
REM One file, three modes. It replaces what used to be two files:
REM   (no argument)  deploy, then start + keep-alive
REM   --check        probe the environment, change nothing
REM   --deploy       deploy only, do NOT start services
REM
REM The old "Deploy Only" file was removed because this file already ran
REM the full deploy before starting - so running that one and then this one
REM did the same deploy twice, and it could never do anything extra.
REM ------------------------------------------------------------------
set MODE=%~1

if /I "%MODE%"=="--check" goto checkonly

echo ==================================================
echo   HikiTravel - Poster and Itinerary  v8.0
echo ==================================================
echo.

echo [1/2] Checking deployment...
echo       every step probes first and skips what is already done,
echo       so re-running is safe and a failure never means starting over.
echo.
node deploy.mjs
if errorlevel 1 goto deployfailed

if /I "%MODE%"=="--deploy" (
  echo.
  echo   Deploy only - services were NOT started.
  echo   Run this file with no arguments to start them.
  echo.
  pause
  exit /b 0
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
echo Watchdog exited. To stop the services themselves, run the Stop file.
pause
exit /b 0

:checkonly
echo ==================================================
echo   Environment check - nothing will be changed
echo ==================================================
echo.
node deploy.mjs --check
echo.
pause
exit /b 0

:deployfailed
echo.
echo   Deploy FAILED. Each step above says why. Fix it and run this file again -
echo   steps already done are skipped automatically, no need to start over.
echo.
echo   To inspect the environment without changing anything:
echo       run this same file with  --check
echo.
pause
exit /b 1
