#!/usr/bin/env node
/**
 * pf-ball-multitab-check.mjs —— 验小旅的位置在**多标签页之间**是不是一致的。
 *
 * 为什么必须开两个真标签页：主人的原始现象就是跨标签页的 ——
 * 「主页挪到中间 → 另一个标签页刷新 → 回主页，球又去中间了」。
 * 根因是 sessionStorage 每个标签页各存一份：没刷新过的那个标签页始终记着旧位置。
 * 换成 localStorage（全站唯一）+ storage 事件（通知其它标签页）才修得掉。
 * 而 storage 事件**是浏览器派发的，脚本伪造不了** —— 所以只能真开两个页面来验。
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { requireBrowser } from "../posterforge/paths.mjs";

const BASE = (process.argv.find((a) => /^https?:\/\//.test(a)) || "http://127.0.0.1:8800").replace(/\/$/, "");
const PORT = Number(process.env.CDP_PORT || 9392);
const PROFILE = mkdtempSync(path.join(tmpdir(), "pf-multitab-"));
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

const BALL = `(function(){
  var h = document.getElementById("pf-ai-ball-host");
  var b = h && h.shadowRoot ? h.shadowRoot.querySelector(".ball") : null;
  var r = b ? b.getBoundingClientRect() : null;
  return { x: r ? Math.round(r.left) : null, y: r ? Math.round(r.top) : null,
           vw: window.innerWidth, vh: window.innerHeight,
           saved: localStorage.getItem("pf-ai-ball-pos") };
})()`;

const DRAG = `(function(){
  var h = document.getElementById("pf-ai-ball-host");
  var b = h.shadowRoot.querySelector(".ball");
  function pe(t,x,y){ return new PointerEvent(t,{pointerId:1,clientX:x,clientY:y,button:0,buttons:1,bubbles:true,cancelable:true}); }
  var r = b.getBoundingClientRect();
  var sx = Math.round(r.left + r.width/2), sy = Math.round(r.top + r.height/2);
  b.dispatchEvent(pe("pointerdown", sx, sy));
  b.dispatchEvent(pe("pointermove", 400, 260));
  b.dispatchEvent(pe("pointerup", 400, 260));
  var r2 = b.getBoundingClientRect();
  return { x: Math.round(r2.left), y: Math.round(r2.top) };
})()`;

const isCorner = (s) => s.x !== null && s.x > s.vw * 0.6 && s.y > s.vh * 0.6;

async function main() {
  let ver = null;
  for (let i = 0; i < 60 && !ver; i++) { await sleep(400); ver = await getJson(`http://127.0.0.1:${PORT}/json/version`); }
  if (!ver) throw new Error("浏览器没起来");

  // 连 browser 级的 WebSocket：要开标签页得用 Target.* 域
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params = {}, sessionId) => new Promise((res) => {
    const myId = ++id;
    pending.set(myId, res);
    const msg = { id: myId, method, params };
    if (sessionId) msg.sessionId = sessionId;
    ws.send(JSON.stringify(msg));
  });
  const evalIn = async (sid, expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, sid);
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  const openTab = async (p) => {
    const t = await send("Target.createTarget", { url: BASE + p });
    const targetId = t.result.targetId;
    const a = await send("Target.attachToTarget", { targetId, flatten: true });
    const sid = a.result.sessionId;
    await send("Runtime.enable", {}, sid);
    await sleep(3000);
    return sid;
  };

  // 标签页 1：主页
  const A = await openTab("/hub.html");
  // 标签页 2：海报生成
  const B = await openTab("/");
  await sleep(1200);

  const a0 = await evalIn(A, BALL);
  const b0 = await evalIn(B, BALL);
  check("两个标签页初始都在右下角", isCorner(a0) && isCorner(b0), `A(${a0.x},${a0.y}) B(${b0.x},${b0.y})`);

  // 在 A（主页）把球拖到中间
  const dragged = await evalIn(A, DRAG);
  await sleep(700);                          // storage 事件是异步的，给一点时间
  check("主页拖动生效", dragged.x < a0.x - 200, `拖到 (${dragged.x},${dragged.y})`);

  // 关键：B（另一个标签页）应当自动跟着挪
  const b1 = await evalIn(B, BALL);
  check("另一个标签页**自动跟着挪**了", Math.abs(b1.x - dragged.x) <= 2 && Math.abs(b1.y - dragged.y) <= 2,
    `A(${dragged.x},${dragged.y}) → B(${b1.x},${b1.y})`);
  check("位置已写进公共存储（两个标签页共用一份）", !!b1.saved, `saved=${b1.saved}`);

  // 在 B 刷新 —— 应当把位置清掉，并且 A 也要跟着回右下角
  await send("Page.reload", {}, B);
  await sleep(4200);
  const b2 = await evalIn(B, BALL);
  check("B 刷新后自己回右下角", isCorner(b2), `B(${b2.x},${b2.y})`);
  await sleep(900);
  const a1 = await evalIn(A, BALL);
  check("**A（没刷新过的那个标签页）也回到右下角**", isCorner(a1),
    `A 从 (${dragged.x},${dragged.y}) 变成 (${a1.x},${a1.y})`);

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
