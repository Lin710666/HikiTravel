/**
 * aigen.mjs —— 本地出图客户端（不依赖 ComfyUI）。
 *
 * 和 comfy.mjs 的根本差别：
 *   comfy.mjs 需要一个**常驻的 ComfyUI 服务**（用户得手动点启动器，
 *   而那个启动器上印着 MiniMax-H3，与实际用的模型不符）。
 *   aigen.mjs 直接拉起一个 Python worker，用 diffusers 加载 SDXL-Turbo 出图，
 *   不需要任何 HTTP 服务在跑。
 *
 * 为什么要常驻 worker：
 *   冷进程每次都要把权重搬上卡。实测 768x1024 / 4 步：
 *       冷进程（含首次上卡）≈ 20 秒
 *       常驻进程后续每次   ≈ 6 秒
 *   所以在内存里留一个 worker，空闲超过 idleMs 再回收（回收是为了把显存让出来）。
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, unlink } from "node:fs/promises";
import path from "node:path";
// 解释器与模型目录由 paths.mjs / 环境变量决定，本文件里不写死盘符
import { findComfyPython, REPO_ROOT } from "./paths.mjs";
// 用哪个模型不写死 —— 自动检索本机现成的，质量高的优先（规则只在 models.mjs 里）
import { pickBestModel } from "./models.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

/**
 * 跑出图 worker 的解释器：只有装了 CUDA 版 torch 与 diffusers 的那个才行
 * （通常是 ComfyUI 便携版自带的 python_embeded）。
 *
 * 原来这里写死 `E:\ComfyUI_windows_portable\python_embeded\python.exe` ——
 * 那是某台机器上的位置，本机连 E 盘都没有，报错却只说"找不到出图用的 Python"，
 * 看不出是"路径写死了"还是"真没装"。
 */
export const AIGEN_PYTHON = process.env.PF_AIGEN_PYTHON
  || findComfyPython()
  || process.env.PF_PYTHON
  || "python";
export const AIGEN_SCRIPT = path.join(HERE, "aigen.py");

/**
 * 模型目录（SDXL-Turbo 权重，几个 GB，不进仓库）。
 *
 * 默认值是**项目内的相对位置** `<仓库>/models/sdxl-turbo`：
 * 相对路径意味着把仓库整体拷到哪台机器都成立。
 * 权重放在别处时用 PF_AIGEN_MODEL 指定即可，比如
 *   set PF_AIGEN_MODEL=D:\models\sdxl-turbo
 */
/**
 * 模型目录：显式指定最优先，否则**用自动检索挑出来的那个**。
 *
 * 原来这里默认写死 SDXL-Turbo 的路径 —— 意味着本机就算放了更好的模型
 * （比如 Qwen-Image）也不会被用上，用户得回来改代码。现在谁在机器上就用谁，
 * 挑选规则（质量优先 + 可用优先）在 models.mjs 里，只有一处。
 */
function resolveModelDir() {
  if (process.env.PF_AIGEN_MODEL) return process.env.PF_AIGEN_MODEL;
  try {
    const best = pickBestModel();
    if (best) return best.root;
  } catch { /* 检索失败不该让整个站点起不来 */ }
  return path.join(REPO_ROOT, "models", "sdxl-turbo");   // 兜底：给个明确的预期路径
}
export const AIGEN_MODEL = resolveModelDir();

/**
 * 选中模型的推荐采样参数。
 *
 * 为什么需要它：Turbo 系是 4 步 / guidance 0，而 Qwen-Image、SDXL 这类要 20 步以上、
 * guidance 2.5 左右。**参数用错不是"差一点"，是直接出废图**（一堆噪点）。
 * 换设备、换模型时这组值必须跟着模型走，所以从检索结果里取，而不是写死。
 */
const MODEL_PARAMS = (() => {
  try {
    const best = pickBestModel();
    if (best && best.params) return best.params;
  } catch { /* 检索失败就退回 Turbo 的默认值 */ }
  return { steps: 4, guidance: 0, width: 768, height: 1024 };
})();

/** 空闲多久回收 worker（毫秒）。回收后下一次出图要重新付一次上卡成本。 */
const IDLE_MS = Number(process.env.PF_AIGEN_IDLE_MS || 5 * 60 * 1000);
/** 出图超时。4 步通常 6~20 秒，给足余量但不至于挂死。 */
const GEN_TIMEOUT_MS = Number(process.env.PF_AIGEN_TIMEOUT_MS || 180000);

export class AigenError extends Error {
  constructor(message, stage) {
    super(message);
    this.name = "AigenError";
    this.stage = stage;
  }
}

/** 模型文件是否就位（缺文件时给明确提示，而不是等加载到一半才炸） */
/**
 * 模型是否就位。
 *
 * 原来这里认死 SDXL-Turbo 那 5 个文件名（`unet/diffusion_pytorch_model.fp16.safetensors`…）。
 * 现在模型是自动检索出来的，可能是任意一个 diffusers 模型 —— 有的只有 fp32、有的权重分片，
 * 继续认死文件名就会把**能用的模型误报成"文件不全"**（然后就无谓地下载 16 GB）。
 * 所以改成看"能不能加载"，而不是"文件名对不对"。
 *
 * ── 但别矫枉过正（这个坑刚踩过）──
 * 第一版改成"model_index.json 声明的组件目录全都要在"，结果把 SDXL-Turbo 判成了不可用：
 * 它声明里有 feature_extractor / image_encoder，而这两个对 text2img **不是必需**的
 * （实测缺着也能出图）。一个把好模型判死的检查，比没有检查更糟 —— 它会让站点
 * 以为自己没模型，然后去下一份 16 GB。所以这里分成"必需组件"和"可选组件"两档。
 */
const OPTIONAL_COMPONENTS = new Set([
  "feature_extractor",   // 安全过滤器的图像预处理，text2img 用不上
  "image_encoder",       // IP-Adapter / img2img 才需要
  "safety_checker",
  "controlnet",
  "image_processor",
  "prior",
]);

export function checkModel(modelDir = AIGEN_MODEL) {
  const indexPath = path.join(modelDir, "model_index.json");
  if (!existsSync(indexPath)) {
    return { dir: modelDir, exists: existsSync(modelDir), missing: ["model_index.json"], ready: false, class: null };
  }
  let idx = null;
  try { idx = JSON.parse(readFileSync(indexPath, "utf8")); } catch { /* 下面统一报 */ }
  if (!idx || typeof idx !== "object") {
    return { dir: modelDir, exists: true, missing: ["model_index.json 读不出来或不是合法 JSON"], ready: false, class: null };
  }
  // diffusers 的 model_index.json 形如：
  // { "_class_name": "StableDiffusionXLPipeline", "unet": ["diffusers","UNet2DConditionModel"], ... }
  const comps = Object.keys(idx).filter((k) => !k.startsWith("_") && Array.isArray(idx[k]));
  const required = comps.filter((c) => !OPTIONAL_COMPONENTS.has(c));
  const missing = required.filter((c) => !existsSync(path.join(modelDir, c)));
  // 主模型（SD 系叫 unet、新架构叫 transformer）+ vae 缺一不可；其余缺失只影响特定玩法
  const hasCore = ["unet", "transformer"].some((c) => existsSync(path.join(modelDir, c)));
  const hasVae = existsSync(path.join(modelDir, "vae"));
  return {
    dir: modelDir,
    exists: true,
    missing: hasCore ? missing : [...missing, "unet/transformer"],
    ready: missing.length === 0 && hasCore && hasVae,
    class: idx._class_name || null,
  };
}

/** 环境是否具备出图条件 */
export function envCheck() {
  const problems = [];
  // 纯命令名（如 "python"）不在这里判存在性 —— 交给 PATH，
  // 否则会误报"找不到出图用的 Python：python"。
  const isPath = AIGEN_PYTHON.includes(path.sep) || AIGEN_PYTHON.includes("/");
  if (isPath && !existsSync(AIGEN_PYTHON)) {
    problems.push(`找不到出图用的 Python：${AIGEN_PYTHON}（可用 PF_AIGEN_PYTHON 指定）`);
  }
  if (!existsSync(AIGEN_SCRIPT)) problems.push(`找不到 aigen.py：${AIGEN_SCRIPT}`);
  const m = checkModel();
  if (!m.ready) {
    problems.push(`模型不可用（${m.dir}）：缺 ${m.missing.join("、")}。` +
      `可由 PF_AIGEN_MODEL 指定目录，或让站点自动检索/供给见 /api/models`);
  }
  return { ok: problems.length === 0, problems, model: m };
}

/* ------------------------------------------------------------------ worker */

let worker = null;          // { proc, ready }
let pending = null;         // { resolve, reject }
let idleTimer = null;
let lastError = null;

function killIdleTimer() {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
}

function scheduleIdleKill() {
  killIdleTimer();
  idleTimer = setTimeout(() => {
    if (worker) {
      console.log("[aigen] worker 空闲超时，回收以释放显存");
      stopWorker();
    }
  }, IDLE_MS);
  // 不要因为这个定时器把进程吊住
  if (typeof idleTimer.unref === "function") idleTimer.unref();
}

export function stopWorker() {
  killIdleTimer();
  const w = worker;
  worker = null;
  if (pending) {
    pending.reject(new AigenError("worker 被停止", "stopped"));
    pending = null;
  }
  if (w?.proc && !w.proc.killed) {
    try { w.proc.stdin.write(JSON.stringify({ cmd: "exit" }) + "\n"); } catch { /* ignore */ }
    setTimeout(() => { try { w.proc.kill(); } catch { /* ignore */ } }, 1500);
  }
  return true;
}

function startWorker() {
  const env = envCheck();
  if (!env.ok) throw new AigenError(env.problems.join("；"), "env");

  const proc = spawn(AIGEN_PYTHON, [AIGEN_SCRIPT, "--serve"], {
    stdio: ["pipe", "pipe", "pipe"],
    // 把检索选中的模型路径传给 Python：不传的话它只认自己的默认路径，
    // 于是"自动识别到了更好的模型"这一步就白做了 —— JS 认出来了，Python 还在加载老的。
    env: { ...process.env, PF_AIGEN_MODEL: AIGEN_MODEL },
    windowsHide: true,
  });

  const state = { proc, ready: false };
  worker = state;

  let buf = "";
  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { console.warn("[aigen] 非 JSON 输出:", line.slice(0, 200)); continue; }

      if (msg.ready && msg.fatal === undefined) state.ready = true;

      if (pending) {
        const p = pending;
        pending = null;
        if (msg.ok) p.resolve(msg);
        else p.reject(new AigenError(msg.error || msg.fatal || "出图失败", "generate"));
      }
    }
  });

  proc.stderr.setEncoding("utf8");
  proc.stderr.on("data", (d) => {
    const s = String(d).trim();
    if (s) console.log("[aigen]", s.split("\n").slice(-2).join(" | "));
  });

  proc.on("exit", (code) => {
    if (worker === state) worker = null;
    if (pending) {
      const p = pending;
      pending = null;
      p.reject(new AigenError(`worker 退出（code=${code}）：${lastError || "无 stderr"}`, "crashed"));
    }
  });
  proc.on("error", (e) => {
    lastError = e.message;
    if (worker === state) worker = null;
  });

  return state;
}

/** 确保 worker 已就绪（已就绪则直接返回） */
async function ensureWorker() {
  if (worker?.ready) { scheduleIdleKill(); return worker; }
  const state = startWorker();
  // 等 ready 行；startWorker 里收到 ready 会置 state.ready
  const t0 = Date.now();
  while (!state.ready) {
    if (Date.now() - t0 > 240000) throw new AigenError("worker 启动超时（模型加载过慢）", "startup");
    if (worker !== state) throw new AigenError("worker 启动过程中退出", "startup");
    await new Promise((r) => setTimeout(r, 200));
  }
  scheduleIdleKill();
  return state;
}

/** 出图。prompt/out 必填，其余可选。 */
export async function generateImage({
  prompt, out,
  width = MODEL_PARAMS.width, height = MODEL_PARAMS.height,
  steps = MODEL_PARAMS.steps, seed = 0,
  guidance = MODEL_PARAMS.guidance,
}) {
  if (!prompt) throw new AigenError("缺少 prompt", "input");
  if (!out) throw new AigenError("缺少输出路径", "input");
  await mkdir(path.dirname(out), { recursive: true });

  await ensureWorker();
  scheduleIdleKill();

  // guidance 以前没发：Turbo 要 0、Qwen 要 2.5，不发就等于永远按 0 跑
  const msg = { cmd: "gen", prompt, out, width, height, steps, seed, guidance };
  const result = await new Promise((resolve, reject) => {
    pending = { resolve, reject };
    try {
      worker.proc.stdin.write(JSON.stringify(msg) + "\n");
    } catch (e) {
      pending = null;
      reject(new AigenError("写入 worker 失败：" + e.message, "ipc"));
      return;
    }
    setTimeout(() => {
      if (pending) {
        pending = null;
        reject(new AigenError(`出图超时（${GEN_TIMEOUT_MS}ms）`, "timeout"));
      }
    }, GEN_TIMEOUT_MS);
  });

  return result;
}

/** 中断：直接把 worker 杀掉（下一次出图会重新拉起） */
export function interrupt() {
  if (!worker) return false;
  stopWorker();
  return true;
}

/** 状态：给前端与健康检查用 */
export async function status() {
  const env = envCheck();
  return {
    running: env.ok && worker?.ready === true,
    // ready 表示"环境可用"（Python、脚本、模型文件都在位），与 worker 是否热着无关。
    // 注意别写成 env.ready —— envCheck() 返回的是 {ok, problems, model}，
    // ready 在 env.model 上。写错会恒为 undefined，于是 worker 空闲回收后
    // 前端那句 if (!data.ready) 会误报"本地出图环境不可用"。
    ready: env.ok,
    modelReady: env.model.ready,
    workerUp: worker?.ready === true,
    engine: "diffusers/SDXL-Turbo",
    modelDir: env.model.dir,
    missing: env.model.missing,
    problems: env.problems,
    python: AIGEN_PYTHON,
    message: env.ok
      ? (worker?.ready ? "本地出图就绪（已预热）" : "本地出图就绪（首次出图需加载模型，约 20 秒）")
      : env.problems.join("；"),
  };
}

/** 预热：把模型加载进 worker，避免用户第一次点 AI 背景时等 20 秒 */
export async function preload() {
  try {
    await ensureWorker();
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e.message };
  }
}
