@echo off
setlocal enabledelayedexpansion

title Travel Planner - One-Click Deploy

cd /d "%~dp0"

REM ============================================================
REM Force Python to read .pth files as UTF-8.
REM
REM Why: .pth files are decoded with the system locale codec (GBK on a
REM Chinese Windows). If any .pth holds a non-ASCII path - which is exactly
REM what "pip install -e ." writes when the project lives in a folder whose
REM path has non-ASCII characters - the interpreter dies at startup with
REM   UnicodeDecodeError -> Fatal Python error: Failed to import the site module
REM and even "python -c" stops working, so every step below would fail.
REM This script no longer does editable installs, so such a .pth is never
REM created again; this line also rescues machines that already have one.
REM ============================================================
set "PYTHONUTF8=1"

REM Keep this file ASCII-only. cmd reads a .bat with the console code page,
REM and non-ASCII characters shift the parser offset, which eats the "REM"
REM keyword off following lines and makes cmd try to run the leftover text
REM as commands. (That is a real, already-hit failure mode.)
chcp 65001 >nul

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

REM A venv that was moved or renamed is broken: python.exe still exists, but
REM its internal paths point at the old folder, so even "import pip" fails.
REM Such a venv must NEVER be picked as PYEXE - step 1.5 deletes it, and we
REM would otherwise end up trying to run a python.exe that no longer exists.
set "VENV_PY=%~dp0backend\.venv\Scripts\python.exe"
set "VENV_BROKEN="
if exist "%VENV_PY%" (
    "%VENV_PY%" -m pip --version >nul 2>nul
    if errorlevel 1 set "VENV_BROKEN=1"
)
if exist "%VENV_PY%" if not defined VENV_BROKEN (
    set "PYEXE=%VENV_PY%"
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
REM 1.5 Create the project venv.
REM
REM The old script only DETECTED a venv and never created one, so on a
REM machine without uv it fell through to installing with the SYSTEM
REM Python. Two bad consequences:
REM   (1) dependencies landed in the global environment;
REM   (2) that command used -e (editable), which writes the project's
REM       absolute path into site-packages\*.pth - and a non-ASCII path
REM       there kills Python for the whole machine (start.bat included).
REM A venv that was moved or renamed is also broken: python.exe still
REM exists but its internal paths point at the old folder, so "import pip"
REM fails. Those get rebuilt here.
REM ============================================================
set "VPY=%~dp0backend\.venv\Scripts\python.exe"
if defined HAS_UV (
    echo        uv detected - uv sync will create/refresh the venv
) else (
    if defined VENV_BROKEN (
        echo        existing venv is broken [moved or renamed folder?] - rebuilding
        rmdir /s /q "%~dp0backend\.venv"
        REM give Windows a moment to release the directory handles
        ping -n 2 127.0.0.1 >nul
    )
    if exist "%VPY%" (
        echo        venv found: backend\.venv
    ) else (
        echo        creating venv: backend\.venv
        "%PYEXE%" %PYARGS% -m venv "%~dp0backend\.venv"
        if errorlevel 1 (
            echo [ERROR] Failed to create the virtual environment.
            goto :fail
        )
    )
)

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
    REM Install into the venv, with a NON-editable install.
    REM The old line was: pip install -e .
    REM That "-e" is what wrote the project path into site-packages\*.pth and
    REM broke Python machine-wide when the path was non-ASCII. A plain install
    REM puts only the dependencies in the venv and writes no .pth at all.
    "%VPY%" -m pip --version >nul 2>nul
    if errorlevel 1 (
        echo        bootstrapping pip into the venv...
        "%VPY%" -m ensurepip --upgrade
    )
    "%VPY%" -m pip install --upgrade pip --quiet
    "%VPY%" -m pip install . --quiet
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
echo    Deploy done - Starting service...
echo    Open http://localhost:8000 in your browser.
echo    Health check: http://localhost:8000/api/health
echo    Press Ctrl+C to stop.
echo  ==================================================
echo.

set "STATIC_DIR=%~dp0frontend\dist"
set "DB_PATH=%~dp0backend\data\travelplanner.db"

pushd backend
REM Always prefer the venv interpreter: the dependencies live in it.
if exist "%VPY%" (
    "%VPY%" -m uvicorn app.main:app --host 0.0.0.0 --port 8000
) else (
    "%PYEXE%" %PYARGS% -m uvicorn app.main:app --host 0.0.0.0 --port 8000
)
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