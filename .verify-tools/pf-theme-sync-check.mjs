#!/usr/bin/env node
/**
 * pf-theme-sync-check.mjs —— 验三个页面的深浅色到底有没有联动。
 *
 * 要验的是这句话："主页跟系统，行程规划和海报生成跟主页。"
 * 拆成可测的三步（同一个浏览器 profile，所以 localStorage 是共享的，等同真实用户）：
 *   1. 在门户点一下切换 → 拿到它写进去的值；
 *   2. 跳到海报生成页 → data-theme 应该和门户一致；
 *   3. 跳到行程规划页 → 也应该一致。
 * 反过来再切一次，确认不是"碰巧一开始就是同一个颜色"。
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { requireBrowser } from "../posterforge/paths.mjs";

const BASE = (process.argv.find((a) => /^https?:\/\//.test(a)) || "http://127.0.0.1:8800").replace(/\/$/, "");
const PORT = Number(process.env.CDP_PORT || 9396);
const PROFILE = mkdtempSync(path.join(tmpdir(), "pf-sync-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PAGES = [
  ["门户", "/hub.html", "#themeToggle"],
  ["海报生成", "/", "#themeToggle"],
  ["行程规划", "/wenlv/", null],   // 这一页的按钮由 React 渲染，选择器不固定，只读状态
];

let pass = 0, fail = 0;
const check = (n, ok, note = "") => {
  console.log(`  ${ok ? "[OK]" : "[X] "} ${n}${note ? "  " + note : ""}`);
  ok ? pass++ : fail++;
};

const proc = spawn(requireBrowser(), [
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  "--window-size=1440,1000", "about:blank",
], { stdio: "ignore" });

const getJson = async (u) => { try { return await (await fetch(u)).json(); } catch { return null; } };

async function main() {
  let ver = null;
  for (let i = 0; i < 60 && !ver; i++) { await sleep(400); ver = await getJson(`http://127.0.0.1:${PORT}/json/version`); }
  if (!ver) throw new Error("浏览器没起来");
  const list = await getJson(`http://127.0.0.1:${PORT}/json/list`);
  const target = (list || []).find((t) => t.type === "page");
  if (!target) throw new Error("没有页面 target");

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params = {}) => new Promise((res) => {
    const myId = ++id;
    pending.set(myId, res);
    ws.send(JSON.stringify({ id: myId, method, params }));
  });
  const evalJs = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  const goto = async (p, wait = 2600) => { await send("Page.navigate", { url: BASE + p }); await sleep(wait); };
  const themeOf = () => evalJs(`document.documentElement.getAttribute("data-theme") || document.documentElement.dataset.theme || "(无)"`);

  await send("Page.enable");
  await send("Runtime.enable");

  // ---- 第一轮：在门户手动切一次 ----
  console.log("\n[1] 在门户点一下切换按钮，然后看另外两个页面跟不跟");
  await goto("/hub.html");
  const before = await themeOf();
  await evalJs(`document.getElementById("themeToggle").click()`);
  await sleep(500);
  const hubAfter = await themeOf();
  const stored = await evalJs(`localStorage.getItem("pf-theme")`);
  check("门户切换生效且写进公共键 pf-theme", hubAfter !== before && stored === hubAfter,
    `${before} → ${hubAfter}（pf-theme=${stored}）`);

  // ---- 另外两个页面 ----
  for (const [name, p] of PAGES) {
    if (p === "/hub.html") continue;
    await goto(p, p === "/wenlv/" ? 4200 : 2600);
    const t = await themeOf();
    check(`${name} 跟随门户（${hubAfter}）`, t === hubAfter, `实际 ${t}`);
  }

  // ---- 第二轮：反向再切一次，确认不是碰巧 ----
  console.log("\n[2] 再切一次（换成另一个颜色），重复验证");
  await goto("/");
  await evalJs(`document.getElementById("themeToggle").click()`);
  await sleep(500);
  const posterAfter = await themeOf();
  check("海报页切换生效", posterAfter !== hubAfter, `${hubAfter} → ${posterAfter}`);
  await goto("/hub.html");
  check("门户反向跟随海报页", (await themeOf()) === posterAfter, `实际 ${await themeOf()}`);
  await goto("/wenlv/", 4200);
  check("行程规划再次跟随", (await themeOf()) === posterAfter, `实际 ${await themeOf()}`);

  ws.close();
}

main()
  .catch((e) => { console.log(`  ✗ 中断：${e.message}`); fail++; })
  .finally(async () => {
    try { proc.kill(); } catch { }
    await sleep(600);
    try { rmSync(PROFILE, { recursive: true, force: true }); } catch { }
    console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
    process.exit(fail ? 1 : 0);
  });
