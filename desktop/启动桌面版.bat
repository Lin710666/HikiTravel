@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion
cd /d "%~dp0"
title 浙里智慧游 - 桌面版

REM ============================================================
REM  双击这个文件 = 打开桌面版（Electron 外壳 + 自带后端）
REM
REM  和「打包桌面版.bat」的区别：
REM    打包桌面版.bat  →  生成一个 .exe 安装包，给别人装（产物 130MB）
REM    这个脚本        →  直接在仓库里跑起来，自己看效果
REM
REM  它会按需把依赖补齐（首次会花几分钟），之后每次启动只要几秒。
REM ============================================================

echo.
echo   ══════════════════════════════════════════════════════
echo      浙里智慧游 · 桌面版
echo   ══════════════════════════════════════════════════════
echo.

set "ROOT=%~dp0.."
set "PYTHONUTF8=1"
set "PYTHONIOENCODING=utf-8"

REM ---------- 1. Node ----------
where node >nul 2>nul
if errorlevel 1 (
  echo   [X] 没找到 Node.js —— 桌面版需要它。
  echo.
  echo       去 https://nodejs.org 装一个 LTS 版本，然后重新双击本文件。
  echo       装完可以先用「检查环境.bat」确认一下。
  echo.
  pause
  exit /b 1
)
for /f "delims=" %%v in ('node -v 2^>nul') do set "NODEVER=%%v"
echo   [1/4] Node.js %NODEVER%  ✓

REM ---------- 2. Electron 依赖 ----------
REM   Electron 的二进制默认从 GitHub 下载，国内经常卡在
REM   "unable to verify the first certificate"，所以走镜像。
set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
set "ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/"

if exist "node_modules\electron\dist\electron.exe" (
  echo   [2/4] Electron 依赖已就绪  ✓
) else (
  echo   [2/4] 首次运行，正在安装 Electron 依赖（约 270MB，走国内镜像）...
  echo         这一步只做一次，请耐心等待；中途断网可以重跑本脚本。
  echo.
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo   [X] 依赖安装失败。常见原因：
    echo       · 网络不通 —— 重试一次即可（走的是 npmmirror 镜像）
    echo       · 没装 Node.js —— 装完再双击本文件
    echo.
    pause
    exit /b 1
  )
  if not exist "node_modules\electron\dist\electron.exe" (
    echo   [X] 装完了但找不到 electron.exe，装得可能不完整。
    echo       删掉 desktop\node_modules 再双击本文件重试。
    pause
    exit /b 1
  )
  echo   [2/4] Electron 依赖装好了  ✓
)

REM ---------- 3. 自带的后端 exe ----------
if exist "dist-backend\hiki-backend\hiki-backend.exe" (
  echo   [3/4] 自带后端已就绪  ✓
) else (
  echo   [3/4] 正在打包自带后端（PyInstaller，约 1-3 分钟）...
  if not exist "%ROOT%\backend\.venv\Scripts\python.exe" (
    echo.
    echo   [X] 找不到后端虚拟环境：backend\.venv
    echo       先双击根目录的「install.bat」把 Python 依赖装好，再回来。
    echo.
    pause
    exit /b 1
  )
  "%ROOT%\backend\.venv\Scripts\python.exe" -X utf8 build-backend.py
  if errorlevel 1 (
    echo.
    echo   [X] 后端打包失败。多半是缺 PyInstaller，试一下：
    echo       backend\.venv\Scripts\python.exe -m pip install pyinstaller
    echo.
    pause
    exit /b 1
  )
  echo   [3/4] 自带后端打好了  ✓
)

REM ---------- 4. 高德 Key ----------
REM   桌面版自己起后端时，.env 不一定在它旁边，所以这里把根目录
REM   backend\.env 里的 Key 读出来、通过环境变量传进去。
REM   没有 Key 也不拦：能开界面，只是生成方案时会提示"地图服务不可用"。
if exist "%ROOT%\backend\.env" (
  for /f "usebackq tokens=1,* delims==" %%a in ("%ROOT%\backend\.env") do (
    set "K=%%a"
    set "V=%%b"
    if /i "!K: =!"=="AMAP_API_KEY" (
      for /f "tokens=* delims= " %%x in ("!V!") do set "AMAP_API_KEY=%%x"
    )
  )
)
if defined AMAP_API_KEY (
  echo   [4/4] 已从 backend\.env 读到高德 Key  ✓
) else (
  echo   [4/4] [注意] 没读到高德 Key —— 界面能开，但生成方案会提示地图服务不可用。
  echo         想生成真实方案：在 backend\.env 里填 AMAP_API_KEY= 你的key（高德开放平台免费申请）
)

echo.
echo   正在启动窗口...（关掉窗口即退出，后端进程会一起收掉）
echo.
call npm start

echo.
echo   桌面版已退出。
pause
