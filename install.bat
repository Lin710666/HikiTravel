@echo off
setlocal enabledelayedexpansion

title Travel Planner - One-Click Deploy

cd /d "%~dp0"

echo.
echo  ==================================================
echo    Travel Planner - One-Click Deploy
echo  ==================================================
echo.

REM ============================================================
REM 1. Locate Python (for running) and uv (for installing)
REM    order: project venv - uv - py launcher - PATH - common dirs
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
    echo [ERROR] Python 3.10+ was not found.
    echo.
    set "ANS="
    set /p "ANS=Try to auto-install Python 3.12 via winget? [Y/N] "
    if /i "!ANS!"=="Y" (
        where winget >nul 2>nul
        if errorlevel 1 (
            echo [ERROR] winget not found. Install Python manually:
            echo         https://www.python.org/downloads/
            echo         then tick "Add python.exe to PATH" and re-run.
            goto :fail
        )
        echo Installing Python 3.12 via winget [user scope]...
        winget install -e --id Python.Python.3.12 --scope user --silent --accept-source-agreements --accept-package-agreements
        echo.
        echo [INFO] After installation, please re-run this script.
        goto :fail
    )
    echo [ERROR] Python is required. Download: https://www.python.org/downloads/
    goto :fail
)
echo [1/5] Python found

REM ============================================================
REM 2. Locate npm
REM ============================================================
set "NPMCMD="
for /f "delims=" %%i in ('where npm 2^>nul') do if not defined NPMCMD set "NPMCMD=%%i"
if not defined NPMCMD if exist "%ProgramFiles%\nodejs\npm.cmd" set "NPMCMD=%ProgramFiles%\nodejs\npm.cmd"
if not defined NPMCMD if exist "%ProgramFiles(x86)%\nodejs\npm.cmd" set "NPMCMD=%ProgramFiles(x86)%\nodejs\npm.cmd"
if not defined NPMCMD if exist "%LOCALAPPDATA%\Programs\nodejs\npm.cmd" set "NPMCMD=%LOCALAPPDATA%\Programs\nodejs\npm.cmd"

if not defined NPMCMD (
    echo [ERROR] Node.js / npm was not found.
    echo.
    set "ANS="
    set /p "ANS=Try to auto-install Node.js LTS via winget? [Y/N] "
    if /i "!ANS!"=="Y" (
        where winget >nul 2>nul
        if errorlevel 1 (
            echo [ERROR] winget not found. Install Node.js LTS manually:
            echo         https://nodejs.org/  then re-run.
            goto :fail
        )
        echo Installing Node.js LTS via winget...
        winget install -e --id OpenJS.NodeJS.LTS --scope user --silent --accept-source-agreements --accept-package-agreements
        echo.
        echo [INFO] After installation, please re-run this script.
        goto :fail
    )
    echo [ERROR] Node.js is required. Download: https://nodejs.org/
    goto :fail
)
echo [2/5] npm found

REM ============================================================
REM 3. Write AMap API key (first run only)
REM ============================================================
if not exist "backend\.env" (
    echo.
    echo [3/5] Writing built-in AMap API key...
    (
        echo # AMap Web Service API key
        echo AMAP_API_KEY=e15977855225aaaedebd91c466a3c39e
        echo.
        echo # Ollama local inference, required, no rule-engine fallback
        echo OLLAMA_BASE_URL=http://localhost:11434
        echo OLLAMA_MODEL=qwen2.5:7b
        echo OLLAMA_EMBED_MODEL=nomic-embed-text
        echo # Local 7B on CPU needs 1-3 minutes per plan, keep the timeout large
        echo OLLAMA_TIMEOUT=180
        echo # Keep the model resident to avoid reload between calls
        echo OLLAMA_KEEP_ALIVE=30m
        echo # Optional smaller model for plan review, leave empty to use OLLAMA_MODEL
        echo OLLAMA_CHECK_MODEL=
        echo # Max feedback-driven regenerations after plan review, 0 disables it
        echo PLAN_MAX_REGENERATE=1
    ) > "backend\.env"
    echo Created backend\.env
) else (
    echo [3/5] backend\.env exists, skipped
)

for /f "usebackq eol=# tokens=*" %%a in ("backend\.env") do set %%a
echo [4/5] Environment loaded

REM ============================================================
REM 4. Install dependencies and build
REM ============================================================
echo.
echo [5/5] Installing dependencies and building (first run: 1-2 min)...

if defined HAS_UV (
    pushd backend
    uv sync
    if errorlevel 1 (
        popd
        echo [ERROR] Backend dependencies install failed [uv sync].
        goto :fail
    )
    popd
) else (
    pushd backend
    "%PYEXE%" %PYARGS% -m pip install -e . --quiet
    if errorlevel 1 (
        popd
        echo [ERROR] Backend dependencies install failed [pip].
        goto :fail
    )
    popd
)

pushd frontend
call "%NPMCMD%" install
if errorlevel 1 (
    popd
    echo [ERROR] Frontend dependencies install failed.
    goto :fail
)
call "%NPMCMD%" run build
if errorlevel 1 (
    popd
    echo [ERROR] Frontend build failed. See messages above.
    goto :fail
)
popd

echo.
echo  ==================================================
echo    Deploy done! Starting service...
echo    Open http://localhost:8000 in your browser.
echo    Health check: http://localhost:8000/api/health
echo    Press Ctrl+C to stop.
echo  ==================================================
echo.

set "STATIC_DIR=%~dp0frontend\dist"
set "DB_PATH=%~dp0backend\data\travelplanner.db"

pushd backend
"%PYEXE%" %PYARGS% -m uvicorn app.main:app --host 0.0.0.0 --port 8000
popd

echo.
echo Service stopped.
pause
exit /b 0

:fail
echo.
echo Deploy incomplete. Fix the issue above and re-run this script.
pause
exit /b 1
