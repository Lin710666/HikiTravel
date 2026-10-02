#!/usr/bin/env pwsh
<#
  pf-regression.ps1 —— PosterForge 全量回归。

  为什么要有这个：验证脚本已经有七八个了，各管一块（主题、联动、移动端、提示框、
  出图、压测）。改一处东西之后要手工挨个跑、还得记住先跑哪个 —— 迟早会漏。
  这里把它们串成一条线，一次跑完，最后给一张 PASS/FAIL 清单。

  前置：站点在 8800 上跑着（pwsh -File pf-regression.ps1 不会自己起服务）。
  用法：pwsh -File pf-regression.ps1
#>
$ErrorActionPreference = "Continue"
Set-Location (Split-Path -Parent $MyInvocation.MyCommand.Path)

$report = @()
function Section($n) { Write-Host "`n########## $n ##########" -ForegroundColor Cyan }
function Note($label) {
  $ok = ($LASTEXITCODE -eq 0)
  if (-not $ok) { $script:failed++ }
  $script:report += ("{0,-46} {1}" -f $label, $(if ($ok) { 'PASS' } else { 'FAIL' }))
}
$failed = 0

Section "0/9 服务体检"
$h = curl.exe -s --max-time 10 http://127.0.0.1:8800/api/health | ConvertFrom-Json
"health ok=$($h.ok)  渲染器=$($h.forgeFound)  AI出图=$($h.aigenReady)  模型=$($h.models.selected.name)"
$m = curl.exe -s --max-time 10 http://127.0.0.1:8800/api/models | ConvertFrom-Json
"模型检索：可用 $($m.usable) 个；ComfyUI up=$($m.comfy.up)"
$report += ("{0,-46} {1}" -f "0 服务体检", $(if ($h.ok) { 'PASS' } else { 'FAIL' }))
if (-not $h.ok) { $failed++ }

Section "1/9 功能冒烟 + 全量压测（只读并发 / 文案 / 真出图）"
node pf-stress.mjs --full 2>&1 | Select-String -Pattern '✓|✗|smoke |read-mix |compose |render |全部通过|存在失败|汇总' | ForEach-Object { $_.Line }
Note "1 冒烟 + 压测"

Section "2/9 主题切换 · 海报生成页"
node pf-theme-check.mjs 2>&1 | Select-String -Pattern '\[OK\]|\[X\]|结果' | ForEach-Object { $_.Line }
Note "2 主题切换（海报页）"

Section "3/9 主题切换 · 门户"
node pf-theme-check.mjs --page=/hub.html 2>&1 | Select-String -Pattern '\[OK\]|\[X\]|结果' | ForEach-Object { $_.Line }
Note "3 主题切换（门户）"

Section "4/9 三页面主题联动"
node pf-theme-sync-check.mjs 2>&1 | Select-String -Pattern '\[OK\]|\[X\]|结果' | ForEach-Object { $_.Line }
Note "4 三页面联动"

Section "5/9 跟随系统（门户 / 海报 / 行程）"
foreach ($p in @('/hub.html', '/', '/wenlv/')) {
  Write-Host "  --- $p ---"
  node pf-system-theme-check.mjs --page=$p 2>&1 | Select-String -Pattern '\[OK\]|\[X\]|结果' | ForEach-Object { $_.Line }
}
Note "5 跟随系统"

Section "6/9 移动端（海报页 / 门户）"
foreach ($pg in @('', '--page=/hub.html')) {
  Write-Host "  --- $(if ($pg) { '门户' } else { '海报页' }) ---"
  node pf-mobile-check.mjs $pg 2>&1 | Select-String -Pattern '汇总|✗' | ForEach-Object { $_.Line }
}
Note "6 移动端"

Section "7/9 模型提示框（本机有模型时不该弹）"
node pf-notice-check.mjs --expect=hide 2>&1 | Select-String -Pattern '\[OK\]|\[X\]|结果' | ForEach-Object { $_.Line }
Note "7 模型提示框"

Section "8/9 端到端出图（AI 底图 + 排版成品）"
$t0 = Get-Date
$a = curl.exe -s --max-time 240 -X POST -H "content-type: application/json" -d '{"prompt":"autumn mountains reflected in a calm lake, warm light, cinematic, no text"}' http://127.0.0.1:8800/api/aigen/background | ConvertFrom-Json
"AI 底图  ok=$($a.ok)  $([math]::Round($a.elapsedMs/1000,1))s  engine=$($a.engine)"
$body = @{ brief = '莫干山民宿冬季温泉套餐，含双早，人均 458'; photos = @(); facts = @{}; mode = 'poster'; render = $true } | ConvertTo-Json -Depth 6
$b = Invoke-RestMethod -Uri 'http://127.0.0.1:8800/api/compose' -Method Post -Body $body -ContentType 'application/json' -TimeoutSec 300
"成品海报 ok=$($b.ok)  图=$($b.url)  模型写文案=$(if ($b.modelCopy.reason) { '是' } else { '否' })"
$report += ("{0,-46} {1}" -f "8 端到端出图", $(if ($a.ok -and $b.ok) { 'PASS' } else { 'FAIL' }))
if (-not ($a.ok -and $b.ok)) { $failed++ }

Section "汇总"
$report | ForEach-Object { Write-Host $_ }
Write-Host ""
if ($failed -eq 0) { Write-Host "全部通过 —— 没有回归。" -ForegroundColor Green }
else { Write-Host "$failed 项失败，看上面的 ✗ 和 FAIL。" -ForegroundColor Yellow }
