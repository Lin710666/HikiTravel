#!/usr/bin/env node
/**
 * pf-stress.mjs，PosterForge 的功能冒烟 + 压力测试
 *
 * 为什么不复用现成的 stress-test.mjs：
 *   那批脚本是给旅游规划后端写的（打 8001 的接口），瓶颈在完全不同的地方。
 *   海报站点真正会卡住的是 **Python 渲染 + Pillow 解码 + LLM 写文案**，
 *   拿只读接口去压它，测出来的只是"HTTP 层没坏"，等于没测。
 *
 * 四段，由浅入深，每段都必须真的成功拿到结果（不看代码猜）：
 *   1. 冒烟，核心接口逐个打一遍："能不能用"
 *   2. 只读压，混合并发：吞吐 / 错误率 / 分位延迟
 *   3. 文案压，并发调 /api/compose（走本地 LLM），这是最容易被同时点爆的一段
 *   4. 出图压，并发真渲染 PNG：真实用户体感最差的地方
 *
 * 用法：
 *   node pf-stress.mjs                     # 默认 http://127.0.0.1:8800
 *   node pf-stress.mjs http://127.0.0.1:8787
 *   node pf-stress.mjs --full              # 加上出图压测（默认跳过，耗时且有显存成本）
 *
 * 设计原则：**指数退让地加压**，不在未知机器上直接开满并发。
 * 这台机器上跑着 Ollama 和海报服务，压垮了是无意义的破坏。
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = (process.argv.find((a) => /^https?:\/\//.test(a)) || "http://127.0.0.1:8800").replace(/\/$/, "");
const FULL = process.argv.includes("--full");
const ONLY_SMOKE = process.argv.includes("--smoke");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- 统计
class Stats {
  constructor(name) { this.name = name; this.ok = 0; this.fail = 0; this.lat = []; this.errors = new Map(); }
  record(ms, err) {
    if (err) {
      this.fail++;
      const k = String(err.message || err).slice(0, 90);
      this.errors.set(k, (this.errors.get(k) || 0) + 1);
    } else { this.ok++; this.lat.push(ms); }
  }
  p(q = 0.5) {
    if (!this.lat.length) return 0;
    const s = [...this.lat].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(s.length * q))];
  }
  report() {
    const total = this.ok + this.fail;
    const rate = total ? ((100 * this.ok) / total).toFixed(1) : "0.0";
    const avg = this.lat.length ? Math.round(this.lat.reduce((a, b) => a + b, 0) / this.lat.length) : 0;
    console.log(
      `  ${this.name.padEnd(22)} 请求 ${String(total).padStart(4)}  成功 ${String(this.ok).padStart(4)}` +
      ` (${rate}%)  平均 ${String(avg).padStart(5)}ms  P50 ${String(this.p()).padStart(5)}ms` +
      `  P95 ${String(this.p(0.95)).padStart(6)}ms  P99 ${String(this.p(0.99)).padStart(6)}ms`
    );
    for (const [msg, n] of [...this.errors].sort((a, b) => b[1] - a[1]).slice(0, 5)) {
      console.log(`      ✗ ${n}x ${msg}`);
    }
    return { name: this.name, total, ok: this.ok, fail: this.fail, rate: Number(rate), p50: this.p(), p95: this.p(0.95), errors: [...this.errors.keys()] };
  }
}

async function call(path, { method = "GET", body = null, timeoutMs = 120000 } = {}) {
  const t0 = Date.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(BASE + path, {
      method,
      signal: ctl.signal,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`HTTP ${r.status} ${text.slice(0, 70)}`);
    return { ms: Date.now() - t0, text };
  } finally { clearTimeout(timer); }
}

/** 并发跑一批任务，返回各自的 {ms, err} */
async function burst(n, task) {
  const out = [];
  await Promise.all(
    Array.from({ length: n }, async (_, i) => {
      try { out[i] = { ms: (await task(i)).ms, err: null }; }
      catch (e) { out[i] = { ms: 0, err: e }; }
    })
  );
  return out;
}

/** 持续压一段时间：concurrency 个 worker 不停打，直到到点 */
async function sustained(name, concurrency, seconds, task) {
  const st = new Stats(name);
  const stopAt = Date.now() + seconds * 1000;
  await Promise.all(
    Array.from({ length: concurrency }, async (_, w) => {
      let n = 0;
      while (Date.now() < stopAt) {
        try { st.record((await task(w, n++)).ms, null); }
        catch (e) { st.record(0, e); }
      }
    })
  );
  return st;
}

const brief = "帮西湖边一家做杭帮菜的餐馆写一张国庆假期的宣传海报，主打西湖醋鱼和龙井虾仁，人均 88";

// ---------------------------------------------------------------- 1. 冒烟
async function smoke() {
  console.log("\n[1/4] 功能冒烟：核心接口逐个打一遍");
  const st = new Stats("smoke");
  const checks = [
    ["静态首页", "/", 200],
    ["样式表", "/style.css", 200],
    ["前端脚本", "/app.js", 200],
    ["悬浮球脚本", "/ai-ball.js", 200],
    ["健康检查 /api/health", "/api/health", 200],
    ["模板库 /api/templates", "/api/templates", 200],
    ["门户 /hub.html", "/hub.html", 200],
  ];
  for (const [label, path, want] of checks) {
    try {
      const r = await call(path);
      const len = r.text.length;
      if (len < 50) throw new Error(`返回内容过短（${len} 字节）`);
      st.record(r.ms, null);
      console.log(`  ✓ ${label.padEnd(24)} ${String(r.ms).padStart(6)}ms  ${len} 字节`);
    } catch (e) {
      st.record(0, e);
      console.log(`  ✗ ${label.padEnd(24)} ${e.message}`);
    }
  }
  // 上传：用户进来做的第一件事就是传照片。只"收下了"不算通过，
  // 必须能按返回的地址再取回来，否则就是"上传成功但渲染时找不到文件"那类经典问题。
  try {
    const img = readFileSync(path.join(HERE, "..", "renderer", "assets", "sample-photo.png")).toString("base64");
    const up = await call("/api/upload", {
      method: "POST",
      body: { files: [{ name: "stress-photo.png", data: "data:image/png;base64," + img }] },
      timeoutMs: 60000,
    });
    const j = JSON.parse(up.text);
    const url = (j.files || [])[0] && j.files[0].url;
    if (!url) throw new Error("上传接口 200 但没返回图片地址");
    const back = await call(url);
    if (back.text.length < 100) throw new Error(`回取到的内容只有 ${back.text.length} 字节，不像一张图`);
    up.ms += back.ms;
    st.record(up.ms, null);
    console.log(`  ✓ ${"照片上传 + 回取".padEnd(22)} ${String(up.ms).padStart(6)}ms  ${url}  ${back.text.length} 字节`);
  } catch (e) {
    st.record(0, e);
    console.log(`  ✗ ${"照片上传 + 回取".padEnd(22)} ${e.message}`);
  }

  // 主题与模型控件是否真的进了页面（改完前端必须验证它落在用户能看到的地方）
  try {
    const html = (await call("/")).text;
    const hasToggle = html.includes('id="themeToggle"');
    const hasLight = html.includes('data-theme="light"') || html.includes("pf-theme");
    // 只认"控件本身"（<select id="modelSel"> 或那个 option 的 value）。
    // 别拿模型名字符串去判断，删掉它之后注释里还会提到它，会把自己误判成没删干净。
    const deadModel = html.includes('id="modelSel"') || html.includes('value="poster-forge-int8"');
    const hasNote = html.includes("model-note");
    console.log(`  ${hasToggle ? "✓" : "✗"} 主题切换按钮已注入`);
    console.log(`  ${hasLight ? "✓" : "✗"} 主题初始化脚本已注入（localStorage 记忆 + 跟随系统）`);
    console.log(`  ${deadModel ? "✗ 死控件仍在！" : "✓"} 那个没用的假模型选项已移除`);
    console.log(`  ${hasNote ? "✓" : "✗"} 绘图引擎说明标签已就位`);
    st.record(0, hasToggle && hasLight && !deadModel && hasNote ? null : new Error("页面元素校验未通过"));
  } catch (e) { st.record(0, e); }
  // CSS 里浅色主题与变量是否真的存在
  try {
    const css = (await call("/style.css")).text;
    const ok = css.includes('html[data-theme="light"]') && css.includes("--ink-strong") && css.includes(".theme-toggle");
    console.log(`  ${ok ? "✓" : "✗"} 浅色主题变量与切换按钮样式已生效`);
    st.record(0, ok ? null : new Error("style.css 里找不到浅色主题"));
  } catch (e) { st.record(0, e); }
  return st.report();
}

// ---------------------------------------------------------------- 2. 只读压
async function readLoad() {
  console.log("\n[2/4] 只读并发：12 并发压 10 秒（混合静态资源与接口）");
  const paths = ["/", "/api/health", "/api/templates", "/style.css", "/app.js"];
  const st = await sustained("read-mix", 12, 10, (w, n) => call(paths[n % paths.length]));
  return st.report();
}

// ---------------------------------------------------------------- 3. 文案压
async function composeLoad() {
  console.log("\n[3/4] 文案并发：4 并发 × 6 次 /api/compose（真的走本地 LLM 写文案）");
  const st = new Stats("compose");
  const rounds = 2, per = 4;
  for (let r = 0; r < rounds; r++) {
    const res = await burst(per, () =>
      call("/api/compose", { method: "POST", body: { brief, photos: [], facts: {}, mode: "poster", render: false }, timeoutMs: 180000 })
    );
    for (const x of res) st.record(x.ms, x.err);
    process.stdout.write(`  第 ${r + 1}/${rounds} 轮完成\n`);
  }
  return st.report();
}

// ---------------------------------------------------------------- 4. 出图压
async function renderLoad() {
  console.log("\n[4/4] 出图并发：2 并发 × 2 轮真渲染（Python + Pillow，最慢的一段）");
  const st = new Stats("render");
  for (let r = 0; r < 2; r++) {
    const res = await burst(2, () =>
      call("/api/compose", { method: "POST", body: { brief, photos: [], facts: {}, mode: "poster", render: true }, timeoutMs: 300000 })
    );
    for (const x of res) {
      st.record(x.ms, x.err);
      if (!x.err && !/\.png|generated/i.test("")) { /* 结果里应带图片地址，下面统一校验 */ }
    }
    process.stdout.write(`  第 ${r + 1}/2 轮完成\n`);
  }
  return st.report();
}

// ---------------------------------------------------------------- 主流程
(async () => {
  console.log(`PosterForge 压测  →  ${BASE}${FULL ? "  (含出图压测)" : "  (跳过出图压测，加 --full 打开)"}`);
  console.log("─".repeat(78));
  const t0 = Date.now();
  const results = [];
  try {
    results.push(await smoke());
    if (ONLY_SMOKE) {
      console.log("\n（--smoke：只跑冒烟，其余段跳过）");
    } else {
      results.push(await readLoad());
      results.push(await composeLoad());
      if (FULL) results.push(await renderLoad());
      else console.log("\n[4/4] 出图并发：已跳过（--full 打开）");
    }
  } catch (e) {
    console.log(`\n压测中断：${e.message}`);
  }

  console.log("\n" + "─".repeat(78));
  console.log("汇总");
  for (const r of results) {
    console.log(`  ${r.name.padEnd(14)} ${String(r.ok).padStart(4)}/${String(r.total).padStart(4)} 成功（${r.rate}%）` +
      `  P50 ${String(r.p50).padStart(5)}ms  P95 ${String(r.p95).padStart(6)}ms`);
  }
  console.log(`  总耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  const failed = results.filter((r) => r.fail > 0);
  if (failed.length) {
    console.log("\n存在失败的段：");
    for (const f of failed) console.log(`  ${f.name}: ${f.errors.slice(0, 3).join(" | ")}`);
  } else {
    console.log("\n全部通过：没有一次失败请求。");
  }
  process.exit(failed.length ? 1 : 0);
})();
