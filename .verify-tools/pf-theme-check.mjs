#!/usr/bin/env node
/**
 * pf-theme-check.mjs，真浏览器里验"太阳/月亮切换"到底通不通
 *
 * 为什么不能只看代码：主题这件事最容易出现的假通过是，
 *   · 按钮画出来了，但点下去没反应（事件没绑上）
 *   · 点了立刻变，但刷新就弹回原样（没写 localStorage）
 *   · 刷新时闪一下黑底（初始化脚本放到了 body 末尾）
 * 这三条只有真的驱动浏览器点一遍才测得到。
 *
 * 做法：headless Edge + CDP，页面里点按钮、读 data-theme、重新加载，再读一次。
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { requireBrowser } from "../posterforge/paths.mjs";

const BASE = (process.argv.find((a) => /^https?:\/\//.test(a)) || "http://127.0.0.1:8800").replace(/\/$/, "");
const PORT = Number(process.env.CDP_PORT || 9399);
// 默认测海报页；用 --page=/hub.html 测门户页（两个页面共用 pf-theme 这套逻辑）
const PAGE = BASE + ((process.argv.find((a) => a.startsWith("--page=")) || "--page=/").split("=")[1]);
const PROFILE = mkdtempSync(path.join(tmpdir(), "pf-theme-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (name, ok, note = "") => {
  console.log(`  ${ok ? "[OK]" : "[X] "} ${name}${note ? "  " + note : ""}`);
  ok ? pass++ : fail++;
};

const bin = requireBrowser();
const proc = spawn(bin, [
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  "--window-size=1440,1000", "about:blank",
], { stdio: "ignore" });

async function getJson(u) { try { return await (await fetch(u)).json(); } catch { return null; } }

async function main() {
  let ver = null;
  for (let i = 0; i < 60 && !ver; i++) { await sleep(400); ver = await getJson(`http://127.0.0.1:${PORT}/json/version`); }
  if (!ver) throw new Error("浏览器没起来（CDP 端口无响应）");
  const list = await getJson(`http://127.0.0.1:${PORT}/json/list`);
  const target = (list || []).find((t) => t.type === "page");
  if (!target) throw new Error("没有可用的页面 target");

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
    if (r.result && r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.text);
    return r.result && r.result.result ? r.result.result.value : undefined;
  };

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Page.navigate", { url: PAGE });
  await sleep(2500);

  const t0 = await evalJs("document.documentElement.getAttribute('data-theme')");
  check("初始主题已落到 <html> 上", t0 === "dark" || t0 === "light", `data-theme="${t0}"`);

  const hasBtn = await evalJs("!!document.querySelector('#themeToggle, button.iconbtn')");
  check("切换按钮存在", !!hasBtn);

  // 图标：深色时应显示太阳（点了变浅色），浅色时应显示月亮
  const icon = await evalJs(`(function(){
    var s = document.querySelector('.theme-toggle .ic-sun'), m = document.querySelector('.theme-toggle .ic-moon');
    var vis = function(el){ return el && getComputedStyle(el).display !== 'none'; };
    return { sun: vis(s), moon: vis(m) };
  })()`);
  const iconOk = (!icon.sun && !icon.moon) ? true : (t0 === "dark" ? (icon.sun && !icon.moon) : (icon.moon && !icon.sun));
  check("图标与当前主题一致（深色给太阳 / 浅色给月亮）", iconOk, `sun=${icon.sun} moon=${icon.moon}`);

  // 点一下，这一步是整个需求的核心
  await evalJs("document.querySelector('#themeToggle, button.iconbtn').click()");
  await sleep(400);
  const t1 = await evalJs("document.documentElement.getAttribute('data-theme')");
  check("点击后主题真的切换了", t1 !== t0, `${t0} → ${t1}`);

  const stored = await evalJs("localStorage.getItem('pf-theme')");
  check("选择被记进 localStorage", stored === t1, `pf-theme="${stored}"`);

  // 背景色必须跟着变（只看属性不算数，得看浏览器真的算出来的颜色）
  const bg = await evalJs("getComputedStyle(document.body).backgroundColor");
  const nums = (bg.match(/\d+/g) || []).map(Number);
  const isLightBg = nums.length >= 3 && (0.299 * nums[0] + 0.587 * nums[1] + 0.114 * nums[2]) > 150;
  check("页面背景色与主题一致", t1 === "light" ? isLightBg : !isLightBg, `body background = ${bg}`);

  // 重新加载：记忆要生效（这是"点了没用"最常见的翻车点）
  await send("Page.navigate", { url: PAGE });
  await sleep(2200);
  const t2 = await evalJs("document.documentElement.getAttribute('data-theme')");
  check("刷新后保持用户选择", t2 === t1, `刷新后 data-theme="${t2}"`);

  // 再点一次应该回到另一个主题
  await evalJs("document.querySelector('#themeToggle, button.iconbtn').click()");
  await sleep(400);
  const t3 = await evalJs("document.documentElement.getAttribute('data-theme')");
  check("再点一次能切回去", t3 === t0, `${t1} → ${t3}`);

  ws.close();
}

main()
  .catch((e) => { console.log(`  ✗ 验证中断：${e.message}`); fail++; })
  .finally(async () => {
    try { proc.kill(); } catch { }
    await sleep(600);
    try { rmSync(PROFILE, { recursive: true, force: true }); } catch { }
    console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
    process.exit(fail ? 1 : 0);
  });
