/**
 * paths.mjs，全项目「外部程序在哪」的唯一来源。
 *
 * 为什么要单独抽这一个文件：
 * 项目原来把本机路径写死在十几处，`E:\devenv\Scripts\python.exe`、
 * `E:\ComfyUI_windows_portable\python_embeded`、`E:\deepseck\site`…
 * 换一台机器、换一个盘符就整条链路全废，而且报错信息指向的是**别人电脑上的目录**，
 * 拿到报错的人根本查不出所以然（表现为"接口 200 但出图全废"这种最难查的样子）。
 *
 * 现在所有外部依赖的查找统一按这个顺序，谁 clone 下来都不需要改代码：
 *   1. 显式环境变量，部署的人说了算，最高优先级
 *   2. 项目内的相对位置，跟着仓库走（.venv 之类）
 *   3. 系统环境变量拼出来的常见安装位置，不写死盘符，Windows 装在 D: 也对
 *   4. PATH，交给操作系统解析
 *
 * 注意：这里只负责"找"，找不到就返回 null / 交给 PATH，不抛异常，
 * 调用方各自决定"找不到"是致命错误还是降级。
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 站点根（本文件所在目录，即 posterforge/）。 */
export const SITE_ROOT = path.dirname(fileURLToPath(import.meta.url));
/** 仓库根，与站点同级的 renderer/、hikitravel/ 都在这一层。 */
export const REPO_ROOT = path.dirname(SITE_ROOT);

// ---------------------------------------------------------------- 系统目录
// 全部从环境变量取。写死 "C:\\Windows" 会让装在非 C 盘的机器直接失效。
const WINDIR = process.env.WINDIR || process.env.SystemRoot || "";
const PROGRAM_FILES = [
  process.env.ProgramFiles,
  process.env.ProgramW6432,
  process.env["ProgramFiles(x86)"],
].filter(Boolean);
const LOCALAPPDATA = process.env.LOCALAPPDATA || "";

/**
 * 从候选里挑第一个「存在」的。
 * 纯命令名（不含分隔符）直接返回，交给 PATH 解析，这是有意的：
 * 存在性由运行时决定，这里提前 existsSync 反而会把 PATH 里的命令判死。
 */
function firstUsable(candidates) {
  for (const c of candidates) {
    if (!c) continue;
    if (c.includes(path.sep) || c.includes("/")) {
      if (existsSync(c)) return c;
    } else {
      return c;
    }
  }
  return null;
}

/** 项目内虚拟环境的解释器（跟着仓库走，换机器不用改代码）。 */
function venvPython(root) {
  if (!root) return [];
  return [
    path.join(root, ".venv", "Scripts", "python.exe"),
    path.join(root, ".venv", "bin", "python"),
  ];
}

// ---------------------------------------------------------------- Python
/**
 * 主 Python 解释器（Pillow 在这里）。
 *
 * 不再默认指向 `E:\devenv\Scripts\python.exe`：那是某台机器的私有虚拟环境，
 * 别人机器上没有，报错还会说"没装 Pillow"，误导排查方向。
 */
export function findPython() {
  return firstUsable([
    process.env.PF_PYTHON,
    // 项目自带的虚拟环境优先于全局
    ...venvPython(SITE_ROOT),
    ...venvPython(REPO_ROOT),
    // 便携式 Python（有人把解释器解压在项目边上）
    path.join(SITE_ROOT, "python", "python.exe"),
    path.join(REPO_ROOT, "python", "python.exe"),
    "python",
    "python3",
    "py",
  ]) || "python";
}

/** 引擎目录（renderer/ 或旧的 poster-forge/），找不到就给预期路径好让报错看得懂。 */
export function findForgeRoot() {
  if (process.env.PF_FORGE_ROOT && existsSync(process.env.PF_FORGE_ROOT)) return process.env.PF_FORGE_ROOT;
  for (const name of ["renderer", "poster-forge"]) {
    const p = path.join(REPO_ROOT, name);
    if (existsSync(path.join(p, "render.py"))) return p;
  }
  return path.join(REPO_ROOT, "renderer");
}

// ---------------------------------------------------------------- ComfyUI
/** ComfyUI 便携版根目录（找不到返回 null），Qwen 那类权重要靠它才认得。 */
export function findComfyRoot() {
  const roots = [
    process.env.PF_COMFY_ROOT,
    ...PROGRAM_FILES.map((d) => path.join(d, "ComfyUI_windows_portable")),
    ...(LOCALAPPDATA ? [path.join(LOCALAPPDATA, "ComfyUI_windows_portable")] : []),
    ...(WINDIR ? [path.join(WINDIR, "..", "ComfyUI_windows_portable")] : []),
    path.join(SITE_ROOT, "ComfyUI_windows_portable"),
    path.join(REPO_ROOT, "ComfyUI_windows_portable"),
    path.join(SITE_ROOT, "ComfyUI"),
    path.join(REPO_ROOT, "ComfyUI"),
  ].filter(Boolean);
  for (const r of roots) {
    // 便携版有 run_nvidia_gpu.bat；源码版有 main.py，认任意一个都算找到了
    if (existsSync(path.join(r, "main.py")) || existsSync(path.join(r, "run_nvidia_gpu.bat"))
      || existsSync(path.join(r, "ComfyUI", "main.py"))) return r;
  }
  return null;
}

/**
 * ComfyUI 便携版自带的解释器，只在 HEIC/HEIF 解不开码时借用
 * （便携版里 av / cv2 / PIL 都是现成的）。
 *
 * 位置由 `PF_COMFY_ROOT` 指定；没指定就在系统盘上的常见位置找一遍。
 * 找不到不报错：调用方只在"主解释器解不开 HEIC"时才需要它。
 */
export function findComfyPython() {
  const explicit = process.env.PF_HEIC_PYTHON || process.env.PF_COMFY_PYTHON;
  const roots = [
    process.env.PF_COMFY_ROOT,
    ...PROGRAM_FILES.map((d) => path.join(d, "ComfyUI_windows_portable")),
    ...(LOCALAPPDATA ? [path.join(LOCALAPPDATA, "ComfyUI_windows_portable")] : []),
    ...(WINDIR ? [path.join(WINDIR, "..", "ComfyUI_windows_portable")] : []),
    path.join(SITE_ROOT, "ComfyUI_windows_portable"),
    path.join(REPO_ROOT, "ComfyUI_windows_portable"),
  ].filter(Boolean);
  return firstUsable([
    explicit,
    ...roots.flatMap((r) => [
      path.join(r, "python_embeded", "python.exe"),
      path.join(r, "python_embedded", "python.exe"),
    ]),
  ]);
}

// ---------------------------------------------------------------- Ollama
/**
 * Ollama 可执行文件。
 * 原来两个候选都写死了 `C:\Program Files`，装在别的盘就找不到。
 */
export function findOllama() {
  return firstUsable([
    process.env.PF_OLLAMA_BIN,
    ...(LOCALAPPDATA ? [path.join(LOCALAPPDATA, "Programs", "Ollama", "ollama.exe")] : []),
    ...PROGRAM_FILES.map((d) => path.join(d, "Ollama", "ollama.exe")),
    "ollama",
  ]);
}

// ---------------------------------------------------------------- 浏览器
/**
 * 无头浏览器（verify / shot / drive 那批脚本截图用）。
 *
 * 这些脚本原来各自把 Edge / Chrome 的安装路径抄了一遍并写死 C 盘。
 * 现在统一从这里取：`PF_BROWSER` 优先，然后按系统目录拼常见安装位置。
 *
 * 返回 null 表示一个都没找到，调用方给一句人能看懂的提示，别默默失败。
 */
export function findBrowser() {
  return firstUsable([
    process.env.PF_BROWSER,
    ...PROGRAM_FILES.flatMap((d) => [
      path.join(d, "Microsoft", "Edge", "Application", "msedge.exe"),
      path.join(d, "Google", "Chrome", "Application", "chrome.exe"),
    ]),
    ...(LOCALAPPDATA ? [
      path.join(LOCALAPPDATA, "Microsoft", "Edge", "Application", "msedge.exe"),
      path.join(LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
    ] : []),
  ]);
}

/**
 * 找浏览器，找不到就抛出人能看懂的错。
 * 比"静默用一个不存在的 exe"好得多：那种表现是脚本卡住，没有任何提示。
 */
export function requireBrowser() {
  const bin = findBrowser();
  if (!bin) {
    throw new Error("找不到 Edge / Chrome，可用环境变量 PF_BROWSER 指定浏览器路径");
  }
  return bin;
}

/** 旅游规划后端（门户 /wenlv/ 指向它）。目录名在历史上改过，这里两个都认。 */
export function findWenlvBackend() {
  for (const name of ["hikitravel", "HikiTravel", "HikiTravel-main-repair"]) {
    const p = path.join(REPO_ROOT, name, "backend");
    if (existsSync(p)) return p;
  }
  return path.join(REPO_ROOT, "hikitravel", "backend");
}
