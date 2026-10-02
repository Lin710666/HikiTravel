@echo off
REM Keep this file ASCII-only - see the note in the deploy .bat.
chcp 65001 >nul
title HikiTravel - Push to GitHub

cd /d "%~dp0"

REM Run through PowerShell because the token must be entered HIDDEN
REM (cmd's "set /p" would print it onto the screen).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0push-hikitravel.ps1"

if errorlevel 1 pause