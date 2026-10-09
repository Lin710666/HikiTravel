#!/usr/bin/env node
/**
 * pf-all-templates-check.mjs：把 templates.json 里的每一套模板都跑一遍，看它到底能不能出图。
 *
 * 为什么要有这个：之前只抽测了少数几套就下结论"模板没问题"，结果实际使用中
 * 大量模板选了之后出不了图。模板是 41 套、7 种构图 × 3 种变体 × 各自的
 * 精调参数，抽测根本覆盖不到，必须一套不落地过一遍。
 *
 * 两步：
 *   1. 构造阶段：直接调 buildPosterSpecFrom（不经过模型），看 spec 能不能构出来、
 *      图层结构是否落在该模板声明的构图里。这一步很快。
 *   2. 渲染阶段：把 spec 交给 /api/generate 真渲染，看有没有失败、产物是否非空。
 *      这一步慢，用 --render 打开。
 *
 * 用法:
 *   node pf-all-templates-check.mjs            # 只跑构造阶段
 *   node pf-all-templates-check.mjs --render   # 连渲染一起跑
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildPosterSpecFrom } from "../posterforge/public/poster-layout.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const BASE = process.env.PF_BASE || "http://127.0.0.1:8800";
const DO_RENDER = process.argv.includes("--render");

const raw = JSON.parse(readFileSync(path.join(ROOT, "posterforge", "templates.json"), "utf8"));
const templates = Array.isArray(raw) ? raw : raw.templates || [];

// 模板声明的构图 → 期望在 spec 里看到的特征
const EXPECT = {
  fullbleed: { bg: "image", layerPrefix: null, note: "图铺满，文字压图上（有图时 bg 为 image）" },
  axial:     { bg: null,    layerPrefix: null, note: "居中" },
  split:     { bg: "gradient", layerPrefix: "bandPhoto", note: "图在上方一条" },
  splitv:    { bg: "gradient", layerPrefix: "sidePhoto", note: "图在右侧" },
  focal:     { bg: "gradient", layerPrefix: "cardPhoto", note: "居中悬浮卡片" },
  grid:      { bg: "gradient", layerPrefix: "bandPhoto", note: "网格信息" },
  typeled:   { bg: "gradient", layerPrefix: null, note: "不用图" },
};

// 每套模板都用同一份内容去构，隔离出"模板参数"这个变量
const content = {
  brand: "测试品牌", title: "测试标题文案", sub: "测试副标题，用来占位",
  price: "198", phone: "000-0000-0000", address: "测试路 1 号",
};
const photoUrls = ["/uploads/muz4h5oj-x135y-26_06_06_02_00_15.png"];
const autoBgUrl = "/uploads/.bgcache/bg-058a1c2d863d4cc6.png";

let bad = 0, okCount = 0;
const rows = [];

for (const t of templates) {
  const opts = {
    photoUrls,
    layout: t.layout || undefined,
    composition: t.composition || null,
    variant: Math.max(0, ["a", "b", "c"].indexOf(String(t.variant || "a"))),
    tuning: t.tuning && typeof t.tuning === "object" ? t.tuning : null,
    tone: typeof t.tone === "number" ? t.tone : 0.5,
    kind: t.audience || "tourism",
    autoBgUrl,
  };

  let spec = null, err = "";
  try {
    spec = buildPosterSpecFrom(content, opts);
  } catch (e) {
    err = String(e && e.message || e);
  }

  if (!spec) {
    bad++;
    rows.push({ id: t.id, comp: t.composition, status: "构造抛异常", detail: err });
    continue;
  }

  const layers = spec.layers || [];
  const names = layers.map((l) => l.name);
  const bgType = spec.background ? spec.background.type : "(无 background)";
  const exp = EXPECT[t.composition] || {};
  const problems = [];

  // 图片层的存在性：除 typeled 外都该有图（有照片 + 有 AI 底图的前提下）
  const hasImageLayer = layers.some((l) => l.type === "image");
  const imgOnBg = bgType === "image";
  if (t.composition === "typeled") {
    if (hasImageLayer) problems.push("文字主导却出现了图片层");
  } else if (!hasImageLayer && !imgOnBg) {
    problems.push("该有图却既没有图片层、背景也不是图");
  }
  // 构图专属图层
  if (exp.layerPrefix && !names.includes(exp.layerPrefix)) {
    problems.push(`缺 ${exp.layerPrefix} 层（该构图的关键图层）`);
  }
  // 基本完整性
  if (!names.includes("title")) problems.push("缺 title 层");
  if (spec.canvas?.width !== 1080) problems.push(`画布宽异常 ${spec.canvas?.width}`);

  if (problems.length) { bad++; rows.push({ id: t.id, comp: t.composition, status: "结构异常", detail: problems.join("；") }); }
  else { okCount++; rows.push({ id: t.id, comp: t.composition, status: "ok", detail: `${bgType} / ${layers.length} 层` }); }
}

console.log("=== 构造阶段 ===");
for (const r of rows) {
  const mark = r.status === "ok" ? "  ok  " : "  ✗✗  ";
  console.log(`${mark}${r.id.padEnd(24)} comp=${String(r.comp).padEnd(10)} ${r.detail}`);
}
console.log(`\n构造阶段：${okCount} 套正常 / ${bad} 套有问题（共 ${templates.length}）`);

if (DO_RENDER) {
  console.log("\n=== 渲染阶段（真调 /api/generate）===");
  let rok = 0, rbad = 0;
  for (const t of templates) {
    const opts = {
      photoUrls,
      layout: t.layout || undefined,
      composition: t.composition || null,
      variant: Math.max(0, ["a", "b", "c"].indexOf(String(t.variant || "a"))),
      tuning: t.tuning && typeof t.tuning === "object" ? t.tuning : null,
      tone: typeof t.tone === "number" ? t.tone : 0.5,
      kind: t.audience || "tourism",
      autoBgUrl,
    };
    let spec;
    try { spec = buildPosterSpecFrom(content, opts); } catch { rbad++; console.log(`  ✗✗ ${t.id} 构造失败`); continue; }
    try {
      const res = await fetch(`${BASE}/api/generate`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ spec }), signal: AbortSignal.timeout(120000),
      });
      const j = await res.json();
      if (j.ok) { rok++; console.log(`  ok  ${t.id.padEnd(24)} ${j.url}  ${Math.round((j.bytes || 0) / 1024)} KB`); }
      else { rbad++; console.log(`  ✗✗ ${t.id.padEnd(24)} 失败: ${j.stage || ""} ${j.message || ""}`.slice(0, 150)); }
    } catch (e) {
      rbad++; console.log(`  ✗✗ ${t.id.padEnd(24)} 请求异常: ${e.message}`);
    }
  }
  console.log(`\n渲染阶段：${rok} 成功 / ${rbad} 失败`);
  if (rbad) process.exitCode = 1;
}

if (bad) process.exitCode = 1;
