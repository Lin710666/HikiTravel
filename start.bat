@echo off
setlocal

title Travel Planner - Start

cd /d "%~dp0"

REM ============================================================
REM Locate Python: project venv - uv - py launcher - PATH - common dirs
REM ============================================================
set "PYEXE="
set "PYARGS="
set "HAS_UV="

uv --version >nul 2>nul && set "HAS_UV=1"

if exist "%~dp0backend\.venv\Scripts\python.exe" (
    set "PYEXE=%~dp0backend\.venv\Scripts\python.exe"
    goto :py_ready
)
if defined HAS_UV (
    set "PYEXE=uv"
    set "PYARGS=run python"
    goto :py_ready
)
py -3 --version >nul 2>nul && ( set "PYEXE=py" & set "PYARGS=-3" )
if not defined PYEXE (
    python --version >nul 2>nul && set "PYEXE=python"
)
if not defined PYEXE (
    python3 --version >nul 2>nul && set "PYEXE=python3"
)
if not defined PYEXE (
    for /d %%d in ("%LOCALAPPDATA%\Programs\Python\Python3*") do (
        if exist "%%d\python.exe" if not defined PYEXE set "PYEXE=%%d\python.exe"
    )
)
if not defined PYEXE (
    for /d %%d in ("%ProgramFiles%\Python3*") do (
        if exist "%%d\python.exe" if not defined PYEXE set "PYEXE=%%d\python.exe"
    )
)
if not defined PYEXE (
    for /d %%d in ("%ProgramFiles(x86)%\Python3*") do (
        if exist "%%d\python.exe" if not defined PYEXE set "PYEXE=%%d\python.exe"
    )
)

:py_ready
if not defined PYEXE (
    echo [ERROR] Python not found. Please run install.bat first.
    pause
    exit /b 1
)

if not exist "frontend\dist\index.html" (
    echo [ERROR] Frontend build not found. Please run install.bat first.
    pause
    exit /b 1
)

REM Load backend\.env if present
if exist "backend\.env" (
    for /f "usebackq eol=# tokens=*" %%a in ("backend\.env") do set %%a
)

set "STATIC_DIR=%~dp0frontend\dist"
set "DB_PATH=%~dp0backend\data\travelplanner.db"

echo.
echo Starting service. Open http://localhost:8000  (Ctrl+C to stop)
echo.

pushd backend
"%PYEXE%" %PYARGS% -m uvicorn app.main:app --host 0.0.0.0 --port 8000
popd

pause
