@echo off
REM Keep this file ASCII-only.
REM
REM Why: cmd parses a .bat with the console code page (GBK on a Chinese
REM Windows) while this file is UTF-8, so non-ASCII bytes get mis-decoded and
REM some byte pairs contain command separators that silently cut the line.
REM The UTF-8 code page below is for the CHILD processes, not for this file.
chcp 65001 >nul
title HikiTravel - Stop Services

cd /d "%~dp0"

echo ==================================================
echo   Stopping the three services
echo ==================================================
echo.

REM ------------------------------------------------------------------
REM Order matters: the watchdog must die FIRST.
REM
REM Why this file exists at all: the services are started detached, so
REM closing the watchdog window or pressing Ctrl+C does NOT stop them -
REM that is the price of the keep-alive, and it is why you need a stop
REM script that goes by port.
REM
REM But killing the services while the watchdog is still alive does
REM nothing: it notices within 20 seconds and starts them right back up.
REM Observed in posterforge\.work\logs\start.log:
REM     [07:06:47] x 8800 not there -> started pid=27148
REM The old version of this file only killed the services, so the user
REM saw "stopped", refreshed, and found everything still running.
REM ------------------------------------------------------------------
echo [1/3] Stopping the watchdog (start.mjs) ...

REM wmic is gone from Windows 11, so look the process up with PowerShell.
REM
REM Note the shape: PowerShell both finds AND kills, printing its own
REM progress. Do NOT wrap this in a "for /f ... in ('...')" to parse the
REM PID list - a single quote inside that construct ends the command
REM string early and the whole thing silently returns nothing (observed:
REM the block printed neither "stopped" nor "not running", i.e. it looked
REM like a tidy no-op while the watchdog kept restarting everything).
powershell -NoProfile -ExecutionPolicy Bypass -Command "$p = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'start[.]mjs' }; if ($p) { foreach ($x in $p) { Write-Host ('  Stopped watchdog (PID ' + $x.ProcessId + ')'); Stop-Process -Id $x.ProcessId -Force -ErrorAction SilentlyContinue } } else { Write-Host '  The watchdog was not running' }"

echo.
echo [2/3] Stopping services by port ...
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
echo [3/3] Ollama ^(11434^) is left alone - other programs may still be using it.
echo       To stop it yourself:  ollama stop
echo.
pause
