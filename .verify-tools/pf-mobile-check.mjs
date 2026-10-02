#!/usr/bin/env node
/**
 * pf-mobile-check.mjs —— 手机端到底什么样（用硬指标，不靠"看着还行"）
 *
 * 移动端翻车从来不是"看起来怪"，而是三件测得到的事：
 *   1. **横向溢出** —— 页面比屏幕宽，出现左右滚动条，右边内容是切掉的；
 *   2. **浮层出屏** —— 提示框比视口宽 / 被挤到屏幕外，按钮根本点不到；
 *   3. **触控目标太小** —— 关闭按钮 12px 见方，鼠标能点、手指点不中
 *      （规范建议 ≥ 44×44 CSS px）。
 *
 * 用法：node pf-mobile-check.mjs [baseUrl]
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { requireBrowser } from "../posterforge/paths.mjs";

const BASE = (process.argv.find((a) => /^https?:\/\//.test(a)) || "http://127.0.0.1:8800").replace(/\/$/, "");
const PORT = Number(process.env.CDP_PORT || 9397);
// 默认测海报页的提示框；--page=/hub.html 可测门户（那边没有提示框，只看溢出与触控尺寸）
//
// 注意取参数的方式：**不能**用 split('=')[1]。
// 默认值 `--page=/?nomodel=1` 里有两个 '='，split 会把它截成 `/?nomodel`，
// 于是 ?nomodel=1 变成 ?nomodel、读出来是空字符串，强制预览静默失效 ——
// 表现是"探测到的元素尺寸全是 0×0"，看着像页面坏了，其实是脚本把参数吃了。
const PAGE_ARG = process.argv.find((a) => a.startsWith("--page=")) || "--page=/?nomodel=1";
const PAGE = BASE + PAGE_ARG.slice(PAGE_ARG.indexOf("=") + 1);
// 有的页面根本没有那个提示框（比如门户）。对不存在的元素报"太小"，是脚本自己的噪音，
// 不是页面的问题 —— 那会把一次全绿的结果报成失败，比不测更坏。
const EXPECT_NOTICE = !PAGE.includes("hub.html") && !PAGE.includes("wenlv");
const PROFILE = mkdtempSync(path.join(tmpdir(), "pf-mobile-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 常见手机/平板视口（CSS px）
const SIZES = [
  [320, 568, "iPhone SE(1代)"],
  [360, 640, "安卓常见小屏"],
  [390, 844, "iPhone 14"],
  [430, 932, "iPhone 15 Pro Max"],
  [768, 1024, "iPad 竖屏"],
];

let bad = 0;
const proc = spawn(requireBrowser(), [
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`, "about:blank",
], { stdio: "ignore" });

const getJson = async (u) => { try { return await (await fetch(u)).json(); } catch { return null; } };

// 找出比视口宽的元素（只报最靠外的几个，避免刷屏）
const probe = `(function(){
  var vw = window.innerWidth;
  var over = [];
  document.querySelectorAll("body *").forEach(function(el){
    var r = el.getBoundingClientRect();
    if (r.width > vw + 2 || r.right > vw + 2 || r.left < -2) {
      over.push({ sel: el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + (el.className && typeof el.className === "string" ? "." + el.className.trim().split(/\\s+/)[0] : ""),
                  w: Math.round(r.width), left: Math.round(r.left), right: Math.round(r.right) });
    }
  });
  over.sort(function(a,b){ return b.right - a.right; });
  var box = document.getElementById("modelNotice");
  var br = box ? box.getBoundingClientRect() : null;
  var x = document.getElementById("mnClose");
  var xr = x ? x.getBoundingClientRect() : null;
  var btn = document.getElementById("mnDownload");
  var gr = btn ? btn.getBoundingClientRect() : null;
  var tt = document.getElementById("themeToggle") || document.querySelector("button.iconbtn");
  var tr = tt ? tt.getBoundingClientRect() : null;
  return {
    vw: vw,
    docScrollW: document.documentElement.scrollWidth,
    over: over.slice(0, 4),
    notice: br ? { w: Math.round(br.width), left: Math.round(br.left), right: Math.round(br.right), top: Math.round(br.top), bottom: Math.round(br.bottom), seen: br.width > 0 } : null,
    closeBox: xr ? { w: Math.round(xr.width), h: Math.round(xr.height) } : null,
    dlBtn: gr ? { w: Math.round(gr.width), h: Math.round(gr.height) } : null,
    themeBox: tr ? { w: Math.round(tr.width), h: Math.round(tr.height) } : null,
  };
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

  await send("Page.enable");
  await send("Runtime.enable");
  // 打出来，别猜：探测"元素尺寸 0×0"时，第一件要分清的是
  // "页面不该有它" 还是 "脚本压根没访问对地址"。
  console.log(`  实际访问：${PAGE}`);
  // 用 ?nomodel=1 保证提示框一定在（这样换台机器、哪怕本机已有模型也能测这一段）
  await send("Page.navigate", { url: PAGE });

  for (const [w, h, name] of SIZES) {
    await send("Emulation.setDeviceMetricsOverride", {
      width: w, height: h, deviceScaleFactor: 2, mobile: true,
    });
    await sleep(1400);
    const r = await evalJs(probe);
    if (!r) { console.log(`  ${name} (${w}×${h}): 取不到数据`); bad++; continue; }

    const overflow = r.docScrollW - r.vw;
    const overflowed = overflow > 2;
    // 浮层：横向要完整落在视口内（留 1px 容差）
    const n = r.notice;
    const noticeOk = n && n.left >= -1 && n.right <= r.vw + 1;
    const inView = n && n.top >= 0 && n.bottom <= h + 1;
    const closeOk = r.closeBox && r.closeBox.w >= 44 && r.closeBox.h >= 44;
    const btnOk = r.dlBtn && r.dlBtn.h >= 40;
    const themeOk = r.themeBox && r.themeBox.w >= 44 && r.themeBox.h >= 44;

    if (overflowed || !themeOk || (EXPECT_NOTICE && (!noticeOk || !inView || !closeOk || !btnOk))) bad++;
    console.log(`\n  ${name}  ${w}×${h}`);
    console.log(`    横向溢出      ${overflowed ? `✗ 页面比视口宽 ${overflow}px` : "✓ 无"}`);
    if (overflowed) for (const o of r.over) console.log(`        越界元素: ${o.sel}  width=${o.w} right=${o.right}（视口 ${r.vw}）`);
    console.log(`    提示框        ${!EXPECT_NOTICE ? "— 本页不该有" : (r.notice ? "✓ 在" : "✗ 没出现")}`);
    if (EXPECT_NOTICE) {
      console.log(`    提示框横向    ${noticeOk ? "✓ 完整在视口内" : `✗ left=${n ? n.left : "-"} right=${n ? n.right : "-"}（视口 ${r.vw}）`}`);
      console.log(`    提示框纵向    ${inView ? "✓ 完整可见" : `✗ top=${n ? n.top : "-"} bottom=${n ? n.bottom : "-"}（视口高 ${h}）`}`);
      console.log(`    关闭按钮      ${!r.closeBox ? "✗ 没找到" : (closeOk ? "✓" : "✗ 太小，手指点不中")}  ${r.closeBox ? r.closeBox.w + "×" + r.closeBox.h : ""}`);
      console.log(`    下载按钮      ${!r.dlBtn ? "✗ 没找到" : (btnOk ? "✓" : "✗ 偏矮")}  ${r.dlBtn ? r.dlBtn.w + "×" + r.dlBtn.h : ""}`);
    }
    console.log(`    主题切换钮    ${themeOk ? "✓" : "✗ 太小"}  ${r.themeBox ? r.themeBox.w + "×" + r.themeBox.h : "-"}`);
  }
  ws.close();
}

main()
  .catch((e) => { console.log(`  ✗ 中断：${e.message}`); bad++; })
  .finally(async () => {
    try { proc.kill(); } catch { }
    await sleep(600);
    try { rmSync(PROFILE, { recursive: true, force: true }); } catch { }
    console.log(`\n汇总：${bad === 0 ? "全部尺寸都通过" : bad + " 个尺寸有问题"}`);
    // 有失败必须让调用方看得见：原来这里永远 exit 0，
    // 结果回归脚本靠 exit code 判断，把"5 个尺寸都失败"报成了 PASS —— 比不跑更坏。
    process.exit(bad === 0 ? 0 : 1);
  });
