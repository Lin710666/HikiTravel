# push-hikitravel.ps1 —— 把本地改动推到 HikiTravel 仓库的两个分支
#
# 为什么单独写这个：
#   1. 推送要 Personal Access Token。贴在对话里 = 暴露；写进 git remote = 留在
#      .git/config 里，容易随目录一起被打包带走。这里让 Token 只在内存里活一次。
#   2. main-repair 与 HikiTravel-PosterForge-1.1 都有既有历史（10 个分支的仓库），
#      不能被强推覆盖。所以先**基于远端 tip 构造提交** —— 推上去必然是
#      fast-forward，既保留远端历史，也不需要在公开仓库上强推。
#
# 用法： 右键本文件 → 使用 PowerShell 运行
#    或  pwsh -File push-hikitravel.ps1

$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

function Say($m, $c = 'Gray') { Write-Host $m -ForegroundColor $c }

Say ""
Say "==================================================" Cyan
Say "  推送到 HikiTravel 的两个分支" Cyan
Say "==================================================" Cyan
Say ""

$repo       = 'Lin710666/HikiTravel'
$remoteName = 'hikitravel-origin'

# ---------------------------------------------------------------- 前置检查
$branch = (git rev-parse --abbrev-ref HEAD).Trim()
Say "  当前分支  $branch"
Say "  当前提交  $(git log --oneline -1)"

$dirty = git status --porcelain
if ($dirty) {
  Say ""
  Say "  注意：工作区有未提交的改动，下面推的是**已提交**的内容，不含这些：" Yellow
  $dirty | Select-Object -First 10 | ForEach-Object { Say "    $_" }
  $ans = Read-Host "  继续吗？输入 yes 继续"
  if ($ans -ne 'yes') { Say "  已取消。" Gray; exit 0 }
}

# ---------------------------------------------------------------- 同步远端
Say ""
Say "  拉取远端两个分支的最新状态…" Gray
if (-not (git remote | Where-Object { $_ -eq $remoteName })) {
  git remote add $remoteName "https://github.com/$repo.git"
}
git fetch $remoteName main-repair HikiTravel-PosterForge-1.1 --quiet
if ($LASTEXITCODE -ne 0) { Say "  拉取失败（网络？）。取消。" Red; exit 1 }
Say "  已同步。" Gray

# ---------------------------------------------------------------- 构造提交
# 关键：parent 用**远端 tip**，tree 用本地内容。这样远端 tip 是新提交的祖先，
# 推送是 fast-forward，不会丢远端历史，也不会被 GitHub 拒绝。
Say ""
Say "  构造提交中…" Gray

# 分支一：main-repair ← 本地 hikitravel/ 的内容作为仓库根
$tRepair = (git rev-parse 'HEAD:hikitravel').Trim()
$pRepair = (git rev-parse "$remoteName/main-repair").Trim()
$cRepair = (git commit-tree $tRepair -p $pRepair `
            -m '同步旅行规划改动：主题跟随系统、三栏可拖动、依赖与启动脚本更新').Trim()

# 分支二：HikiTravel-PosterForge-1.1 ← 整个项目
$tPF = (git rev-parse 'HEAD^{tree}').Trim()
$pPF = (git rev-parse "$remoteName/HikiTravel-PosterForge-1.1").Trim()
$cPF = (git commit-tree $tPF -p $pPF `
        -m 'HikiTravel 集成 PosterForge：完整项目包（海报生成 + 渲染器 + 旅行规划）').Trim()

$nRepair = (git ls-tree -r --name-only $cRepair | Measure-Object -Line).Lines
$nPF     = (git ls-tree -r --name-only $cPF | Measure-Object -Line).Lines

Say ""
Say "  将要推送：" Cyan
Say "    main-repair                ← 本地 hikitravel/  ($nRepair 个文件)"
Say "    HikiTravel-PosterForge-1.1 ← 整个项目         ($nPF 个文件)"
Say "  两者都是 fast-forward，不会覆盖远端既有历史。" Gray

# ---------------------------------------------------------------- Token
Say ""
Say "  需要一个有 repo 权限的 Token：https://github.com/settings/tokens" Cyan
Say "  （输入时不显示字符，这是正常的）" Gray
$secure = Read-Host "  粘贴 Token" -AsSecureString
$token  = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
  [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
if ([string]::IsNullOrWhiteSpace($token)) { Say "  没输入 Token，取消。" Red; exit 1 }
if ($token.Length -lt 20) { Say "  Token 太短，不像是有效的，取消。" Red; exit 1 }

# ---------------------------------------------------------------- 推送
# Token 只放在**这一次**的 URL 里，用完立刻把 remote 恢复成不带凭据的形式，
# .git/config 里始终不会有明文 Token。
$clean     = "https://github.com/$repo.git"
$withToken = "https://x-access-token:$token@github.com/$repo.git"
$okRepair  = $false
$okPF      = $false

Say ""
try {
  git remote set-url $remoteName $withToken

  Say "  推送 main-repair…" Gray
  git push $remoteName "${cRepair}:refs/heads/main-repair"
  if ($LASTEXITCODE -eq 0) { $okRepair = $true }

  Say "  推送 HikiTravel-PosterForge-1.1…" Gray
  git push $remoteName "${cPF}:refs/heads/HikiTravel-PosterForge-1.1"
  if ($LASTEXITCODE -eq 0) { $okPF = $true }
} catch {
  Say "  推送出错：$($_.Exception.Message)" Red
} finally {
  git remote set-url $remoteName $clean
  $token  = $null
  $secure = $null
  [GC]::Collect()
}

Say ""
if ($okRepair) { Say "  [OK] main-repair                https://github.com/$repo/tree/main-repair" Green }
else           { Say "  [FAIL] main-repair 没推上去" Red }
if ($okPF)     { Say "  [OK] HikiTravel-PosterForge-1.1 https://github.com/$repo/tree/HikiTravel-PosterForge-1.1" Green }
else           { Say "  [FAIL] HikiTravel-PosterForge-1.1 没推上去" Red }

Say ""
if (-not ($okRepair -and $okPF)) {
  Say "  常见原因：" Yellow
  Say "    · Token 没有 repo（写）权限，或已过期" Yellow
  Say "    · 网络（本机若有系统代理，git 可能需要 NO_PROXY）" Yellow
  Say "    · 远端分支被人改动过，fast-forward 不再成立 —— 重跑本脚本会自动重新构造" Yellow
} else {
  Say "  remote 已恢复成不含凭据的形式，Token 没有留在 .git/config 里。" Gray
}
Say ""
Read-Host "  按回车关闭"
