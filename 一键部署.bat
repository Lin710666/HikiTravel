@echo off
REM Keep this file ASCII-only. cmd parses a .bat with the console code page
REM (GBK on a Chinese Windows); non-ASCII characters shift the parser offset
REM and break the lines that follow. The UTF-8 code page below is for the
REM CHILD processes (node prints UTF-8), not for this file itself.
chcp 65001 >nul
title HikiTravel v8.0 - Deploy Only

cd /d "%~dp0"

echo ==================================================
echo   DEPLOY ONLY - no code changes: deps + dirs + config
echo ==================================================
echo.
echo   How this differs from "Start All":
echo     This file    deploy only, does NOT start services
echo     Start All    deploy + start + keep-alive, in one go
echo.
echo   Every step probes first and skips what is already done,
echo   so re-running is safe and a failure never means starting over.
echo.

node deploy.mjs
if errorlevel 1 (
  echo.
  echo   Deploy FAILED. Each step above says why and how to fix it.
  echo   To inspect the environment without changing anything:
  echo       node deploy.mjs --check
  echo.
  pause
  exit /b 1
)

echo.
echo   Next: double-click "Start All", or run:  node start.mjs
echo.
pause