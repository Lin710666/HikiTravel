@echo off
REM Keep this file ASCII-only.
REM
REM Why: cmd parses a .bat with the console code page (GBK on a Chinese
REM Windows) while this file is UTF-8, so non-ASCII bytes get mis-decoded;
REM some byte pairs contain command separators and silently cut the line,
REM making cmd try to run the tail as a program. The UTF-8 code page below
REM is for the CHILD processes, not for this file itself.
REM
REM One file, two modes - it replaces two near-identical stop scripts:
REM   double-click    stop the site service + ComfyUI
REM   pass "all"      the above, plus Ollama
REM
REM IMPORTANT - why this looks up processes by PORT and not by command line:
REM the old version ran
REM     wmic process where "ProcessId=.." get CommandLine | findstr server.mjs
REM and wmic no longer ships with Windows 11. On such a machine that whole
REM lookup silently did nothing: the script still printed "no running service
REM was found" and stopped nothing at all. netstat exists everywhere.
REM
REM setlocal enabledelayedexpansion matters too: FOUND is assigned inside a
REM for loop. Without it the "!FOUND!" test never expands, so the final line
REM would always claim success.
chcp 65001 >nul
setlocal enabledelayedexpansion
title PosterForge - Stop Services

cd /d "%~dp0"

set "ALSO_OLLAMA="
if /I "%~1"=="all" set "ALSO_OLLAMA=1"

echo ==========================================================
echo   PosterForge - stop services
echo ==========================================================
echo.
if defined ALSO_OLLAMA (
  echo   Stopping: site service / ComfyUI / Ollama
) else (
  echo   Stopping: site service / ComfyUI
  echo   Pass "all" to also stop Ollama.
)
echo   Left alone: any other node / python program.
echo.

set FOUND=0

call :killport 8787 "site service, standalone"
call :killport 8800 "site service"
call :killport 8188 "ComfyUI"

if defined ALSO_OLLAMA (
  echo [ollama] Ollama ...
  taskkill /IM ollama.exe /F >nul 2>&1
  if errorlevel 1 (
    echo     was not running
  ) else (
    echo     stopped - but the Ollama tray app will start it again shortly.
    echo     To really keep it down, quit it from the tray, or run: ollama stop
    set FOUND=1
  )
)

echo.
if "!FOUND!"=="0" (
  echo   No running service was found.
) else (
  echo   Done.
)
echo.
pause
exit /b 0

REM ------------------------------------------------------------------
REM kill whatever is listening on %1, described as %2
REM ------------------------------------------------------------------
:killport
set "PORT=%~1"
set "LABEL=%~2"
set "GOT="
for /f "tokens=5" %%I in ('netstat -ano ^| findstr ":%PORT% " ^| findstr LISTENING') do (
  taskkill /F /PID %%I >nul 2>&1
  if not errorlevel 1 (
    echo   stopped %LABEL% on port %PORT%  ^(PID %%I^)
    set "GOT=1"
    set FOUND=1
  )
)
if not defined GOT echo   port %PORT% was not running  ^(%LABEL%^)
exit /b 0
