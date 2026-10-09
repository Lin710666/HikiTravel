/**
 * models.mjs，本地画图模型的「自动发现 → 自动拉起 → 按需供给」。
 *
 * 要解决的事：用户不该为了"能出图"去手工翻目录、改路径、记文件名。
 * 所以这里做三件事，顺序就是它们的使用顺序：
 *   1. discoverModels()，把本机上现成的画图模型全找出来
 *   2. pickBestModel()，挑一个"此刻真的能用"的，质量高的优先
 *   3. provisionPlan()，一个都没有时，说清楚"缺什么、要下多少、下完能不能跑"
 *
 * ── 为什么非要区分两种布局（这是整个文件里最要紧的一点）──
 *   · diffusers：目录里有 model_index.json。aigen 的 Python worker 能直接
 *     from_pretrained 加载，找到就能跑。
 *   · ComfyUI  ：权重按类别摊在 diffusion_models / text_encoders / vae 里。
 *     只有 ComfyUI 认得这种摆法；**没有 ComfyUI 的话，它就是一堆用不了的 safetensors**。
 *   不区分会得到一个很坏的结果：兴冲冲告诉用户"找到 Qwen 了"，然后加载失败。
 *   所以 usable 不是"文件在不在"，而是"现在这个环境能不能真的把它跑起来"。
 *
 * ── 关于下载 ──
 *   走 curl（不是 hf 库）：实测本机 hf 库下载会卡死在 0 字节
 *   （大文件被 302 甩到 cas-bridge.xethub.hf.co，那个域名在本机 DNS 间歇性失败），
 *   而 curl 断点续传能稳定跑到 4.5 MB/s。注意不再踩第二遍。
 */
import { existsSync, readdirSync, statSync, mkdirSync, createWriteStream, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { REPO_ROOT, SITE_ROOT, findComfyRoot, findComfyPython, findPython } from "./paths.mjs";

/** 镜像端点：官方 huggingface.co 在本机不通，默认走 hf-mirror。 */
const ENDPOINT = process.env.PF_HF_ENDPOINT || "https://hf-mirror.com";

/**
 * 一个都没有时下这个，与项目文档（skills/image-layer）里记的是同一套，
 * 只是这里把"从哪下"也补上了。int8 量化版是为 8 GB 显存准备的。
 */
export const QWEN_TARGETS = [
  { dir: "diffusion_models", file: "qwen_image_2.1_int8_convrot.safetensors", gb: 6.76 },
  { dir: "text_encoders", file: "qwen3vl_8b_int8_convrot.safetensors", gb: 8.71 },
  { dir: "vae", file: "qwen_image_2.1_vae_bf16.safetensors", gb: 0.63 },
];
export const QWEN_REPO = "Comfy-Org/Qwen-Image-2.1";

// ---------------------------------------------------------------- 布局识别
const LAYOUTS = [
  {
    kind: "diffusers",
    detect: (dir) => existsSync(path.join(dir, "model_index.json")),
    // diffusers 布局只要解释器里有 diffusers 就能加载，和 ComfyUI 无关
    why: () => null,
  },
  {
    kind: "comfyui",
    detect: (dir) => {
      const weights = existsSync(path.join(dir, "diffusion_models")) || existsSync(path.join(dir, "unet"));
      const vae = existsSync(path.join(dir, "vae"));
      const text = existsSync(path.join(dir, "text_encoders")) || existsSync(path.join(dir, "clip"));
      return weights && vae && text;
    },
    why: (ctx) => (ctx.comfyRoot ? null : "需要 ComfyUI 才能加载（本机没检测到 ComfyUI）"),
  },
];

/** 体积/质量评分：名字里带什么，就大概值多少，用来决定"多个模型时用哪个"。 */
const QUALITY = [
  { re: /qwen[-_ .]?image/i, score: 100, family: "Qwen-Image" },
  { re: /flux/i, score: 90, family: "FLUX" },
  { re: /sdxl|sd[-_ .]?xl/i, score: 60, family: "SDXL" },
  { re: /(^|[^a-z])sd[-_ .]?(turbo|1\.5|2\.1|3)/i, score: 30, family: "SD" },
];

/** 采样参数按模型族给：Turbo 是 4 步，Qwen/SDXL 是常规步数。写错会出废图。 */
function inferParams(name) {
  if (/qwen[-_ .]?image/i.test(name)) return { steps: 20, guidance: 2.5, width: 1024, height: 1024 };
  if (/turbo/i.test(name)) return { steps: 4, guidance: 0, width: 768, height: 1024 };
  return { steps: 25, guidance: 7, width: 768, height: 1024 };
}

function qualityOf(name) {
  for (const q of QUALITY) if (q.re.test(name)) return q;
  return { score: 10, family: "未知" };
}

function dirSizeGB(dir, depth = 0) {
  if (depth > 3) return 0;
  let bytes = 0;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    try {
      if (e.isDirectory()) bytes += dirSizeGB(p, depth + 1) * 1024 ** 3;
      else if (e.isFile()) bytes += statSync(p).size;
    } catch { /* 权限/竞态：跳过这一个，不要因此判整个目录不可用 */ }
  }
  return bytes / 1024 ** 3;
}

/** 搜索根：环境变量 → 仓库内 → ComfyUI 里 → HF 缓存。全是相对/环境推导，不写死盘符。 */
function searchRoots() {
  const comfyRoot = findComfyRoot();
  const roots = [
    process.env.PF_MODEL_DIR,
    path.join(REPO_ROOT, "models"),
    path.join(SITE_ROOT, "models"),
    comfyRoot && path.join(comfyRoot, "ComfyUI", "models"),
    comfyRoot && path.join(comfyRoot, "models"),
    path.join(os.homedir(), ".cache", "huggingface", "hub"),
    path.join(os.homedir(), "models"),
  ].filter(Boolean);
  return [...new Set(roots)].filter((r) => existsSync(r));
}

// 扫描要读盘，而 /api/health 会被高频调用（压测里 1 秒几百次），
// 不缓存的话"看一眼状态"就会变成磁盘 IO 本身成了接口耗时。
let scanCache = { at: 0, data: null };
const SCAN_TTL_MS = 30000;

/** 下载完/手工放了模型之后，让下一次查询重新扫描。 */
export function invalidateModelCache() { scanCache = { at: 0, data: null }; }

/**
 * 把本机上现成的画图模型全找出来。
 * 返回的每一项都带 usable，那是"现在能不能真的跑起来"，不是"文件在不在"。
 */
export function discoverModels({ fresh = false } = {}) {
  if (!fresh && scanCache.data && Date.now() - scanCache.at < SCAN_TTL_MS) return scanCache.data;
  const ctx = { comfyRoot: findComfyRoot(), comfyPython: findComfyPython() };
  const out = [];
  const seen = new Set();

  const consider = (dir, name) => {
    const key = path.resolve(dir);
    if (seen.has(key)) return;
    let layout = null;
    for (const l of LAYOUTS) {
      try { if (l.detect(dir)) { layout = l; break; } } catch { /* 读不动就当不是 */ }
    }
    if (!layout) return;
    seen.add(key);
    const why = layout.why(ctx);
    const q = qualityOf(name);
    const gb = dirSizeGB(dir);
    out.push({
      id: `${layout.kind}:${name}`,
      name,
      family: q.family,
      kind: layout.kind,
      root: dir,
      sizeGB: Number(gb.toFixed(2)),
      score: q.score,
      usable: !why && gb > 0.05,          // 空壳目录不算可用
      blockedReason: why,
      params: inferParams(name),
    });
  };

  for (const root of searchRoots()) {
    let entries = [];
    try { entries = readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const p = path.join(root, e.name);
      // HF 缓存是 models--org--name/snapshots/<sha>/ 这种结构，要往里走一层
      if (e.name.startsWith("models--")) {
        const snaps = path.join(p, "snapshots");
        if (existsSync(snaps)) {
          let revs = [];
          try { revs = readdirSync(snaps); } catch { /* ignore */ }
          for (const rev of revs) consider(path.join(snaps, rev), e.name.replace(/^models--/, "").replace(/--/g, "/"));
        }
        continue;
      }
      consider(p, e.name);
    }
    // 搜索根本身也可能就是一个模型目录（PF_MODEL_DIR 直接指模型时）
    consider(root, path.basename(root));
  }

  // 排序：能用的在前 → 质量高的在前 → 体积大的在前（同族里通常大的更完整）
  const sorted = out.sort((a, b) =>
    (Number(b.usable) - Number(a.usable)) || (b.score - a.score) || (b.sizeGB - a.sizeGB));
  scanCache = { at: Date.now(), data: sorted };
  return sorted;
}

/** 挑一个此刻最能用的；一个都没有返回 null。 */
export function pickBestModel() {
  const all = discoverModels();
  return all.find((m) => m.usable) || null;
}

/** 给 /api/health 与前端看的汇总状态。 */
export function modelStatus() {
  const models = discoverModels();
  const best = models.find((m) => m.usable) || null;
  return {
    found: models.length,
    usable: models.filter((m) => m.usable).length,
    comfyRoot: findComfyRoot(),
    selected: best,
    models: models.map((m) => ({
      name: m.name, kind: m.kind, sizeGB: m.sizeGB, usable: m.usable,
      blockedReason: m.blockedReason, root: m.root,
    })),
  };
}

/**
 * 一个都没有时：说清楚接下来该干什么，而不是闷头下 16 GB。
 *
 * 这里最关键的一条判断是 runtime，如果本机连 ComfyUI 都没有，
 * 那么 ComfyUI 格式的 Qwen 权重下完**照样跑不起来**，那就不该假装"自动下载"能解决问题，
 * 而是如实报告"先得有 ComfyUI"。这正是上一层只判断"文件在不在"会埋的雷。
 */
export function provisionPlan() {
  const best = pickBestModel();
  if (best) return { action: "use", model: best, targets: [], totalGB: 0 };

  const comfyRoot = findComfyRoot();
  const targetDir = comfyRoot
    ? path.join(comfyRoot, "ComfyUI", "models")
    : path.join(REPO_ROOT, "models", "qwen-image-2.1");
  return {
    action: "download",
    model: "Qwen-Image-2.1",
    repo: QWEN_REPO,
    surface: ENDPOINT,
    targets: QWEN_TARGETS.map((t) => {
      const want = path.join(targetDir, t.dir);
      const file = path.join(want, t.file);
      return { ...t, url: `${ENDPOINT}/${QWEN_REPO}/resolve/main/${t.dir}/${t.file}`, dest: file, have: existsSync(file) };
    }),
    totalGB: Number(QWEN_TARGETS.reduce((s, t) => s + t.gb, 0).toFixed(2)),
    destRoot: targetDir,
    runtime: comfyRoot ? "comfyui" : "missing-comfyui",
    warning: comfyRoot
      ? null
      : "下载后还需要 ComfyUI 才能真正出图（本机没检测到）。权重先落盘、之后挂进 extra_model_paths.yaml 也能用，但只有权重本身出不了图。",
  };
}

// ---------------------------------------------------------------- 下载
let job = null;   // 同一时间只允许一个下载任务

/** 当前下载任务的进度快照；没有任务时 { running: false }。 */
export function provisionProgress() {
  if (!job) return { running: false };
  const done = job.targets.reduce((s, t) => {
    try { return s + (existsSync(t.dest) ? statSync(t.dest).size : 0); } catch { return s; }
  }, 0);
  return {
    running: true,
    startedAt: job.startedAt,
    index: job.index,
    total: job.targets.length,
    current: job.targets[job.index] ? job.targets[job.index].file : null,
    bytes: done,
    totalBytes: job.totalBytes,
    percent: job.totalBytes ? Math.min(100, Math.round((done / job.totalBytes) * 1000) / 10) : 0,
    finished: job.finished,
    error: job.error,
  };
}

function downloadOne(t, log) {
  return new Promise((resolve, reject) => {
    mkdirSync(path.dirname(t.dest), { recursive: true });
    // -C - 断点续传；--retry-all-errors 兜住本机那个间歇性 DNS 抽风
    const args = ["-L", "-C", "-", "--retry", "10", "--retry-delay", "5", "--retry-all-errors",
      "--max-time", "7200", "-o", t.dest, t.url];
    const p = spawn("curl", args, { windowsHide: true });
    let err = "";
    p.stderr.on("data", (d) => { err += d; });
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`curl 退出 ${code}：${err.slice(-200)}`))));
  });
}

/**
 * 启动后台供给。
 * 已有的文件会跳过（断点续传），所以中断后重跑不会从头再来。
 * 返回 false 表示"没有可下的东西"或"已经有任务在跑"。
 */
export function startProvision({ log = () => { } } = {}) {
  if (job && !job.finished) return false;
  const plan = provisionPlan();
  if (plan.action !== "download") return false;

  job = {
    startedAt: new Date().toISOString(),
    targets: plan.targets.filter((t) => !t.have),
    totalBytes: plan.targets.reduce((s, t) => s + t.gb * 1024 ** 3, 0),
    index: 0,
    finished: false,
    error: null,
  };
  if (!job.targets.length) { job.finished = true; return false; }

  (async () => {
    try {
      for (let i = 0; i < job.targets.length; i++) {
        job.index = i;
        log(`下载 ${job.targets[i].file}（${job.targets[i].gb} GB）…`);
        await downloadOne(job.targets[i], log);
        log(`完成 ${job.targets[i].file}`);
      }
      log("全部权重下载完成");
    } catch (e) {
      job.error = e.message;
      log(`下载失败：${e.message}`);
    } finally {
      job.finished = true;
    }
  })();

  return true;
}

/* ================================================================ ComfyUI 引擎
   ComfyUI 布局的模型（diffusion_models + text_encoders + vae）只有 ComfyUI 认，
   而 ComfyUI 是个**要手动点启动器**的常驻服务：不应要求用户手动操作。
   下面两段把它补齐：有就拉起来，没有就用国内镜像装。
   ============================================================================ */

/** ComfyUI 的 HTTP 端口（问它的 /system_stats 就能确认活着）。 */
const COMFY_HOST = () => process.env.COMFY_HOST || "127.0.0.1:8188";

export async function comfyUp(host = COMFY_HOST(), timeoutMs = 2500) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    const r = await fetch(`http://${host}/system_stats`, { signal: ctl.signal, cache: "no-store" });
    clearTimeout(t);
    return r.ok;
  } catch { return false; }
}

let comfyStarting = null;   // 并发调用只拉一次，别同时起好几个

/**
 * 确保 ComfyUI 在跑。已装就拉起，没装就如实说"要装"。
 *
 * 8 GB 显存下必须带 --lowvram：Qwen-Image-2.1 三件套约 16 GB，
 * 不开这个参数根本起不来（项目文档里记的死规矩）。
 */
export async function ensureComfyRunning({ waitMs = 180000, log = () => {} } = {}) {
  const host = COMFY_HOST();
  if (await comfyUp(host)) return { ok: true, already: true };

  const root = findComfyRoot();
  if (!root) {
    return {
      ok: false, reason: "no-comfy", action: "install",
      message: "本机没有 ComfyUI（ComfyUI 布局的模型必须靠它才能加载）。" +
        "可以让站点用国内镜像装一个，见 /api/models 的 installComfyUI。",
    };
  }

  if (!comfyStarting) {
    comfyStarting = (async () => {
      const py = findComfyPython() || process.env.PF_PYTHON || findPython();
      const main = existsSync(path.join(root, "ComfyUI", "main.py"))
        ? path.join(root, "ComfyUI", "main.py")
        : path.join(root, "main.py");
      const port = host.split(":")[1] || "8188";
      const args = ["-s", main, "--port", String(port)];
      if (process.env.PF_COMFY_LOWVRAM !== "0") args.push("--lowvram");
      log(`拉起 ComfyUI：${py} ${args.join(" ")}`);
      const p = spawn(py, args, {
        cwd: path.dirname(main),
        detached: true,               // 得活得比本进程久
        stdio: "ignore",
        windowsHide: true,
        env: { ...process.env, PF_COMFY_ROOT: root },
      });
      p.unref();
      const t0 = Date.now();
      while (Date.now() - t0 < waitMs) {
        await new Promise((r) => setTimeout(r, 2500));
        if (await comfyUp(host)) return { ok: true, spawned: true, pid: p.pid, waitedMs: Date.now() - t0 };
      }
      return { ok: false, reason: "timeout", message: `已尝试拉起 ComfyUI，但 ${Math.round(waitMs / 1000)}s 内没起来（看它的控制台输出排查）` };
    })().finally(() => { setTimeout(() => { comfyStarting = null; }, 5000); });
  }
  return comfyStarting;
}

/**
 * ComfyUI 的下载源。**GitHub 直连在本机不通**（实测 curl 返回 000），
 * 所以先把国内镜像排前面，真通了再用官方地址兜底。
 */
export const COMFY_SOURCES = [
  { name: "gitclone.com 镜像", url: "https://gitclone.com/github.com/comfyanonymous/ComfyUI.git" },
  { name: "gitee 镜像", url: "https://gitee.com/mirrors/ComfyUI.git" },
  { name: "GitHub 官方", url: "https://github.com/comfyanonymous/ComfyUI.git" },
];

/** 装 ComfyUI 的计划（不动手，只说明白要干什么）。 */
export function comfyInstallPlan() {
  const dest = path.join(REPO_ROOT, "ComfyUI");
  return {
    installed: existsSync(dest),
    dest,
    sources: COMFY_SOURCES.map((s) => s.name),
    steps: [
      "git clone --depth 1（按上面的顺序挑第一个能连上的源）",
      "建独立 venv（--system-site-packages，复用本机已有的 torch，不重复下 2.5 GB）",
      "pip install -r requirements.txt（清华源，只装缺的）",
    ],
    note: "依赖装进它自己的 venv，不会动系统 Python 里的 torch。",
  };
}

/** 跑一条命令，收全部输出。 */
function runCmd(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { windowsHide: true, ...opts });
    let out = "", err = "";
    p.stdout && p.stdout.on("data", (d) => { out += d; });
    p.stderr && p.stderr.on("data", (d) => { err += d; });
    p.on("error", (e) => resolve({ code: -1, out, err: err + e.message }));
    p.on("close", (code) => resolve({ code, out, err }));
  });
}

/**
 * 用国内镜像把 ComfyUI 装到 <仓库>/ComfyUI。
 *
 * 这是个重操作（克隆 + 装依赖，几分钟），所以**不自动跑**，
 * 由 /api/models 显式触发。装完不会自动启动，交给 ensureComfyRunning。
 */
export async function installComfyUI({ log = () => {} } = {}) {
   // 占位，避免误用

  const dest = path.join(REPO_ROOT, "ComfyUI");
  if (existsSync(path.join(dest, "main.py"))) return { ok: true, already: true, dest };

  let cloned = null;
  for (const src of COMFY_SOURCES) {
    log(`尝试 ${src.name} …`);
    const r = await runCmd("git", ["clone", "--depth", "1", src.url, dest]);
    if (r.code === 0 && existsSync(path.join(dest, "main.py"))) { cloned = src.name; break; }
    log(`${src.name} 失败：${(r.err || r.out || "").trim().split("\n").slice(-1)[0] || "未知原因"}`);
    try { rmSync(dest, { recursive: true, force: true }); } catch { /* 清掉半个克隆 */ }
  }
  if (!cloned) return { ok: false, message: "所有镜像都没拉下来（网络问题，或 git 不可用）" };
  log(`已从「${cloned}」克隆完成`);

  // 独立 venv + 复用系统包：ComfyUI 的 requirements 里有 torch，
  // 直接装进系统环境会把本机那份 2.13+cu126 覆盖掉，那是别的东西在用的。
  const py = process.env.PF_PYTHON || findPython();
  const venv = path.join(dest, ".venv");
  log("建独立 venv（--system-site-packages，复用本机 torch）…");
  const mk = await runCmd(py, ["-m", "venv", "--system-site-packages", venv]);
  if (mk.code !== 0) return { ok: false, message: "建 venv 失败：" + (mk.err || mk.out).slice(-200) };

  const vpy = process.platform === "win32" ? path.join(venv, "Scripts", "python.exe") : path.join(venv, "bin", "python");
  log("装依赖（清华源，已装过的会跳过）…");
  const pip = await runCmd(vpy, ["-m", "pip", "install", "-r", path.join(dest, "requirements.txt"),
    "-i", "https://pypi.tuna.tsinghua.edu.cn/simple", "--quiet"], { timeoutMs: 1800000 });
  const ok = pip.code === 0;
  log(ok ? "依赖装好了" : `依赖安装有问题：${(pip.err || "").slice(-200)}`);
  return {
    ok, dest, source: cloned, venv: vpy, python: vpy,
    message: ok
      ? "ComfyUI 装好了。它还没启动：出图时会被自动拉起（见 ensureComfyRunning）。"
      : "克隆成功但依赖没装全，可能需要手动看一眼 requirements 的报错。",
  };
}
