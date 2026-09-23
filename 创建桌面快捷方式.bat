@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion
cd /d "%~dp0"
title 智能文旅辅助系统 - 创建桌面快捷方式

REM ============================================================
REM  双击一次，就在**桌面**和**开始菜单**建好「智能文旅辅助系统」的快捷方式。
REM
REM  为什么发的是这个脚本、而不是一个现成的 .lnk：
REM    快捷方式文件（.lnk）里存的是**绝对路径**。在我这台机器上它指向
REM      C:\Users\11702\Desktop\移动杯项目\HikiTravel-AIRI-1.3\desktop\启动桌面版.bat
REM    换台机器、换个目录就失效了 —— 传上去别人也点不开。
REM    所以这里改成"用脚本现场生成"，路径按你实际放的位置自动算。
REM
REM  想删掉：直接删桌面/开始菜单里的那个图标即可，不用再跑本脚本。
REM ============================================================

echo.
echo   ══════════════════════════════════════════════════════
echo      创建桌面快捷方式
echo   ══════════════════════════════════════════════════════
echo.

set "TARGET=%~dp0desktop\启动桌面版.bat"
if not exist "%TARGET%" (
  echo   [X] 找不到启动脚本：
  echo       %TARGET%
  echo       请确认本脚本放在项目根目录，且 desktop\启动桌面版.bat 还在。
  echo.
  pause
  exit /b 1
)

set "ICON=%~dp0desktop\app.ico"
if not exist "%ICON%" set "ICON=%~dp0desktop\node_modules\electron\dist\electron.exe"

echo   启动目标: %TARGET%
echo   图标来源: %ICON%
echo.

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference='Stop';" ^
  "$ws = New-Object -ComObject WScript.Shell;" ^
  "$target = '%TARGET%';" ^
  "$wd = Split-Path $target -Parent;" ^
  "$icon = '%ICON%';" ^
  "$made = @();" ^
  "foreach ($dir in @([Environment]::GetFolderPath('Desktop'), (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'))) {" ^
  "  if (-not (Test-Path $dir)) { continue }" ^
  "  $lnkPath = Join-Path $dir '智能文旅辅助系统.lnk';" ^
  "  $s = $ws.CreateShortcut($lnkPath);" ^
  "  $s.TargetPath = $target;" ^
  "  $s.WorkingDirectory = $wd;" ^
  "  if (Test-Path $icon) { $s.IconLocation = $icon }" ^
  "  $s.Description = '智能文旅辅助系统 —— Live2D 虚拟向导 + 个性化旅游规划（本机运行）';" ^
  "  $s.Save();" ^
  "  $made += $lnkPath" ^
  "}" ^
  "if ($made.Count -eq 0) { Write-Host '  [X] 没能创建（找不到桌面或开始菜单目录）'; exit 1 }" ^
  "foreach ($m in $made) { Write-Host ('  ✓ 已创建: ' + $m) }"

if errorlevel 1 (
  echo.
  echo   [X] 创建失败。可以手动做：右键 desktop\启动桌面版.bat → 发送到 → 桌面快捷方式
  echo.
  pause
  exit /b 1
)

echo.
echo   好了 —— 桌面上已经出现「智能文旅辅助系统」，双击即用。
echo   （开始菜单里也放了一份）
echo.
echo   首次双击会补装 Electron 依赖、并打包自带后端，需要几分钟；
echo   之后就只要几秒。
echo.
pause
