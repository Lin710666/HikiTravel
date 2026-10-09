#!/usr/bin/env node
/**
 * pf-corner-probe.mjs，把页面上某个角落里的元素连坐标一起列出来。
 *
 * 用途：视觉模型（本地那个小模型）对"谁压着谁"经常说不清，
 * 而"两个元素挤在一起"本质是**矩形重叠**，用坐标算比看图靠谱得多。
 *
 * 用法：node pf-corner-probe.mjs [url] [w] [h]
 *   默认 http://127.0.0.1:8800/wenlv/?theme=dark 720 140
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { requireBrowser } from "../posterforge/paths.mjs";

const URL = process.argv.find((a) => /^https?:\/\//.test(a)) || "http://127.0.0.1:8800/wenlv/?theme=dark";
const W = Number(process.argv[3] || 720);
const H = Number(process.argv[4] || 140);
const PORT = Number(process.env.CDP_PORT || 9394);
const PROFILE = mkdtempSync(path.join(tmpdir(), "pf-corner-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

  await send("Page.enable");
  await send("Runtime.enable");
  // --ls=key=value：先在页面里写一条 localStorage，再刷新。
  // 用途：像 /wenlv/ 这种页面的主题来自 localStorage / 系统偏好，光靠 URL 参数切不了，
  // 得能替它把"用户的选择"造出来，才验得到另一套配色。
  const lsArg = (process.argv.find((a) => a.startsWith("--ls=")) || "").slice(5);
  await send("Page.navigate", { url: URL });
  await sleep(1800);
  if (lsArg.includes("=")) {
    const i = lsArg.indexOf("=");
    await evalJs(`localStorage.setItem(${JSON.stringify(lsArg.slice(0, i))}, ${JSON.stringify(lsArg.slice(i + 1))})`);
    await send("Page.navigate", { url: URL });
    await sleep(5200);
  } else {
    await sleep(4200);
  }

  const probe = `(function(){
    var out = [];
    document.querySelectorAll("body *").forEach(function(el){
      var r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return;
      if (r.top > ${H} || r.left > ${W}) return;
      var kids = el.children.length;
      var txt = (el.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 26);
      if (!txt) return;
      out.push({
        tag: el.tagName.toLowerCase(),
        cls: (typeof el.className === "string" ? el.className : "").slice(0, 34),
        id: el.id || "",
        leaf: kids === 0,
        txt: txt,
        x: Math.round(r.left), y: Math.round(r.top),
        w: Math.round(r.width), h: Math.round(r.height),
        color: getComputedStyle(el).color,
        bg: getComputedStyle(el).backgroundColor,
      });
    });
    // 只留叶子（文字元素）和带底色的块，避免刷屏
    return out.filter(function(o){ return o.leaf || o.bg !== "rgba(0, 0, 0, 0)"; }).slice(0, 24);
  })()`;

  // --shot=路径：存一张截图。颜色这种事算出来的值和眼睛看到的不总是一致
  // （层叠、混合模式、半透明叠在半透明上），所以得能真的看一眼。
  const shotArg = process.argv.find((a) => a.startsWith("--shot="));
  if (shotArg) {
    const p = shotArg.slice(7);
    const r = await send("Page.captureScreenshot", { format: "png" });
    if (r.result && r.result.data) {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(p, Buffer.from(r.result.data, "base64"));
      console.log(`\n  截图已保存: ${p}`);
    } else {
      console.log(`\n  截图失败: ${JSON.stringify(r).slice(0, 200)}`);
    }
    ws.close();
    return;
  }

  // --js=表达式：在页面里求值并打印。
  // 用来查 shadow DOM 内部的东西，普通 DOM 查询穿不进 shadow 边界，
  // 而右下角那个 AI 助手组件正好就是个 shadow 组件。
  const jsArg = process.argv.find((a) => a.startsWith("--js="));
  if (jsArg) {
    const r = await evalJs(jsArg.slice(5));
    console.log("\n  --js 结果:\n" + JSON.stringify(r, null, 2));
    ws.close();
    return;
  }

  const rows = await evalJs(probe);
  console.log(`\n页面 ${URL}\n左上角区域 ${W}×${H} 内的元素：\n`);
  console.log("  " + "tag".padEnd(7) + "class/id".padEnd(30) + "文字".padEnd(24) + "位置(x,y)".padEnd(14) + "尺寸".padEnd(12) + "文字色 / 背景");
  for (const r of rows) {
    const tag = r.tag + (r.id ? "#" + r.id : "");
    const cls = (r.cls || r.id).slice(0, 28);
    console.log("  " + tag.padEnd(7) + cls.padEnd(30) + (r.txt || "").slice(0, 22).padEnd(24)
      + `${r.x},${r.y}`.padEnd(14) + `${r.w}×${r.h}`.padEnd(12) + `${r.color} / ${r.bg}`);
  }

  // 重叠检测：两两比较矩形
  console.log("\n  重叠分析：");
  let overlaps = 0;
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const a = rows[i], b = rows[j];
      const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      if (ox > 4 && oy > 4) {
        overlaps++;
        console.log(`    ✗ "${a.txt.slice(0, 14)}" (${a.x},${a.y} ${a.w}×${a.h})  与  "${b.txt.slice(0, 14)}" (${b.x},${b.y} ${b.w}×${b.h})  重叠 ${ox}×${oy}px`);
      }
    }
  }
  if (!overlaps) console.log("    ✓ 没有重叠");
  ws.close();
}

main()
  .catch((e) => { console.log(`  ✗ ${e.message}`); })
  .finally(async () => {
    try { proc.kill(); } catch { }
    await sleep(500);
    try { rmSync(PROFILE, { recursive: true, force: true }); } catch { }
  });
