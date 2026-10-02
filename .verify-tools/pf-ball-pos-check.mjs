#!/usr/bin/env node
/**
 * pf-ball-pos-check.mjs —— 验小旅的位置策略：
 *   「本次会话内跨页面保持，刷新就回右下角」
 *
 * 这两件事在浏览器里长得几乎一样，只有 Navigation Timing 能分开：
 *   · Page.navigate → type 是 navigate / back_forward → 应当保持位置
 *   · Page.reload   → type 是 reload                  → 应当回右下角
 * 所以必须用真浏览器分别触发这两条路径，光读代码是看不出来的。
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { requireBrowser } from "../posterforge/paths.mjs";

const BASE = (process.argv.find((a) => /^https?:\/\//.test(a)) || "http://127.0.0.1:8800").replace(/\/$/, "");
const PORT = Number(process.env.CDP_PORT || 9393);
const PROFILE = mkdtempSync(path.join(tmpdir(), "pf-ballpos-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (n, ok, note = "") => {
  console.log(`  ${ok ? "[OK]" : "[X] "} ${n}${note ? "  " + note : ""}`);
  ok ? pass++ : fail++;
};

const proc = spawn(requireBrowser(), [
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  "--window-size=1440,900", "about:blank",
], { stdio: "ignore" });
const getJson = async (u) => { try { return await (await fetch(u)).json(); } catch { return null; } };

// 读球现在在哪 + 会话里存了什么 + 本次导航是什么 type
const PROBE = `(function(){
  var h = document.getElementById("pf-ai-ball-host");
  var b = h && h.shadowRoot ? h.shadowRoot.querySelector(".ball") : null;
  var r = b ? b.getBoundingClientRect() : null;
  var e = performance.getEntriesByType && performance.getEntriesByType("navigation")[0];
  return {
    x: r ? Math.round(r.left) : null,
    y: r ? Math.round(r.top) : null,
    vw: window.innerWidth, vh: window.innerHeight,
    saved: localStorage.getItem("pf-ai-ball-pos"),
    navType: e ? e.type : "?",
  };
})()`;

// 合成一次拖动：从球心拖到指定坐标
const dragTo = (tx, ty) => `(function(){
  var h = document.getElementById("pf-ai-ball-host");
  var b = h.shadowRoot.querySelector(".ball");
  function pe(t,x,y){ return new PointerEvent(t,{pointerId:1,clientX:x,clientY:y,button:0,buttons:1,bubbles:true,cancelable:true}); }
  var r = b.getBoundingClientRect();
  var sx = Math.round(r.left + r.width/2), sy = Math.round(r.top + r.height/2);
  b.dispatchEvent(pe("pointerdown", sx, sy));
  b.dispatchEvent(pe("pointermove", ${tx}, ${ty}));
  b.dispatchEvent(pe("pointerup", ${tx}, ${ty}));
  var r2 = b.getBoundingClientRect();
  return { x: Math.round(r2.left), y: Math.round(r2.top) };
})()`;

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
  const goto = async (p, wait = 2400) => { await send("Page.navigate", { url: BASE + p }); await sleep(wait); };

  await send("Page.enable");
  await send("Runtime.enable");

  // 判断"是不是在右下角"不能要求坐标精确相等：position:fixed 的 right:24px 相对的是
  // **不含滚动条**的布局视口，页面有没有滚动条会让同一个角落差出 15px 左右。
  // 这里只要落在那片的右下区域就算对 —— 而拖过去的位置 (386,266) 离得远，不会误判。
  const isCorner = (s) => s.x > s.vw * 0.6 && s.y > s.vh * 0.6;

  // ---- 1. 在主页拖动，位置应当被写进 sessionStorage ----
  await goto("/");
  const s0 = await evalJs(PROBE);
  check("初始在右下角", s0.x > s0.vw * 0.6 && s0.y > s0.vh * 0.6, `(${s0.x},${s0.y}) 视口 ${s0.vw}×${s0.vh}`);
  const dragged = await evalJs(dragTo(420, 300));
  const s1 = await evalJs(PROBE);
  check("拖动生效", Math.abs(s1.x - dragged.x) <= 1 && s1.x < s0.x - 200, `拖到 (${s1.x},${s1.y})`);
  check("位置写进了 sessionStorage", !!s1.saved, `saved=${s1.saved}`);

  // ---- 2. 跳到别的页面（navigate）→ 应当保持 ----
  await goto("/hub.html");
  const s2 = await evalJs(PROBE);
  check("导航到别的页面后**保持**位置", Math.abs(s2.x - s1.x) <= 2 && Math.abs(s2.y - s1.y) <= 2,
    `主页 (${s1.x},${s1.y}) → 门户 (${s2.x},${s2.y})，navType=${s2.navType}`);

  // ---- 3. 再跳一次（gateway → 行程规划）→ 仍然保持 ----
  await goto("/wenlv/", 4200);
  const s3 = await evalJs(PROBE);
  check("再跳到行程规划仍然保持", Math.abs(s3.x - s2.x) <= 2 && Math.abs(s3.y - s2.y) <= 2,
    `门户 (${s2.x},${s2.y}) → 规划 (${s3.x},${s3.y})`);

  // ---- 4. 刷新当前页（reload）→ 应当回右下角 ----
  await send("Page.reload");
  await sleep(4200);
  const s4 = await evalJs(PROBE);
  check("刷新后回到右下角", isCorner(s4), `刷新后 (${s4.x},${s4.y})，navType=${s4.navType}`);
  check("刷新时清掉了会话里记的位置", !s4.saved, `saved=${s4.saved}`);

  // ---- 5. 刷新之后再导航：没有记录，仍应在右下角 ----
  await goto("/hub.html");
  const s5 = await evalJs(PROBE);
  check("刷新后再导航仍是右下角（记录已清）", isCorner(s5), `(${s5.x},${s5.y})`);

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
