#!/usr/bin/env node
/**
 * pf-template-link-check.mjs —— 验证「套用模板 → 生成」这条链路上，模板的构图有没有真的生效。
 *
 * 为什么要有这个：出现过"套了模板，生成出来却不是那个样式"。根因是
 * state.composition 会压过模板的 composition —— 用户只要先手选过版式、
 * 或者先跑过一次「参考图分析」（它会把结果写进 state.composition），
 * 之后套任何模板都会被旧版式盖掉。这是个只在**特定操作顺序**下才复现的
 * 交叉污染，光看单条路径的代码是看不出来的，必须把顺序走一遍。
 *
 * 用法: node pf-template-link-check.mjs [baseUrl]
 */
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { requireBrowser } from "../posterforge/paths.mjs";

const BASE = (process.argv.find((a) => /^https?:\/\//.test(a)) || "http://127.0.0.1:8800").replace(/\/$/, "");
const PORT = Number(process.env.CDP_PORT || 9411);
const PROFILE = mkdtempSync(path.join(tmpdir(), "pf-tpllink-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const proc = spawn(requireBrowser(), [
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  "--window-size=1440,1200", "about:blank",
], { stdio: "ignore" });

const getJson = async (u) => { try { return await (await fetch(u)).json(); } catch { return null; } };

let pass = 0, fail = 0;
function check(ok, label, detail = "") {
  if (ok) { pass++; console.log(`  [OK] ${label}${detail ? "  " + detail : ""}`); }
  else { fail++; console.log(`  [FAIL] ${label}${detail ? "  " + detail : ""}`); }
}

async function main() {
  let ver = null;
  for (let i = 0; i < 60 && !ver; i++) { await sleep(400); ver = await getJson(`http://127.0.0.1:${PORT}/json/version`); }
  if (!ver) throw new Error("浏览器没起来");
  const target = ((await getJson(`http://127.0.0.1:${PORT}/json/list`)) || []).find((t) => t.type === "page");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (method, params = {}) => new Promise((res) => { const myId = ++id; pending.set(myId, res); ws.send(JSON.stringify({ id: myId, method, params })); });
  const evalJs = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) return { __err: r.result.exceptionDetails.text };
    return r.result && r.result.result ? r.result.result.value : undefined;
  };

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Page.navigate", { url: `${BASE}/` });
  await sleep(2500);

  // 等 app 暴露调试出口
  let ready = false;
  for (let i = 0; i < 40 && !ready; i++) {
    ready = await evalJs("!!(window.posterforge && window.posterforge.__debug && window.posterforge.__debug.applyTemplateById)");
    if (!ready) await sleep(400);
  }
  check(ready, "页面加载完成、__debug 出口可用");
  if (!ready) { console.log("  页面没准备好，中止"); return; }

  const tpls = await evalJs("JSON.stringify((window.posterforge.__debug.templates||[]).map(t=>({id:t.id,composition:t.composition||null,name:t.name||t.title||''})))");
  const list = JSON.parse(tpls || "[]");
  check(list.length > 0, "取到模板列表", `${list.length} 套`);
  if (!list.length) return;

  // 找一个有明确 composition 的模板
  const tpl = list.find((t) => t.composition) || list[0];
  check(!!tpl.composition, `模板「${tpl.name}」带 composition`, `composition=${tpl.composition}`);

  // ---- 场景：先手选一个**别的**版式，把 state.composition 污染掉，再套模板 ----
  const others = ["fullbleed", "axial", "split", "splitv", "focal", "grid", "typeled"];
  const pollute = others.find((c) => c !== tpl.composition) || "typeled";

  const polluted = await evalJs(`(() => {
    // 版式列表由 renderTplPicker 渲染，页面刚加载时可能还没渲染过 ——
    // 先强制渲染一次，否则点不到版式按钮，"污染"这一步会静默跳过，
    // 后面的断言就变成了在验一个没被污染的干净状态（等于没验）。
    try { window.posterforge.__debug.renderTplPicker(); } catch (e) {}
    const el = document.querySelector('.comp-item[data-comp="${pollute}"]');
    if (!el) {
      const all = Array.from(document.querySelectorAll('.comp-item')).map(x => x.dataset.comp);
      return { ok:false, why:'找不到版式按钮 ${pollute}；现有: ' + (all.join(',') || '(一个都没有)') };
    }
    el.click();
    return { ok:true };
  })()`);
  check(polluted && polluted.ok, `先手选版式「${pollute}」污染 state.composition`, polluted && polluted.why ? polluted.why : "");

  // 套用目标模板
  const applied = await evalJs(`(() => {
    try { window.posterforge.__debug.applyTemplateById(${JSON.stringify(tpl.id)}); return { ok:true }; }
    catch (e) { return { ok:false, why:String(e && e.message || e) }; }
  })()`);
  check(applied && applied.ok, "套用模板成功", applied && applied.why ? applied.why : "");
  await sleep(600);

  // 关键断言：界面上的「当前」版式应当已经变成模板的 composition，而不是残留的 pollute
  const current = await evalJs(`(() => {
    const on = document.querySelector('.comp-item.on');
    return on ? on.dataset.comp : null;
  })()`);
  check(current === tpl.composition,
    "套用模板后，当前版式 = 模板的 composition（不再被旧版式盖住）",
    `期望 ${tpl.composition}，实际 ${current}（污染值曾是 ${pollute}）`);

  // 再验一次反方向：选版式要能清掉模板，否则模板会反过来盖回去
  const back = await evalJs(`(() => {
    const el = document.querySelector('.comp-item[data-comp="${pollute}"]');
    if (!el) return null;
    el.click();
    const on = document.querySelector('.comp-item.on');
    return on ? on.dataset.comp : null;
  })()`);
  check(back === pollute, "反方向：手选版式仍然生效（模板被清掉）", `期望 ${pollute}，实际 ${back}`);

  console.log(`\n汇总：${pass} 通过 / ${fail} 失败`);
  if (fail) process.exitCode = 1;
}

main().catch((e) => { console.error("探针异常:", e.message); process.exitCode = 1; })
  .finally(() => { try { proc.kill(); } catch {} });
