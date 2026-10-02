@echo off
chcp 65001 >nul
setlocal

echo ==========================================================
echo   PosterForge - 宣传海报与打卡模板生成
echo ==========================================================
echo.
echo   零运行时依赖，只用 Node 内置模块。
echo   需要本机有 Node 18+ 和 Python 3.10+（带 Pillow）。
echo.

cd /d "%~dp0"

:: ---- 检查 Node ----
where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 找不到 node。请先安装 Node.js 18+：https://nodejs.org/
  echo.
  pause
  exit /b 1
)
for /f "tokens=*" %%v in ('node -v') do set NODEVER=%%v
echo   Node      %NODEVER%

:: ---- 检查 Python 与 Pillow ----
:: 解释器按优先级找：项目内 .venv → PATH 上的 python。
:: 原来第一行写死了 E:\devenv\Scripts\python.exe（别人机器上的路径），
:: 换台机器这一行永远不成立，等于"写死的路径从来没生效过"。
set PYEXE=
if exist "%~dp0.venv\Scripts\python.exe" set PYEXE=%~dp0.venv\Scripts\python.exe
if "%PYEXE%"=="" (
  where python >nul 2>nul
  if errorlevel 1 (
    echo [错误] 找不到 python。请安装 Python 3.10+ 并勾选 Add to PATH。
    echo.
    pause
    exit /b 1
  )
  set PYEXE=python
)
echo   Python    %PYEXE%

"%PYEXE%" -c "import PIL" >nul 2>nul
if errorlevel 1 (
  echo [错误] Python 缺少 Pillow。请执行：
  echo          "%PYEXE%" -m pip install pillow
  echo.
  pause
  exit /b 1
)
echo   Pillow    已安装

:: ---- 检查渲染器 ----
:: 引擎目录改名过（poster-forge → renderer），两个名字都认；
:: 原来只写死 ..\poster-forge\，改名之后这个检查必然失败、直接拦住启动。
if not exist "..\renderer\render.py" if not exist "..\poster-forge\render.py" (
  echo [错误] 找不到渲染引擎 render.py
  echo         期望位置：..\renderer\render.py（与本目录同级）
  echo.
  pause
  exit /b 1
)
echo   渲染器    已找到

:: ---- 启动 ----
set PF_PYTHON=%PYEXE%
echo.
echo ----------------------------------------------------------
echo   启动后浏览器访问： http://127.0.0.1:8787
echo   自检接口：         http://127.0.0.1:8787/api/health
echo   停止：             Ctrl + C
echo ----------------------------------------------------------
echo.

node server.mjs --port 8787

echo.
echo 服务已停止。
pause
