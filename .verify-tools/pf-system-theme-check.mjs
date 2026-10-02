#!/usr/bin/env node
/**
 * pf-system-theme-check.mjs —— 验"主页跟着电脑设置"这一条。
 *
 * "跟随系统"最容易做假的地方是：它只有**第一次**生效。
 * 因为实现里常常会在挂载时把推导出来的主题写回 localStorage，
 * 于是第二次打开就变成"读到自己上次写的值"，系统怎么改都不跟了。
 * 所以这里要验的是四步，而不是一步：
 *   1. 干净环境 + 系统深色  → 页面深色；
 *   2. 系统改成浅色、重新加载 → 页面浅色（说明没被上一步写死）；
 *   3. 系统再改回深色、**不刷新** → 页面当场跟着变（说明监听了变化，不是只在打开时读一次）；
 *   4. 手动点一次切换之后，系统再怎么变都不该覆盖用户的选择。
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { requireBrowser } from "../posterforge/paths.mjs";

const BASE = (process.argv.find((a) => /^https?:\/\//.test(a)) || "http://127.0.0.1:8800").replace(/\/$/, "");
// 取参数用 indexOf 而不是 split('=')[1]：值里带 '=' 时后者会截断
// （mobile-check 就是这么被坑的：/?nomodel=1 被截成 /?nomodel）。
const PAGE_ARG = process.argv.find((a) => a.startsWith("--page=")) || "--page=/hub.html";
const PAGE = BASE + PAGE_ARG.slice(PAGE_ARG.indexOf("=") + 1);
const PORT = Number(process.env.CDP_PORT || 9395);
const PROFILE = mkdtempSync(path.join(tmpdir(), "pf-systheme-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (n, ok, note = "") => {
  console.log(`  ${ok ? "[OK]" : "[X] "} ${n}${note ? "  " + note : ""}`);
  ok ? pass++ : fail++;
};

const proc = spawn(requireBrowser(), [
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`, "about:blank",
], { stdio: "ignore" });
const getJson = async (u) => { try { return await (await fetch(u)).json(); } catch { return null; } };

async function main() {
  let ver = null;
  for (let i = 0; i < 60 && !ver; i++) { await sleep(400); ver = await getJson(`http://127.0.0.1:${PORT}/json/version`); }
  if (!ver) throw new Error("浏览器没起来");
  const list = await getJson(`http://127.0.0.1:${PORT}/json/list`);
  const target = (list || []).find((t) => t.type === "page");
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
  const themeOf = () => evalJs(`document.documentElement.getAttribute("data-theme") || document.documentElement.dataset.theme || "(无)"`);
  const setSys = (v) => send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: v }] });
  const goto = async (wait = 2600) => { await send("Page.navigate", { url: PAGE }); await sleep(wait); };
  const ls = () => evalJs("JSON.stringify({pf:localStorage.getItem('pf-theme'),tp:localStorage.getItem('tp-theme')})");

  await send("Page.enable");
  await send("Runtime.enable");

  console.log("\n[1] 干净环境（没有任何手动选择）");
  await setSys("dark");
  await goto();
  check("系统深色 → 页面深色", (await themeOf()) === "dark", `实际 ${await themeOf()}`);

  console.log("\n[2] 系统改成浅色后重新加载");
  await setSys("light");
  await goto();
  check("系统浅色 → 页面浅色（说明没被上一步写死）", (await themeOf()) === "light", `实际 ${await themeOf()}`);
  const stored = await ls();
  check("跟随系统时不该往 localStorage 里写值", JSON.parse(stored).pf === null && JSON.parse(stored).tp === null, stored);

  console.log("\n[3] 不刷新，系统主题当场变化");
  await setSys("dark");
  await sleep(900);
  check("系统变深色 → 页面当场跟着变（不用刷新）", (await themeOf()) === "dark", `实际 ${await themeOf()}`);

  console.log("\n[4] 手动选过之后，系统不该再覆盖用户");
  // 三个页面的切换按钮长得不一样（门户是 #themeToggle，行程规划是 React 里的
  // <button aria-label="切换外观">），所以按候选列表挨个试，别写死一个 id。
  const clicked = await (async () => {
    const sels = ['#themeToggle', 'button[aria-label="切换外观"]', '.theme-toggle',
      'button[aria-label*="深浅"]', 'button[title*="外观"]'];
    for (const s of sels) {
      const ok = await evalJs(`(function(){var b=document.querySelector(${JSON.stringify(s)});if(!b)return false;b.click();return true;})()`);
      if (ok) return s;
    }
    return null;
  })();
  check("找到了切换按钮并点了它", !!clicked, clicked ? `选择器 ${clicked}` : "候选都没找到");
  await sleep(500);
  const manual = await themeOf();
  check("手动切换后确实反过来了", manual === "light", `实际 ${manual}`);
  await setSys("light");
  await sleep(700);
  await setSys("dark");
  await sleep(900);
  check("系统反复变化也不覆盖用户选择", (await themeOf()) === manual, `实际 ${await themeOf()}（应为 ${manual}）`);
  check("手动选择被记住了", JSON.parse(await ls()).pf === manual, await ls());

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
