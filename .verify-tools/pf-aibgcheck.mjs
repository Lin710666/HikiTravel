import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { requireBrowser } from "../posterforge/paths.mjs";
const PORT = 9447;
const PROFILE = mkdtempSync(path.join(tmpdir(), "pf-aibg-"));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const proc = spawn(requireBrowser(), ["--headless=new","--disable-gpu","--no-first-run","--no-default-browser-check",`--remote-debugging-port=${PORT}`,`--user-data-dir=${PROFILE}`,"--window-size=1440,1200","about:blank"], { stdio: "ignore" });
const getJson = async (u) => { try { return await (await fetch(u)).json(); } catch { return null; } };
let ver = null;
for (let i = 0; i < 60 && !ver; i++) { await sleep(400); ver = await getJson(`http://127.0.0.1:${PORT}/json/version`); }
if (!ver) { console.log("  浏览器没起来"); process.exit(1); }
const target = ((await getJson(`http://127.0.0.1:${PORT}/json/list`)) || []).find(t => t.type === "page");
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const pending = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise(res => { const myId = ++id; pending.set(myId, res); ws.send(JSON.stringify({ id: myId, method, params })); });
const evalJs = async (expr) => { const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }); return r.result?.result?.value; };
await send("Page.enable"); await send("Runtime.enable");
await send("Page.navigate", { url: "http://127.0.0.1:8800/" });
await sleep(3500);
console.log("  页面上还有 #aiBg 开关吗:", await evalJs(`!!document.querySelector('#aiBg')`));
console.log("  页面上还写着「AI 背景」吗:", await evalJs(`document.body.innerHTML.includes('AI 背景')`));
console.log("  toggles 区现在的内容:", await evalJs(`(document.querySelector('#toggles')?.textContent||'').trim().replace(/\\s+/g,' ')`));
console.log("  JS 有无报错:", await evalJs(`(window.__errs||[]).length`));
try { proc.kill(); } catch {}
