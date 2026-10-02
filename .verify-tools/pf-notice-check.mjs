#!/usr/bin/env node
/**
 * pf-notice-check.mjs —— 验"本地没有绘画模型"的提示框在真浏览器里的行为。
 *
 * 这类提示最容易做假的三处，正好也是这个脚本要打的：
 *   1. 该出现时不出现 / 不该出现时乱出现；
 *   2. 右上角的叉点了没用（或者点了还在）；
 *   3. 关掉之后刷新又冒出来 —— 那比不做还烦人。
 *
 * 用法：
 *   node pf-notice-check.mjs --expect=show     # 当前应当弹出来
 *   node pf-notice-check.mjs --expect=hide     # 当前不该弹（本机有模型时）
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { requireBrowser } from "../posterforge/paths.mjs";

const BASE = (process.argv.find((a) => /^https?:\/\//.test(a)) || "http://127.0.0.1:8800").replace(/\/$/, "");
const EXPECT = (process.argv.find((a) => a.startsWith("--expect=")) || "--expect=show").split("=")[1];
const PORT = Number(process.env.CDP_PORT || 9398);
const PROFILE = mkdtempSync(path.join(tmpdir(), "pf-notice-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

const visible = `(function(){
  var b = document.getElementById("modelNotice");
  if (!b) return "missing";
  var cs = getComputedStyle(b);
  return (b.hidden || cs.display === "none") ? "hidden" : "shown";
})()`;

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
  const goto = async () => { await send("Page.navigate", { url: BASE + "/" }); await sleep(2600); };

  await send("Page.enable");
  await send("Runtime.enable");
  await goto();

  const state1 = await evalJs(visible);
  if (EXPECT === "show") {
    check("没有模型时提示框出现了", state1 === "shown", `当前=${state1}`);
    const txt = await evalJs(`(document.getElementById("mnTitle")||{}).textContent || ""`);
    check("标题写的是人话", /没有可用的绘画模型/.test(txt), `"${txt}"`);
    const hasDl = await evalJs(`!!document.getElementById("mnDownload")`);
    const hasX = await evalJs(`!!document.getElementById("mnClose")`);
    check("有下载入口", !!hasDl);
    check("右上角有关闭按钮", !!hasX);
    // 真的点那个叉
    await evalJs(`document.getElementById("mnClose").click()`);
    await sleep(400);
    check("点叉之后真的关掉了", (await evalJs(visible)) === "hidden");
    const remembered = await evalJs(`localStorage.getItem("pf-model-notice-off")`);
    check("关闭被记住了", remembered === "1", `pf-model-notice-off="${remembered}"`);
    // 刷新：不该再冒出来
    await goto();
    check("刷新后不再打扰", (await evalJs(visible)) === "hidden", `刷新后=${await evalJs(visible)}`);
  } else {
    check("本机有模型时不弹", state1 === "hidden", `当前=${state1}`);
    const off = await evalJs(`localStorage.getItem("pf-model-notice-off")`);
    check("“已关闭”标记被清掉了（模型补上后应重新敏感）", off === null, `值=${off}`);
  }

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
