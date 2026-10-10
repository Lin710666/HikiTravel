/**
 * 后台拉起一个服务：父进程退出后它必须还活着，而且**绝不能弹出任何窗口**。
 *
 * ── 为什么不能直接用 detached ──────────────────────────────────────────
 * 老写法是 `spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true })`，
 * 看着该藏的藏了，但在 Windows 上：
 *
 *   1. `detached: true` 对应 CreateProcess 的 DETACHED_PROCESS，而微软文档写明
 *      **CREATE_NO_WINDOW 在指定 DETACHED_PROCESS 时会被忽略**，
 *      也就是说这里的 `windowsHide: true` 根本不生效。
 *   2. 子进程于是自己带了一个控制台。这台机器把默认终端设成了 Windows Terminal，
 *      于是每起一个服务就弹一个终端窗口。实测：按老写法连起 3 次 → 冒出 8 个新窗口。
 *      启动路径上共有 5 处这种写法，watchdog 每次重启服务还会再弹一个
 *      （日志里累计重启过 115 次），用户看到的就是"打开启动全部.bat 跳出来一堆窗口"。
 *
 * ── 为什么也不能直接去掉 detached ─────────────────────────────────────
 * 实测：`detached: false` + `windowsHide: true` 确实一个窗口都不弹，
 * 但**父进程一退出子进程就跟着死**（Node 文档也写明：Windows 上要不随父进程退出就得 detached）。
 * 服务活不下来，这条路走不通。
 *
 * ── 所以借 PowerShell 的 Start-Process ────────────────────────────────
 * `-WindowStyle Hidden` 创建出来的进程是独立的（实测父进程退出后它还在），
 * 窗口也是隐藏的（实测 0 个新窗口）。两头都占。
 * 包装用的 powershell 自己是普通 spawn + windowsHide（非 detached，所以不弹窗），
 * 它把服务拉起来之后就退出，用 spawnSync 同步等它，顺便把子进程 pid 带回来。
 */
import { spawn, spawnSync } from "node:child_process";

const IS_WIN = process.platform === "win32";

/** PowerShell 单引号字符串转义：内部的 ' 要写成 '' */
const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";

/**
 * @param {string} cmd 可执行文件（可以是裸名字，靠 PATH 找）
 * @param {string[]} args 参数
 * @param {{cwd?: string, env?: Record<string,string>}} opts
 * @returns {number|null} 子进程 pid；拿不到就返回 null
 */
export function spawnHidden(cmd, args, opts = {}) {
  const { cwd, env } = opts;

  if (!IS_WIN) {
    const p = spawn(cmd, args, { cwd, detached: true, stdio: "ignore", env: env ? { ...process.env, ...env } : process.env });
    p.unref();
    return p.pid ?? null;
  }

  // 环境变量要在同一个 PowerShell 会话里先设好，Start-Process 起的子进程才会继承
  const envLines = Object.entries(env || {})
    .map(([k, v]) => `$env:${k} = ${q(v)};`)
    .join(" ");
  const argList = args.length ? `-ArgumentList @(${args.map(q).join(", ")})` : "";
  const script =
    `${envLines} ` +
    `$p = Start-Process -FilePath ${q(cmd)} ${argList} ` +
    (cwd ? `-WorkingDirectory ${q(cwd)} ` : "") +
    `-WindowStyle Hidden -PassThru; ` +
    `Write-Output $p.Id`;

  const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,   // 包装进程本身：非 detached，所以这一条是生效的
    timeout: 20000,
  });

  const pid = Number(String(r.stdout || "").trim().split(/\s+/).pop());
  if (Number.isFinite(pid) && pid > 0) return pid;

  // PowerShell 这条路失败时不能把服务弄丢：退回老写法。
  // 代价是可能弹一个窗口，但"服务起不来"比"弹个窗口"严重得多。
  console.error(`[spawnHidden] 用 Start-Process 拉起 ${cmd} 失败，退回 detached：`
    + String(r.stderr || r.error?.message || "").trim().slice(0, 200));
  const p = spawn(cmd, args, {
    cwd,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: env ? { ...process.env, ...env } : process.env,
  });
  p.unref();
  return p.pid ?? null;
}
