#!/usr/bin/env node
/**
 * pf-template-visual-diff.mjs：把同一构图内各模板渲染出来的图两两做像素对比。
 *
 * 为什么需要它：verify-layouts.mjs 验的是「版面签名唯一」，那是坐标和字号数字不同，
 * 但两个数字差 2% 时用户根本看不出来，观感上就是"选了模板没变化"。
 * 这个脚本用真实像素说话：同一构图内，任意两套模板的成品必须存在肉眼可辨的差异。
 *
 * 用法: node pf-template-visual-diff.mjs [差异下限，默认 3.0]
 */
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildPosterSpecFrom } from "../posterforge/public/poster-layout.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const BASE = process.env.PF_BASE || "http://127.0.0.1:8800";
const MIN_DIFF = Number(process.argv[2] || 3.0);
const OUT = path.join(ROOT, "posterforge", "public", "generated");

const raw = JSON.parse(readFileSync(path.join(ROOT, "posterforge", "templates.json"), "utf8"));
const templates = Array.isArray(raw) ? raw : raw.templates || [];

const content = {
  brand: "测试品牌", title: "测试标题文案", sub: "测试副标题，用来占位",
  price: "198", phone: "000-0000-0000", address: "测试路 1 号",
};
const photoUrls = ["/uploads/muz4h5oj-x135y-26_06_06_02_00_15.png"];
const autoBgUrl = "/uploads/.bgcache/bg-058a1c2d863d4cc6.png";

// 渲染每套模板，拿回本地 PNG 路径
const files = {};
for (const t of templates) {
  const spec = buildPosterSpecFrom(content, {
    photoUrls,
    layout: t.layout || undefined,
    composition: t.composition || null,
    variant: Math.max(0, ["a", "b", "c"].indexOf(String(t.variant || "a"))),
    tuning: t.tuning && typeof t.tuning === "object" ? t.tuning : null,
    tone: typeof t.tone === "number" ? t.tone : 0.5,
    kind: t.audience || "tourism",
    autoBgUrl,
  });
  const res = await fetch(`${BASE}/api/generate`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ spec }), signal: AbortSignal.timeout(120000),
  });
  const j = await res.json();
  if (j.ok && j.url) files[t.id] = path.join(OUT, path.basename(j.url));
  else console.log(`  ✗ ${t.id} 渲染失败`);
}

// 交给 Python/Pillow 算像素差（Node 侧没有图像库）
const groups = {};
for (const t of templates) if (files[t.id]) (groups[t.composition] ||= []).push(t.id);

const tasks = [];
for (const [comp, ids] of Object.entries(groups)) {
  for (let i = 0; i < ids.length; i++) {
    for (let k = i + 1; k < ids.length; k++) {
      tasks.push({ comp, a: ids[i], b: ids[k], fa: files[ids[i]], fb: files[ids[k]] });
    }
  }
}

const py = `
import sys, json
from PIL import Image, ImageChops
with open(sys.argv[1], "r", encoding="utf-8") as f:
    tasks = json.load(f)
out = []
for t in tasks:
    try:
        a = Image.open(t["fa"]).convert("RGB")
        b = Image.open(t["fb"]).convert("RGB")
        if a.size != b.size:
            out.append(dict(t, diff=999.0, note="尺寸不同"))
            continue
        d = ImageChops.difference(a, b); h = d.histogram()
        tot = sum(h[:256]) + sum(h[256:512]) + sum(h[512:768])
        mean = sum(i * v for i, v in enumerate(h[:256])) / tot
        out.append(dict(t, diff=round(mean, 2), note=""))
    except Exception as e:
        out.append(dict(t, diff=-1.0, note=str(e)[:60]))
with open(sys.argv[2], "w", encoding="utf-8") as f:
    json.dump(out, f, ensure_ascii=False)
`;
const pyFile = path.join(HERE, "_diff.py");
const tasksFile = path.join(HERE, "_diff_tasks.json");
const resFile = path.join(HERE, "_diff_result.json");
writeFileSync(pyFile, py, "utf8");
writeFileSync(tasksFile, JSON.stringify(tasks), "utf8");

const { spawnSync } = await import("node:child_process");
const r = spawnSync("py", [pyFile, tasksFile, resFile], { encoding: "utf8", windowsHide: true });
if (r.status !== 0) { console.error("算差异失败:", r.stderr || r.stdout || "(无输出)"); process.exit(1); }
const diffs = JSON.parse(readFileSync(resFile, "utf8"));

console.log("\n=== 同一构图内的像素差异（越小越像，低于下限说明用户看不出变化）===");
let bad = 0;
for (const [comp, ids] of Object.entries(groups)) {
  const rows = diffs.filter((d) => d.comp === comp).sort((x, y) => x.diff - y.diff);
  console.log(`\n  [${comp}] ${ids.length} 套，${rows.length} 组对比`);
  const worst = rows.slice(0, 3);
  for (const w of worst) {
    const flag = w.diff < MIN_DIFF ? " ✗ 太像" : " ok";
    console.log(`    ${String(w.diff).padStart(6)}  ${w.a} ↔ ${w.b}${flag}${w.note ? "  " + w.note : ""}`);
  }
  const badHere = rows.filter((x) => x.diff < MIN_DIFF).length;
  if (badHere) { bad += badHere; console.log(`    → 该构图下有 ${badHere} 组差异低于 ${MIN_DIFF}`); }
}

console.log(`\n合计：${diffs.length} 组对比，其中 ${bad} 组差异低于下限 ${MIN_DIFF}`);
if (bad) process.exitCode = 1;
