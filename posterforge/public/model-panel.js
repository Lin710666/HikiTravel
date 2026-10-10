/**
 * model-panel.js：模型设置面板，把 DeepSeek Harness 网页端的「模型」设置页搬到本
 * 项目的原生 JS 环境里。
 *
 * 为什么是手写 DOM：PosterForge 是零运行时依赖、没有构建步骤的 vanilla 项目，为了
 * 一个面板把 React 拉进来，等于把整站的加载方式（打包、运行时、版本）全换一遍。所
 * 以 DSH 那边的组件状态（useState/useMemo）在这里都变成"改 state 再 render()"。
 *
 * 样式一律交给 model-panel.css（类名前缀 pfmp_），本文件不写任何内联样式：颜色、
 * 圆角、间距都在那份 CSS 里，重复一份必然会和它走偏。
 *
 * 与 DSH 的四处不同，都是本项目特有的：
 *   1. 本机 Ollama 是列表里的第一张卡，id 是空串。它不是 /api/providers 意义上的
 *      服务商，所以它的保存走 /api/settings（copy / vision / drawingModel）。
 *   2. 每张卡上多了「使用」按钮，用来切换当前生效的服务商。DSH 里这个选择在对话
 *      框旁边的模型选择器上，本项目没有那个选择器。
 *   3. 模型的高级设置里多了「支持读图」开关，它写的是模型的 input 数组；服务端据
 *      此推出 visionFromLlm（见 brain.mjs 的 resolveActiveModel）。
 *   4. 「获取可用模型」走本项目的 /api/providers/fetch-models：密钥不出服务端，由它
 *      代问服务商。候选框比 DSH 多一个「取消全选」，DSH 那边是一个开关按钮。
 *
 * 服务端有两个坑，这里必须绕开：
 *   a. POST /api/providers 里的 providers 是整份替换（brain.mjs 的 saveProviders 拿
 *      incoming.providers 重建整张表），所以每次提交都要带上全部服务商。只带被改动
 *      的那一个，别的服务商会被直接删掉。
 *   b. activeModel 缺省时服务端会当成"切回本机"，所以每次 POST 都要显式带上当前的
 *      activeModel，哪怕这次只是改了个显示名称。
 *
 * 暴露：window.PFModelPanel.mount(el) / window.PFModelPanel.reload()
 */
(function () {
  "use strict";

  /* ------------------------------------------------------------------ 文案 */
  // 中文键值对着 DSH 的语言包里同名的那几条抄，免得同一件事在两边叫两个名字。
  var T = {
    title: "模型",
    intro: "填入各提供方的 API 密钥即可使用其模型。本机 Ollama 也在下面的列表里，点「使用」随时切回来。",
    loading: "读取中…",
    loadFailed: "加载服务商目录失败",
    retry: "重试",
    ollamaDown: "没连上本机 Ollama，本机模型下拉可能是空的，先看看 ollama 有没有在跑。",
    active: "当前使用中",
    use: "使用",
    inUse: "当前",
    edit: "编辑",
    remove: "删除",
    cancel: "取消",
    apply: "保存",
    applying: "保存中…",
    create: "创建提供方",
    creating: "创建中…",
    keyInput: "API 密钥",
    keyPlaceholder: "输入 API 密钥",
    // 这处占位文案照抄 DSH：明文密钥从不回传，框里永远是空的，只能靠这句话告诉
    // 用户"密钥其实还在"，否则会以为配置丢了而反复重填。
    keyStored: "已配置，输入新值可替换",
    keyClear: "清除",
    keyClearPending: "保存后会清除已配置的密钥。",
    keyClearConfirm: "确定清除已保存的 API 密钥？\n清除后这个服务商就调不通，需要重新填。",
    keyConfigured: "API 密钥已配置",
    keyMissing: "API 密钥缺失",
    baseUrl: "接口地址",
    baseUrlDefault: "提供方默认",
    deepseekBaseUrl: "https://api.deepseek.com",
    customBaseUrlPlaceholder: "https://gateway.example/v1",
    localName: "本机 Ollama",
    localCopy: "对话模型",
    localVision: "读图模型",
    localDrawing: "绘图模型",
    localEmpty: "本机没有可用的模型（先 ollama pull）",
    visionEmpty: "本机没有可读图的模型",
    drawingAuto: "自动挑选（推荐）",
    drawingEmpty: "本机没有绘图模型",
    localInactive: "当前「使用中」的是外部服务商，对话模型与读图模型要切回本机后才会写入。",
    drawingActive: "当前生效的绘图模型：",
    drawingSwitched: "已保存。绘图模型切换为 ",
    drawingSwitchedTail: "，下次出图生效。",
    models: "模型",
    modelsEmpty: "还没有模型，点下面的「添加模型」加一个。",
    modelId: "模型 ID",
    modelName: "显示名称",
    modelAdvanced: "高级设置",
    contextWindow: "上下文窗口",
    maxTokens: "最大输出 token",
    modelVision: "支持读图",
    modelVisionHint: "勾上表示这个模型能读图。只有它正好是「使用中」的那个模型时，这个勾才决定 visionFromLlm，也就是读图走模型自带的视觉、而不是本机视觉模型。",
    addModel: "添加模型",
    removeModel: "删除模型",
    fetchModels: "获取可用模型",
    fetching: "获取中…",
    // 三条禁用原因分开写：按钮为什么点不动要一眼看得出来，笼统写一句"暂不支持"会被
    // 当成按钮坏了，而这三件事用户自己都能解决。
    fetchNeedsProvider: "先保存这个提供方，再回来拉取它有哪些模型。",
    fetchNeedsBaseUrl: "先填接口地址，拉取要知道去问谁。",
    fetchNeedsKey: "先配密钥，拉取要带着它去问服务商。",
    fetchHint: "向服务商问一次它支持哪些模型，勾选后加进下面的列表。",
    fetchTitle: "获取可用模型",
    fetchDescription: "勾选要加入的模型。已经在本列表里的那几条也会勾上并标出来，添加时按 id 跳过，不会重复。",
    fetchSearch: "搜索模型",
    fetchSelectAll: "全选",
    fetchDeselectAll: "取消全选",
    fetchNoMatch: "没有匹配的模型。",
    fetchEmpty: "服务商没有返回任何模型。",
    fetchExisting: "已在列表",
    fetchAdopt: "添加选中",
    fetchFailed: "拉取失败，没有拿到可用的响应。",
    modelIdRequired: "模型 ID 不能为空。",
    modelIdDuplicate: "模型 ID 不能重复。",
    capacityInvalid: "容量要填数字，可以带 K 或 M 后缀，例如 256K、1M。",
    add: "添加提供方",
    addUnsupported: "没有可添加的内置提供方，用右边的「添加自定义提供方」。",
    customAdd: "添加自定义提供方",
    customTitle: "自定义提供方",
    customRoute: "Provider ID",
    customRouteHint: "以小写字母开头的标识，在请求里唯一标识该提供方，并用来派生凭据名。",
    customRouteInvalid: "需以小写字母开头，之后只能用小写字母、数字和短横线。",
    customRouteTaken: "已有提供方使用了这个 ID。",
    customRoutePlaceholder: "acme-gateway",
    customDisplayName: "显示名称",
    customNeedsBaseUrl: "自定义提供方需要填接口地址。",
    customNeedsModels: "自定义提供方至少需要一个模型。",
    saveFailed: "保存失败：",
    createFailed: "创建失败：",
    current: "当前使用：",
    deleteWithKey: " 会移除其配置和已存储的 API 密钥。",
    deletePlain: " 会移除其配置。",
    deleteTail: "\n确定删除？",
    switched: "已切换到 ",
    switchedLocal: "已切换到本机 Ollama。",
    saved: "已保存 ",
    created: "已创建 ",
    presetLabel: "快速填入："
  };

  /**
   * 一键预设。
   *
   * 地址与模型名都取自各家官方文档上给人抄的那份：手打很容易少一个 /v1、或者记错型号，
   * 而这两样写错都不会在保存时报错，要等到真发起调用才炸，排查起来绕远。
   *
   * **型号会过期**：第一版这里写的 moonshot-v1-8k 就已经在 2026-08-31 被官方下线了，
   * qwen-plus 也被归进"旧版、不再首选推荐"。所以改这份表之前请先核对官方文档；
   * 面板上的「获取可用模型」能直接问服务商要一份实时列表，拿它验证最省事。
   *
   * vision 只作记录：官方文档里明确写了支持图片输入的四家都算（deepseek-flash、
   * glm-5.3-flash、kimi-k3、qwen3.7-plus）。它决定填进去的那个模型勾不勾「支持读图」，
   * 用户仍可在模型的高级设置里改。
   */
  var PRESETS = [
    {
      id: "deepseek-official", name: "深度求索",
      baseURL: "https://api.deepseek.com", model: "deepseek-flash", vision: true
    },
    {
      id: "zhipu", name: "智谱清言",
      baseURL: "https://open.bigmodel.cn/api/paas/v4", model: "glm-5.3-flash", vision: true
    },
    {
      id: "moonshot", name: "月之暗面",
      baseURL: "https://api.moonshot.cn/v1", model: "kimi-k3", vision: true
    },
    {
      id: "dashscope", name: "通义千问",
      baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen3.7-plus", vision: true
    }
  ];

  /* -------------------------------------------------------------- 常量与状态 */
  var SVG_NS = "http://www.w3.org/2000/svg";
  // 容量沿用 DSH 的写法：可以写 256K / 1M，落盘仍是纯数字。
  var CAPACITY_PATTERN = /^(\d+(?:\.\d+)?)([km])?$/i;
  // 和 DSH 的 ROUTE_PATTERN 一样：首字符必须是字母，否则派生出来的凭据名不是合法
  // 的 shell 标识符，保存时才炸、用户无从下手。
  var ROUTE_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
  var VISION_NAME_PATTERN = /vl|vision|llava|minicpm-v|moondream|gemma3/i;

  var ROOT = null;

  var state = {
    status: "idle",        // idle | loading | ready | error
    error: "",
    providers: [],
    activeModel: { provider: "", model: "" },
    ollamaUp: true,
    ollamaModels: [],
    local: { copy: "", vision: "" },
    settings: { copy: "", vision: "", drawingModel: "" },
    drawingModels: [],
    activeDrawingModel: "",
    editingId: null,       // null 没有编辑态；"" 本机卡；其它是服务商 id
    creating: false,       // 「添加自定义提供方」那张卡是否展开
    draft: null,           // 当前编辑态的数据，只有一份，因为同时只开一张卡
    busy: false,
    // 拉取模型列表时的局部忙碌标记。不能借用 busy：那个会把整张卡的按钮全禁掉，
    // 而这里只是在等一个请求，用户该能继续改别的地方。
    fetching: false,
    notice: "",
    failure: ""
  };

  // 上下文窗口与最大输出 token 目前不会被服务端保存（brain.mjs 的 saveProviders
  // 重建模型对象时只留 id/name/input），存下来再刷新就会看起来"白填了"。这里按
  // 服务商+模型记住本次会话里填过的值，至少让"保存后回到同一张卡"能看见自己填的
  // 东西。字段名一旦进请求体，将来后端愿意存了就自动生效。
  var CAPACITY_CACHE = {};

  /* ------------------------------------------------------------------ 小工具 */
  function el(tag, cls) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    return node;
  }

  function textNode(tag, cls, value) {
    var node = el(tag, cls);
    if (value !== undefined && value !== null) node.textContent = String(value);
    return node;
  }

  function button(cls, label) {
    var node = el("button", cls);
    node.type = "button";
    if (label !== undefined) node.textContent = label;
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function trim(value) {
    return String(value === undefined || value === null ? "" : value).replace(/^\s+|\s+$/g, "");
  }

  function has(list, value) {
    return list && list.indexOf(value) !== -1;
  }

  function getJSON(url) {
    return fetch(url, { cache: "no-store" }).then(function (res) {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    });
  }

  function postJSON(url, payload) {
    return fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    }).then(function (res) {
      return res.json();
    }).then(function (data) {
      if (!data || !data.ok) throw new Error((data && data.message) || "服务端没有返回成功");
      return data;
    });
  }

  // 手工 import 的 GGUF 在 Ollama 里只有一串 sha 当名字，下拉里排到四十多个字符谁
  // 也认不出，截一半显示；但**值仍然是全名**，发给 Ollama 的必须是完整 tag。
  function prettyModel(name) {
    var m = /^llamacpp:([0-9a-f]{8})[0-9a-f]+$/i.exec(name);
    return m ? "llamacpp:" + m[1] + "…（本地 GGUF）" : name;
  }

  /**
   * 填一个下拉框。
   *
   * current 不在候选里时也要补一项并选中：配置里写着一个本机没有的模型，如果打开
   * 面板就顺手换成列表第一项，用户随手一存就真的把模型换了。
   */
  function fillSelect(sel, items, current, emptyText) {
    clear(sel);
    if (!items.length) {
      var only = el("option");
      only.value = "";
      only.textContent = emptyText || "（没有可选的）";
      sel.appendChild(only);
      return;
    }
    items.forEach(function (item) {
      var opt = el("option");
      opt.value = item.value;
      opt.textContent = item.label;
      if (item.value === current) opt.selected = true;
      sel.appendChild(opt);
    });
    var known = items.some(function (item) { return item.value === current; });
    if (current && !known) {
      var extra = el("option");
      extra.value = current;
      extra.textContent = current + "（本机未找到）";
      extra.selected = true;
      sel.insertBefore(extra, sel.firstChild);
    }
  }

  /* -------------------------------------------------------------------- 图标 */
  // 尺寸和 path 都照抄 DSH 的 IconChevron / IconTrash，两个图标必须同尺寸，混用会
  // 在行里一高一低。
  function chevronIcon(open) {
    var svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("width", "14");
    svg.setAttribute("height", "14");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("fill", "none");
    svg.setAttribute("aria-hidden", "true");
    var path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", "M6 3.5L10.5 8L6 12.5");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "1.5");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    // 旋转放在 SVG 的 transform 属性上，而不是内联样式：项目规范不许写内联样式，
    // 而没有对应 CSS 类的几何变化总得有地方放。
    if (open) path.setAttribute("transform", "rotate(90 8 8)");
    svg.appendChild(path);
    return svg;
  }

  function trashIcon() {
    var svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("width", "14");
    svg.setAttribute("height", "14");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("fill", "none");
    svg.setAttribute("aria-hidden", "true");
    var path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", "M2.5 4h11M6.5 4V2.5h3V4M4 4l.7 9a1 1 0 001 .9h4.6a1 1 0 001-.9L12 4M6.5 6.8v4.4M9.5 6.8v4.4");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "1.3");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    svg.appendChild(path);
    return svg;
  }

  /* ---------------------------------------------------------------- 容量字段 */
  function parseCapacity(value) {
    var raw = trim(value);
    if (!raw) return undefined;                 // 空 = 用默认值
    var m = CAPACITY_PATTERN.exec(raw);
    if (m === null) return NaN;                 // 读不出来，交给校验去喊
    var scale = 1;
    if (m[2] && /^k$/i.test(m[2])) scale = 1000;
    else if (m[2]) scale = 1000000;
    var scaled = Number(m[1]) * scale;
    var rounded = Math.round(scaled);
    return Math.abs(scaled - rounded) < 1e-6 ? rounded : scaled;
  }

  function formatCapacity(value) {
    if (typeof value !== "number" || !isFinite(value)) return "";
    if (value <= 0) return String(value);
    if (value % 1000000 === 0 && value >= 1000000) return String(value / 1000000) + "M";
    if (value % 1000 === 0 && value >= 1000) return String(value / 1000) + "K";
    return String(value);
  }

  /* -------------------------------------------------------- 服务端数据 <-> 草稿 */
  function findProvider(id) {
    var found = null;
    state.providers.forEach(function (p) { if (p.id === id) found = p; });
    return found;
  }

  function isActive(id) {
    return String(state.activeModel.provider || "") === String(id || "");
  }

  function isEditing(id) {
    return !state.creating && state.editingId !== null && state.editingId === id;
  }

  function capacityKey(providerId, modelId) {
    return String(providerId) + "/" + String(modelId);
  }

  /** 一个模型行。下划线开头的字段都是界面状态，落盘时由 wireModel 挑字段，漏不出去。 */
  function modelRow(providerId, model) {
    var input = model && model.input && model.input.length ? model.input.slice() : ["text"];
    var cached = CAPACITY_CACHE[capacityKey(providerId, model && model.id)] || {};
    var contextWindow = typeof model.contextWindow === "number" ? model.contextWindow : cached.contextWindow;
    var maxTokens = typeof model.maxTokens === "number" ? model.maxTokens : cached.maxTokens;
    return {
      id: model && model.id ? String(model.id) : "",
      name: model && model.name ? String(model.name) : "",
      input: input,
      contextWindow: contextWindow,
      maxTokens: maxTokens,
      _ctxText: undefined,   // 输入缓冲。不缓冲的话每敲一个字符就被格式化回去，光标乱跳
      _maxText: undefined,
      _open: false
    };
  }

  function emptyModelRow(providerId) {
    return modelRow(providerId, { id: "", name: "", input: ["text"] });
  }

  /**
   * 模型行落盘时的白名单。
   *
   * 这里是"挑出来"而不是"删掉下划线字段"：将来给行加界面状态时，不会因为忘了删而
   * 把它发到服务端去。上下文窗口和最大输出 token 现在服务端不存，但照样发，等哪天
   * 它愿意存了就不用再动前端。
   */
  function wireModel(row) {
    var id = trim(row.id);
    var name = trim(row.name);
    var out = { id: id, name: name || id, input: row.input && row.input.length ? row.input.slice() : ["text"] };
    if (typeof row.contextWindow === "number") out.contextWindow = row.contextWindow;
    if (typeof row.maxTokens === "number") out.maxTokens = row.maxTokens;
    return out;
  }

  function openProviderDraft(provider) {
    var draft = {
      kind: "provider",
      id: provider.id,
      displayName: provider.displayName || provider.id,
      baseURL: provider.baseURL || "",
      apiKey: "",
      keyCleared: false,
      models: []
    };
    draft.models = (provider.models || []).map(function (m) { return modelRow(provider.id, m); });
    return draft;
  }

  function openCreateDraft() {
    return {
      kind: "create",
      id: "",                     // 自定义提供方的 id 是用户现起的，就叫 route
      displayName: "",
      baseURL: "",
      apiKey: "",
      keyCleared: false,
      models: [emptyModelRow("")]
    };
  }

  /**
   * 整份服务商表，顺带把草稿覆盖上去。
   *
   * 必须整份发：服务端是"用 providers 重建整张表"，少一个就等于删一个。没被编辑
   * 的服务商一律不带 apiKey 字段，服务端的规则是"不传 = 不动"，这样它们的密钥不会
   * 因为别人保存而被清掉。
   */
  function providersMap(draft) {
    var out = {};
    state.providers.forEach(function (p) {
      out[p.id] = {
        displayName: p.displayName || p.id,
        baseURL: p.baseURL || "",
        models: (p.models || []).map(wireModel)
      };
    });
    if (draft && (draft.kind === "provider" || draft.kind === "create")) {
      if (!out[draft.id]) out[draft.id] = { displayName: draft.id, baseURL: "", models: [] };
      var entry = out[draft.id];
      entry.displayName = trim(draft.displayName) || draft.id;
      entry.baseURL = trim(draft.baseURL);
      entry.models = draft.models.map(wireModel).filter(function (m) { return m.id; });
      // 密钥三态：字符串 = 换新，null = 清除，不带字段 = 不动。非空的新值优先于
      // 清除标记，否则"点了清除又贴了新密钥"会按清除处理。
      if (draft.apiKey) entry.apiKey = draft.apiKey;
      else if (draft.keyCleared) entry.apiKey = null;
    }
    return out;
  }

  function currentActive() {
    return {
      provider: String(state.activeModel.provider || ""),
      model: String(state.activeModel.model || "")
    };
  }

  function firstModelId(providerId) {
    var p = findProvider(providerId);
    if (!p || !p.models || !p.models.length) return "";
    return String(p.models[0].id || "");
  }

  function validateModels(rows) {
    var seen = {};
    for (var i = 0; i < rows.length; i += 1) {
      var id = trim(rows[i].id);
      if (!id) return T.modelIdRequired;
      if (seen[id]) return T.modelIdDuplicate;
      seen[id] = true;
      if (rows[i].contextWindow !== undefined && isNaN(rows[i].contextWindow)) return T.capacityInvalid;
      if (rows[i].maxTokens !== undefined && isNaN(rows[i].maxTokens)) return T.capacityInvalid;
    }
    return "";
  }

  /* ------------------------------------------------------------------ 读数据 */
  function applyProviders(data) {
    state.providers = Array.isArray(data.providers) ? data.providers : [];
    state.activeModel = data.activeModel && typeof data.activeModel === "object"
      ? { provider: String(data.activeModel.provider || ""), model: String(data.activeModel.model || "") }
      : { provider: "", model: "" };
    state.ollamaUp = data.ollamaUp !== false;
    state.ollamaModels = Array.isArray(data.ollamaModels) ? data.ollamaModels.filter(Boolean) : [];
    state.local = data.local && typeof data.local === "object"
      ? { copy: String(data.local.copy || ""), vision: String(data.local.vision || "") }
      : { copy: "", vision: "" };
  }

  function applySettings(data) {
    var s = (data && data.settings) || {};
    var o = (data && data.options) || {};
    // provider 是外部服务商时，扁平字段里的 copy 就是那个外部模型名，不能拿来当
    // 本机对话模型显示，所以本机卡固定读 local 那两份。
    state.settings = {
      copy: String(state.local.copy || s.copy || ""),
      vision: String(state.local.vision || s.vision || ""),
      drawingModel: String(s.drawingModel || "")
    };
    if (!state.ollamaModels.length && Array.isArray(o.ollamaModels)) {
      state.ollamaModels = o.ollamaModels.filter(Boolean);
    }
    state.drawingModels = Array.isArray(o.drawingModels) ? o.drawingModels : [];
    state.activeDrawingModel = o.activeDrawingModel ? String(o.activeDrawingModel) : "";
  }

  function reload() {
    state.status = "loading";
    render();
    var got = { providers: null, settings: null };
    var failure = null;
    return Promise.all([
      getJSON("/api/providers")
        .then(function (d) { got.providers = d; })
        .catch(function (e) { failure = e; }),
      getJSON("/api/settings")
        .then(function (d) {
          if (d && d.ok) got.settings = d;
        })
        .catch(function () {
          // 绘图模型下拉读不到不算致命：服务商那张表是主内容，照常画出来
          got.settings = null;
        })
    ]).then(function () {
      if (!ROOT) return;
      if (failure || !got.providers || !got.providers.ok) {
        state.status = "error";
        state.error = (failure && failure.message) || "服务端没有返回成功";
        render();
        return;
      }
      applyProviders(got.providers);
      applySettings(got.settings);
      state.error = "";
      state.status = "ready";
      // 打开着的服务商被别处删掉了，编辑态就没有落点了，收起来
      if (state.editingId !== null && state.editingId !== "" && !findProvider(state.editingId)) {
        closeEditor();
      }
      render();
    });
  }

  /* ------------------------------------------------------------------ 写数据 */
  function fail(message) {
    state.busy = false;
    state.failure = message;
    render();
  }

  /**
   * 界面还没就绪时一律不许写。
   *
   * 为什么必须有这道闸：写入用的 providersMap() 只会映射 state.providers，
   * 而它要等 reload() 回来才有内容。没加载完就走到写入的话，映射出来就是空表，
   * 而服务端是整表替换，等于把服务商和 API 密钥一起抹掉。
   * 服务端现在也有兜底挡着，但界面这边本来就不该发出这种请求。
   */
  function notReady() {
    if (state.status === "ready") return false;
    fail(T.saveFailed + "配置还没读完，稍后再试。");
    return true;
  }

  function begin() {
    state.failure = "";
    state.notice = "";
    state.busy = true;
    render();
  }

  function saveProviderDraft() {
    if (notReady()) return;
    var draft = state.draft;
    var problem = validateModels(draft.models);
    if (problem) { state.failure = problem; render(); return; }
    var label = trim(draft.displayName) || draft.id;
    begin();
    postJSON("/api/providers", { providers: providersMap(draft), activeModel: currentActive() })
      .then(function () {
        state.busy = false;
        closeEditor();
        state.notice = T.saved + label + "。";
        return reload();
      })
      .catch(function (e) { fail(T.saveFailed + ((e && e.message) || e)); });
  }

  function saveLocalDraft() {
    if (notReady()) return;
    var draft = state.draft;
    begin();
    postJSON("/api/settings", {
      copy: draft.copy,
      vision: draft.vision,
      drawingModel: draft.drawingModel
    })
      .then(function (data) {
        state.busy = false;
        closeEditor();
        state.notice = data && data.drawingModelChanged
          ? T.drawingSwitched + (data.activeDrawingModel || T.drawingAuto) + T.drawingSwitchedTail
          : T.saved + T.localName + "。";
        return reload();
      })
      .catch(function (e) { fail(T.saveFailed + ((e && e.message) || e)); });
  }

  function useProvider(id) {
    if (notReady()) return;
    if (state.busy) return;
    // 本机（空串 id）没有"当前模型"这个概念，服务端会把 activeModel 归一成空，
    // 真正的本机模型名在 copy 里。
    var model = id === "" ? "" : (isActive(id) ? state.activeModel.model : firstModelId(id));
    begin();
    postJSON("/api/providers", {
      providers: providersMap(null),
      activeModel: { provider: id, model: model }
    })
      .then(function () {
        state.busy = false;
        state.notice = id === "" ? T.switchedLocal : T.switched + (function () {
          var p = findProvider(id);
          return p ? (p.displayName || p.id) : id;
        })() + "。";
        return reload();
      })
      .catch(function (e) { fail(T.saveFailed + ((e && e.message) || e)); });
  }

  function removeProvider(provider) {
    if (notReady()) return;
    var label = provider.displayName || provider.id;
    var message = T.remove + " " + label + (provider.hasKey ? T.deleteWithKey : T.deletePlain) + T.deleteTail;
    if (!window.confirm(message)) return;
    var rest = {};
    state.providers.forEach(function (p) {
      if (p.id === provider.id) return;
      rest[p.id] = { displayName: p.displayName || p.id, baseURL: p.baseURL || "", models: (p.models || []).map(wireModel) };
    });
    begin();
    // 删掉的可能正是"使用中"的那个。服务端会把它落到第一个有模型的服务商上，没有
    // 就回到本机，所以这里只管把当前的 activeModel 原样带上，让它自己兜底。
    // allowEmpty：删到一家不剩是合法操作，得显式说明；否则服务端会以为
    // 这是界面故障发上来的空表而拒绝写入（那条兜底救过一次配置）。
    postJSON("/api/providers", { providers: rest, activeModel: currentActive(), allowEmpty: rest === null || Object.keys(rest).length === 0 })
      .then(function () {
        state.busy = false;
        state.notice = "已删除 " + label + "。";
        return reload();
      })
      .catch(function (e) { fail(T.saveFailed + ((e && e.message) || e)); });
  }

  function createProvider() {
    if (notReady()) return;
    var draft = state.draft;
    var problem = "";
    if (!trim(draft.id)) problem = T.customRouteInvalid;
    else if (!ROUTE_PATTERN.test(trim(draft.id))) problem = T.customRouteInvalid;
    else if (findProvider(trim(draft.id))) problem = T.customRouteTaken;
    else if (!trim(draft.baseURL)) problem = T.customNeedsBaseUrl;
    else if (!draft.models.some(function (m) { return trim(m.id); })) problem = T.customNeedsModels;
    else problem = validateModels(draft.models);
    if (problem) { state.failure = problem; render(); return; }

    var id = trim(draft.id);
    begin();
    postJSON("/api/providers", { providers: providersMap(draft), activeModel: currentActive() })
      .then(function () {
        state.busy = false;
        closeEditor();
        state.notice = T.created + id + "。";
        return reload();
      })
      .catch(function (e) { fail(T.createFailed + ((e && e.message) || e)); });
  }

  /* ------------------------------------------------------------ 拉取模型列表 */
  /**
   * 候选对话框的状态单独放一份，不进 state。
   *
   * state 里的每个字段都会被 render() 当成面板的一部分重画，而对话框是挂在 body 上
   * 的，生死跟面板无关：混进 state 只会让每次 render 都去操心一个可能并不存在的
   * 节点，还得防着它被重画成两个。
   */
  var fetchUI = null;

  /** 现在为什么不能拉。空串表示可以拉。 */
  function fetchBlockedReason(provider) {
    if (!provider) return T.fetchNeedsProvider;
    if (!trim(provider.baseURL)) return T.fetchNeedsBaseUrl;
    if (!provider.hasKey) return T.fetchNeedsKey;
    return "";
  }

  /**
   * 问一次服务商有哪些模型，成功后开候选框。
   *
   * 成败不看 HTTP 状态：这个接口失败也回 200，只有 ok 字段说得准（postJSON 已经按
   * 这个约定读它并抛错，这里直接把它的 message 当结论用）。
   */
  function startFetchModels(draft, provider) {
    if (state.fetching || state.busy) return;
    if (!provider || fetchBlockedReason(provider)) return;
    state.fetching = true;
    state.failure = "";   // 上一次失败的红字还挂在那儿，会被当成这次的结果
    render();
    postJSON("/api/providers/fetch-models", { provider: provider.id })
      .then(function (data) {
        state.fetching = false;
        // 请求在飞的时候编辑卡可能被关掉了：草稿已经不是这一份，候选框也没有落点，
        // 硬开出来会加到一个没人看得见的草稿上
        if (state.draft !== draft) { render(); return; }
        render();
        var list = Array.isArray(data.models) ? data.models.map(function (m) { return trim(m); }).filter(Boolean) : [];
        openCandidateDialog(draft, provider.id, list);
      })
      .catch(function (e) {
        state.fetching = false;
        if (state.draft === draft) state.failure = (e && e.message) || T.fetchFailed;
        render();
      });
  }

  /**
   * 候选勾选对话框。
   *
   * 默认全勾上：服务商能返回的模型多半就是用户想要的，逐个点一遍是负担（DSH 也是
   * 这么做的）。已经在草稿里的那条同样勾上，但多一个「已在列表」标记，添加时按 id
   * 跳过：重复 id 会被 validateModels 拦下，到时候整个保存都过不去。
   */
  function openCandidateDialog(draft, providerId, models) {
    closeCandidateDialog();   // 上一轮没关干净的话先清掉，免得叠出两个

    var existing = {};
    draft.models.forEach(function (row) {
      var id = trim(row.id);
      if (id) existing[id] = true;
    });
    var picked = {};
    models.forEach(function (id) { picked[id] = true; });

    var ui = {
      draft: draft,
      providerId: providerId,
      models: models,
      existing: existing,
      picked: picked,
      query: "",
      visible: [],            // 当前显示出来的那些项，全选/取消全选只作用在它们身上
      listBox: null,
      selectAll: null,
      deselectAll: null,
      adopt: null,
      dialog: null
    };
    fetchUI = ui;

    var dialog = el("dialog", "pfmp_dialog pfmp_fetchDialog");
    dialog.setAttribute("aria-label", T.fetchTitle);
    ui.dialog = dialog;

    var content = el("div", "pfmp_content");
    content.appendChild(textNode("h2", "pfmp_title", T.fetchTitle));
    content.appendChild(textNode("p", "pfmp_description", T.fetchDescription));

    var body = el("div", "pfmp_body");
    var toolbar = el("div", "pfmp_candidateToolbar");

    var search = el("input", "pfmp_input pfmp_candidateSearch");
    search.type = "search";
    search.value = "";
    search.placeholder = T.fetchSearch;
    search.setAttribute("aria-label", T.fetchSearch);
    search.addEventListener("input", function () {
      ui.query = this.value;
      renderCandidates(ui);
    });
    toolbar.appendChild(search);

    var selectAll = button("pfmp_linkButton", T.fetchSelectAll);
    selectAll.addEventListener("click", function () { pickVisibleCandidates(ui, true); });
    ui.selectAll = selectAll;
    toolbar.appendChild(selectAll);

    var deselectAll = button("pfmp_linkButton", T.fetchDeselectAll);
    deselectAll.addEventListener("click", function () { pickVisibleCandidates(ui, false); });
    ui.deselectAll = deselectAll;
    toolbar.appendChild(deselectAll);

    body.appendChild(toolbar);
    // 过滤时只换这个容器里的东西。它自己不带类：候选列表和空提示的样式都在
    // pfmp_candidateList / pfmp_candidateEmpty 上，这里只是一个换内容的落点。
    ui.listBox = el("div");
    body.appendChild(ui.listBox);
    content.appendChild(body);

    // 底部按钮行借 pfmp_body 的上外边距和 pfmp_editorActions 的右对齐。
    // 没有现成的"对话框底栏"类，把这两个组起来正好是 DSH 那个 footer 的样子。
    var footer = el("div", "pfmp_body pfmp_editorActions");
    var cancel = button("pfmp_secondaryButton", T.cancel);
    cancel.addEventListener("click", function () { closeCandidateDialog(); });
    footer.appendChild(cancel);
    ui.adopt = button("pfmp_primaryButton", T.fetchAdopt);
    ui.adopt.addEventListener("click", function () { adoptPickedCandidates(ui); });
    footer.appendChild(ui.adopt);
    content.appendChild(footer);

    dialog.appendChild(content);

    // Esc 走的是原生的 cancel → close：close 事件里把节点摘掉，免得攒着一堆空 dialog
    dialog.addEventListener("close", function () {
      if (fetchUI === ui) fetchUI = null;
      if (dialog.parentNode) dialog.parentNode.removeChild(dialog);
    });
    // 点遮罩：遮罩是 dialog 自己的框，命中它的 target 就是 dialog 本身
    dialog.addEventListener("click", function (event) {
      if (event.target === dialog) closeCandidateDialog();
    });

    renderCandidates(ui);
    document.body.appendChild(dialog);
    dialog.showModal();
    search.focus();
  }

  function closeCandidateDialog() {
    var ui = fetchUI;
    fetchUI = null;
    if (!ui || !ui.dialog) return;
    var dialog = ui.dialog;
    // 先 close 再摘节点。close 事件是异步派发的，等它来摘会留一小段"已经关了但还挂
    // 在 DOM 里"的窗口，那会儿再点一次按钮就会叠出第二个 dialog。
    if (dialog.open) dialog.close();
    if (dialog.parentNode) dialog.parentNode.removeChild(dialog);
  }

  /** 画一遍候选列表。搜索过滤只换列表内容，按钮行不动。 */
  function renderCandidates(ui) {
    clear(ui.listBox);
    ui.visible = [];

    var needle = trim(ui.query).toLowerCase();
    var shown = ui.models.filter(function (id) {
      return needle === "" || id.toLowerCase().indexOf(needle) !== -1;
    });

    if (!shown.length) {
      // 没拉到模型和筛没了是两回事，用户要能分清是服务商没给还是自己搜错了
      var empty = textNode("p", "pfmp_candidateEmpty", ui.models.length ? T.fetchNoMatch : T.fetchEmpty);
      empty.setAttribute("role", "status");
      ui.listBox.appendChild(empty);
    } else {
      var list = el("ul", "pfmp_candidateList");
      shown.forEach(function (id) {
        var item = el("li", "pfmp_candidate");
        var label = el("label", "pfmp_candidateLabel");
        var box = el("input");
        box.type = "checkbox";
        box.checked = !!ui.picked[id];
        box.setAttribute("aria-label", id);
        box.addEventListener("change", function () {
          ui.picked[id] = this.checked;
          syncCandidateDialog(ui);
        });
        label.appendChild(box);
        label.appendChild(textNode("span", "pfmp_candidateId", id));
        if (ui.existing[id]) label.appendChild(textNode("span", "pfmp_rowTag", T.fetchExisting));
        item.appendChild(label);
        list.appendChild(item);
        // 记着勾选框本身，全选/取消全选直接改属性的勾，不重画列表（重画会丢焦点）
        ui.visible.push({ id: id, box: box });
      });
      ui.listBox.appendChild(list);
    }
    syncCandidateDialog(ui);
  }

  /** 同步底栏按钮的文案与禁用态。勾选数按全部候选算，不只看筛出来的那些。 */
  function syncCandidateDialog(ui) {
    var count = 0;
    ui.models.forEach(function (id) { if (ui.picked[id]) count += 1; });
    ui.adopt.textContent = T.fetchAdopt + "（" + count + "）";
    ui.adopt.disabled = count === 0;
    var none = ui.visible.length === 0;
    ui.selectAll.disabled = none;
    ui.deselectAll.disabled = none;
  }

  function pickVisibleCandidates(ui, on) {
    ui.visible.forEach(function (item) {
      ui.picked[item.id] = on;
      item.box.checked = on;
    });
    syncCandidateDialog(ui);
  }

  /** 把勾上的候选追加进草稿。已有的按 id 跳过，重复 id 会让保存整个失败。 */
  function adoptPickedCandidates(ui) {
    var draft = ui.draft;
    var known = {};
    draft.models.forEach(function (row) {
      var id = trim(row.id);
      if (id) known[id] = true;
    });
    ui.models.forEach(function (id) {
      if (!ui.picked[id] || known[id]) return;
      draft.models.push(modelRow(ui.providerId, { id: id, name: id, input: ["text"] }));
      known[id] = true;
    });
    closeCandidateDialog();
    render();
  }

  /* -------------------------------------------------------------- 编辑态开关 */
  function closeEditor() {
    state.editingId = null;
    state.creating = false;
    state.draft = null;
    state.failure = "";
  }

  function toggleProviderEditor(provider) {
    if (isEditing(provider.id)) { closeEditor(); render(); return; }
    closeEditor();
    // 打开编辑态就把上一句「已保存 ×××」收掉：DSH 也是这么做的，留着它会在用户
    // 已经开始改下一处时误导人以为改动已经存进去了。
    state.notice = "";
    state.editingId = provider.id;
    state.draft = openProviderDraft(provider);
    render();
  }

  function toggleLocalEditor() {
    if (isEditing("")) { closeEditor(); render(); return; }
    closeEditor();
    state.notice = "";
    state.editingId = "";
    state.draft = {
      kind: "local",
      copy: state.settings.copy,
      vision: state.settings.vision,
      drawingModel: state.settings.drawingModel
    };
    render();
  }

  function toggleCreateCard() {
    if (state.creating) { closeEditor(); render(); return; }
    closeEditor();
    state.notice = "";
    state.creating = true;
    state.draft = openCreateDraft();
    render();
  }

  /* ------------------------------------------------------------------ 部件 */
  function buildFooter(submitLabel, busyLabel, onSubmit, onCancel) {
    var actions = el("div", "pfmp_editorActions");
    var cancel = button("pfmp_secondaryButton", T.cancel);
    cancel.disabled = state.busy;
    cancel.addEventListener("click", onCancel);
    var submit = button("pfmp_primaryButton", state.busy ? busyLabel : submitLabel);
    submit.disabled = state.busy;
    submit.addEventListener("click", onSubmit);
    actions.appendChild(cancel);
    actions.appendChild(submit);
    return actions;
  }

  function buildKeyField(draft, hasKey) {
    var field = el("div", "pfmp_field");
    var label = el("div", "pfmp_fieldLabel");
    label.textContent = T.keyInput;
    var hint = null;
    if (hasKey) {
      var clearBtn = button("pfmp_linkButton", T.keyClear);
      clearBtn.disabled = draft.keyCleared;
      clearBtn.addEventListener("click", function () {
        if (!window.confirm(T.keyClearConfirm)) return;
        draft.keyCleared = true;
        draft.apiKey = "";
        render();
      });
      label.appendChild(clearBtn);
    }
    field.appendChild(label);

    var input = el("input", "pfmp_input");
    input.type = "password";
    input.autocomplete = "off";
    // 明文从不回传，所以这个框永远是空的。留着上次输入的值只会让人以为密钥可见。
    input.value = "";
    input.placeholder = hasKey && !draft.keyCleared ? T.keyStored : T.keyPlaceholder;
    input.setAttribute("aria-label", T.keyInput);
    input.addEventListener("input", function () {
      draft.apiKey = this.value;
      // 贴了新密钥就把"待清除"那句话收掉，不然它会一直挂在那儿误导人
      if (hint && this.value) hint.textContent = "";
    });
    field.appendChild(input);
    if (draft.keyCleared) {
      hint = textNode("p", "pfmp_advancedHint", T.keyClearPending);
      field.appendChild(hint);
    }
    return field;
  }

  function buildBaseUrlField(draft, placeholder) {
    var field = el("div", "pfmp_field");
    field.appendChild(textNode("div", "pfmp_fieldLabel", T.baseUrl));
    var input = el("input", "pfmp_input");
    input.type = "text";
    input.value = draft.baseURL || "";
    input.placeholder = placeholder;
    input.setAttribute("aria-label", T.baseUrl);
    input.addEventListener("input", function () { draft.baseURL = this.value; });
    field.appendChild(input);
    return field;
  }

  function buildCapacityField(row, key, textKey, label, hint, index) {
    var field = el("label", "pfmp_modelField");
    field.appendChild(textNode("span", "pfmp_modelFieldLabel", label));
    var input = el("input", "pfmp_input");
    input.type = "text";
    input.inputMode = "numeric";
    input.value = row[textKey] !== undefined ? row[textKey] : formatCapacity(row[key]);
    input.placeholder = hint;
    input.setAttribute("aria-label", label + " " + (index + 1));
    input.addEventListener("input", function () {
      row[textKey] = this.value;
      var parsed = parseCapacity(this.value);
      if (parsed === undefined) delete row[key];
      else row[key] = parsed;
    });
    field.appendChild(input);
    return field;
  }

  function buildVisionField(row, index) {
    var field = el("label", "pfmp_modelField");
    field.appendChild(textNode("span", "pfmp_modelFieldLabel", T.modelVision));
    var box = el("input");
    box.type = "checkbox";
    box.checked = has(row.input, "image");
    box.title = T.modelVisionHint;
    box.setAttribute("aria-label", T.modelVision + " " + (index + 1));
    box.addEventListener("change", function () {
      // 服务端只认 text / image 两种，不要把别的值带进去把数组弄脏
      row.input = this.checked ? ["text", "image"] : ["text"];
    });
    field.appendChild(box);
    return field;
  }

  function buildModelEntry(draft, row, index) {
    var entry = el("div", "pfmp_modelEntry");
    var line = el("div", "pfmp_modelRow");

    var idInput = el("input", "pfmp_input");
    idInput.type = "text";
    idInput.value = row.id;
    idInput.placeholder = T.modelId;
    idInput.setAttribute("aria-label", T.modelId + " " + (index + 1));
    idInput.addEventListener("input", function () { row.id = this.value; });
    line.appendChild(idInput);

    var nameInput = el("input", "pfmp_input");
    nameInput.type = "text";
    nameInput.value = row.name;
    nameInput.placeholder = T.modelName;
    nameInput.setAttribute("aria-label", T.modelName + " " + (index + 1));
    nameInput.addEventListener("input", function () { row.name = this.value; });
    line.appendChild(nameInput);

    var advanced = button("pfmp_iconButton");
    advanced.setAttribute("aria-label", T.modelAdvanced + " " + (index + 1));
    advanced.setAttribute("aria-expanded", row._open ? "true" : "false");
    advanced.title = T.modelAdvanced;
    advanced.appendChild(chevronIcon(row._open));
    advanced.addEventListener("click", function () { row._open = !row._open; render(); });
    line.appendChild(advanced);

    var remove = button("pfmp_iconButton pfmp_iconButtonDanger");
    remove.setAttribute("aria-label", T.removeModel + " " + (index + 1));
    remove.title = T.removeModel;
    remove.appendChild(trashIcon());
    // 模型行不弹确认：它只是草稿里的一行，没保存就什么也没发生，弹窗只会碍事
    remove.addEventListener("click", function () {
      draft.models.splice(index, 1);
      render();
    });
    line.appendChild(remove);

    entry.appendChild(line);

    if (row._open) {
      var box = el("div", "pfmp_modelAdvanced");
      box.appendChild(buildCapacityField(row, "contextWindow", "_ctxText", T.contextWindow, "256K", index));
      box.appendChild(buildCapacityField(row, "maxTokens", "_maxText", T.maxTokens, "32K", index));
      box.appendChild(buildVisionField(row, index));
      entry.appendChild(box);
    }
    return entry;
  }

  function buildModelList(draft, provider) {
    // 拖来拖去的重排留到以后再说：模型的顺序不影响请求，只会让"哪一行是哪一个"变难认
    var catalog = el("section", "pfmp_modelCatalog");
    catalog.setAttribute("aria-label", T.models);

    var head = el("div", "pfmp_modelListHead");
    var heading = el("div", "pfmp_modelCatalogHeading");
    heading.appendChild(textNode("span", "pfmp_modelCatalogTitle", T.models));
    if (provider && isActive(provider.id) && state.activeModel.model) {
      heading.appendChild(textNode("span", "pfmp_modelCatalogMeta", T.current + state.activeModel.model));
    }
    head.appendChild(heading);

    // 能不能拉由 provider 决定：服务端要拿它的 id 去查地址和密钥，所以地址和密钥
    // 缺一不可；新建卡（provider 为 null）还没落盘，服务端根本查不到它。
    var fetchWhy = fetchBlockedReason(provider);
    var fetchBtn = button("pfmp_linkButton", state.fetching ? T.fetching : T.fetchModels);
    fetchBtn.disabled = !!fetchWhy || state.fetching || state.busy;
    fetchBtn.title = fetchWhy || (state.fetching ? T.fetching : T.fetchHint);
    fetchBtn.addEventListener("click", function () { startFetchModels(draft, provider); });
    head.appendChild(fetchBtn);
    catalog.appendChild(head);

    if (!draft.models.length) {
      catalog.appendChild(textNode("p", "pfmp_modelEmpty", T.modelsEmpty));
    }
    draft.models.forEach(function (row, index) {
      catalog.appendChild(buildModelEntry(draft, row, index));
    });

    var add = button("pfmp_addModelButton", T.addModel);
    add.disabled = state.busy;
    add.addEventListener("click", function () {
      draft.models.push(emptyModelRow(draft.id || ""));
      render();
    });
    catalog.appendChild(add);
    return catalog;
  }

  function buildProviderEditor(provider) {
    var draft = state.draft;
    var editor = el("div", "pfmp_editor");

    var head = el("div", "pfmp_editorHeader");
    head.appendChild(textNode("span", "pfmp_editorTitle", draft.displayName || draft.id));
    if (draft.id && draft.id !== draft.displayName) {
      head.appendChild(textNode("span", "pfmp_editorRoute", draft.id));
    }
    editor.appendChild(head);

    editor.appendChild(buildKeyField(draft, provider.hasKey));
    editor.appendChild(buildBaseUrlField(draft,
      provider.id === "deepseek-official" ? T.deepseekBaseUrl : T.baseUrlDefault));
    editor.appendChild(buildModelList(draft, provider));
    if (state.failure) editor.appendChild(textNode("p", "pfmp_error", state.failure));
    editor.appendChild(buildFooter(T.apply, T.applying, saveProviderDraft, function () { closeEditor(); render(); }));
    return editor;
  }

  /**
   * 预设按钮行。
   *
   * 点一下就把 route / 显示名 / 地址 / 第一个模型一起填好。只填第一个模型是有意的：
   * 预设给的是「能跑通的最小一组」，多塞几个模型反而会让用户以为地址就只支持这些。
   * 落点用 pfmp_linkButton（提示行里那种小字按钮）而不是 pfmp_addButton：塞进
   * pfmp_addActions 会让它长得和「添加自定义提供方」一样大，喧宾夺主。
   */
  /**
   * 把一个预设填进草稿。外面那行常驻按钮和卡内那行都调它，
   * 两处各写一遍迟早会走偏（改一处忘一处）。
   */
  function applyPresetToDraft(draft, preset) {
    // 已经配过同名服务商时换个后缀。不避让的话一点预设就撞上
    // 「已有提供方使用了这个 ID」，而用户只是想再加一个同型号的服务商。
    var id = preset.id;
    var n = 2;
    while (findProvider(id)) { id = preset.id + "-" + n; n += 1; }
    draft.id = id;
    draft.displayName = preset.name;
    draft.baseURL = preset.baseURL;
    var input = preset.vision ? ["text", "image"] : ["text"];
    // 只覆盖第一个模型行，用户已经加过的其它行保持不动
    if (!draft.models.length) draft.models = [modelRow(id, { id: preset.model, name: preset.model, input: input })];
    else {
      draft.models[0].id = preset.model;
      draft.models[0].name = preset.model;
      draft.models[0].input = input;
    }
  }

  /** 点外面的预设按钮：直接开创建卡并填好，一步到位。 */
  function openCreateWithPreset(preset) {
    closeEditor();
    state.notice = "";
    state.creating = true;
    state.draft = openCreateDraft();
    applyPresetToDraft(state.draft, preset);
    render();
  }

  function buildPresetRow(draft) {
    var row = el("div", "pfmp_field");
    row.appendChild(textNode("div", "pfmp_fieldLabel", T.presetLabel));
    var bar = el("div", "pfmp_addActions");
    PRESETS.forEach(function (preset) {
      var b = button("pfmp_linkButton", preset.name);
      b.title = preset.baseURL + " " + preset.model;
      b.addEventListener("click", function () {
        applyPresetToDraft(draft, preset);
        render();
      });
      bar.appendChild(b);
    });
    row.appendChild(bar);
    return row;
  }

  function buildCreateEditor() {
    var draft = state.draft;
    var card = el("div", "pfmp_addCard");
    var editor = el("div", "pfmp_editor");

    var head = el("div", "pfmp_editorHeader");
    head.appendChild(textNode("span", "pfmp_editorTitle", T.customTitle));
    editor.appendChild(buildPresetRow(draft));
    editor.appendChild(head);

    var routeField = el("div", "pfmp_field");
    routeField.appendChild(textNode("div", "pfmp_fieldLabel", T.customRoute));
    var routeInput = el("input", "pfmp_input");
    routeInput.type = "text";
    routeInput.value = draft.id;
    routeInput.placeholder = T.customRoutePlaceholder;
    routeInput.setAttribute("aria-label", T.customRoute);
    routeInput.addEventListener("input", function () { draft.id = this.value; });
    routeField.appendChild(routeInput);
    editor.appendChild(routeField);
    // 合法性只在提交时判：输入时就红一片，用户还没打完就被骂一顿
    editor.appendChild(textNode("p", "pfmp_advancedHint", T.customRouteHint));

    var nameField = el("div", "pfmp_field");
    nameField.appendChild(textNode("div", "pfmp_fieldLabel", T.customDisplayName));
    var nameInput = el("input", "pfmp_input");
    nameInput.type = "text";
    nameInput.value = draft.displayName;
    nameInput.placeholder = draft.id || T.customDisplayName;
    nameInput.setAttribute("aria-label", T.customDisplayName);
    nameInput.addEventListener("input", function () { draft.displayName = this.value; });
    nameField.appendChild(nameInput);
    editor.appendChild(nameField);

    editor.appendChild(buildBaseUrlField(draft, T.customBaseUrlPlaceholder));
    editor.appendChild(buildKeyField(draft, false));
    editor.appendChild(buildModelList(draft, null));
    if (state.failure) editor.appendChild(textNode("p", "pfmp_error", state.failure));
    editor.appendChild(buildFooter(T.create, T.creating, createProvider, function () { closeEditor(); render(); }));

    card.appendChild(editor);
    return card;
  }

  function buildLocalEditor() {
    var draft = state.draft;
    var editor = el("div", "pfmp_editor");

    var head = el("div", "pfmp_editorHeader");
    head.appendChild(textNode("span", "pfmp_editorTitle", T.localName));
    editor.appendChild(head);

    var visionModels = state.ollamaModels.filter(function (n) { return VISION_NAME_PATTERN.test(n); });
    var copyItems = state.ollamaModels.map(function (n) { return { value: n, label: prettyModel(n) }; });
    var visionItems = visionModels.map(function (n) { return { value: n, label: prettyModel(n) }; });
    var drawItems = [{ value: "", label: T.drawingAuto }].concat(state.drawingModels.map(function (m) {
      return {
        value: m.name,
        label: m.name + " · " + m.sizeGB + "GB" + (m.usable ? "" : "（不可用）")
      };
    }));

    var fields = [
      { key: "copy", label: T.localCopy, items: copyItems, empty: T.localEmpty },
      { key: "vision", label: T.localVision, items: visionItems, empty: T.visionEmpty },
      { key: "drawingModel", label: T.localDrawing, items: drawItems, empty: T.drawingEmpty }
    ];

    fields.forEach(function (spec) {
      var field = el("div", "pfmp_field");
      field.appendChild(textNode("div", "pfmp_fieldLabel", spec.label));
      var select = el("select", "pfmp_input pfmp_selectInput");
      select.setAttribute("aria-label", spec.label);
      fillSelect(select, spec.items, draft[spec.key], spec.empty);
      select.addEventListener("change", function () { draft[spec.key] = this.value; });
      field.appendChild(select);
      editor.appendChild(field);
    });

    // 服务端在"当前用的是外部服务商"时会直接丢掉 copy/vision 两个补丁，保存看着成
    // 功其实没写进去。与其让用户反复保存，不如在这里说清楚要切回本机才生效。
    if (String(state.activeModel.provider || "") !== "") {
      editor.appendChild(textNode("p", "pfmp_advancedHint", T.localInactive));
    }
    if (state.drawingModels.length && state.activeDrawingModel) {
      editor.appendChild(textNode("p", "pfmp_advancedHint", T.drawingActive + state.activeDrawingModel));
    }

    if (state.failure) editor.appendChild(textNode("p", "pfmp_error", state.failure));
    editor.appendChild(buildFooter(T.apply, T.applying, saveLocalDraft, function () { closeEditor(); render(); }));
    return editor;
  }

  function buildLocalCard() {
    var active = isActive("");
    var li = el("li", "pfmp_rowCard");
    var head = el("div", "pfmp_rowHead");

    var identity = el("span", "pfmp_rowIdentity");
    identity.appendChild(textNode("span", "pfmp_rowName", T.localName));
    if (active) identity.appendChild(textNode("span", "pfmp_rowTag", T.active));
    head.appendChild(identity);

    var actions = el("span", "pfmp_rowActions");
    var use = button("pfmp_secondaryButton", active ? T.inUse : T.use);
    use.disabled = active || state.busy;
    use.addEventListener("click", function () { useProvider(""); });
    actions.appendChild(use);
    var edit = button("pfmp_secondaryButton", T.edit);
    edit.disabled = state.busy;
    edit.addEventListener("click", toggleLocalEditor);
    actions.appendChild(edit);
    head.appendChild(actions);

    li.appendChild(head);
    if (isEditing("")) li.appendChild(buildLocalEditor());
    return li;
  }

  function buildProviderCard(provider) {
    var active = isActive(provider.id);
    var li = el("li", "pfmp_rowCard");
    var head = el("div", "pfmp_rowHead");

    var identity = el("span", "pfmp_rowIdentity");
    identity.appendChild(textNode("span", "pfmp_rowName", provider.displayName || provider.id));
    // 这个后端里每个服务商都是手写的配置，没有"内置目录"这回事，所以 DSH 的「自
    // 定义」徽标在这里会是张张都有，等于没说，只留「当前使用中」这一个标签。
    if (active) identity.appendChild(textNode("span", "pfmp_rowTag", T.active));
    var dot = el("span", "pfmp_credentialDot " +
      (provider.hasKey ? "pfmp_credentialDotConfigured" : "pfmp_credentialDotMissing"));
    dot.setAttribute("role", "img");
    dot.setAttribute("aria-label", provider.hasKey ? T.keyConfigured : T.keyMissing);
    dot.title = provider.hasKey ? T.keyConfigured : T.keyMissing;
    identity.appendChild(dot);
    head.appendChild(identity);

    var actions = el("span", "pfmp_rowActions");
    var use = button("pfmp_secondaryButton", active ? T.inUse : T.use);
    use.disabled = active || state.busy;
    use.addEventListener("click", function () { useProvider(provider.id); });
    actions.appendChild(use);
    var edit = button("pfmp_secondaryButton", T.edit);
    edit.disabled = state.busy;
    edit.setAttribute("aria-label", T.edit + " " + (provider.displayName || provider.id));
    edit.addEventListener("click", function () { toggleProviderEditor(provider); });
    actions.appendChild(edit);
    var del = button("pfmp_dangerButton", T.remove);
    del.disabled = state.busy;
    del.setAttribute("aria-label", T.remove + " " + (provider.displayName || provider.id));
    del.addEventListener("click", function () { removeProvider(provider); });
    actions.appendChild(del);
    head.appendChild(actions);

    li.appendChild(head);
    if (isEditing(provider.id)) li.appendChild(buildProviderEditor(provider));
    return li;
  }

  function buildAddArea() {
    if (state.creating) return buildCreateEditor();

    // 预设摆在添加按钮下面**常驻显示**，而不是藏在创建卡里：
    // 藏在里面意味着「想用预设」要先点开「添加自定义提供方」，
    // 那是两步；而「一键预设」的意思本来就是一步到位。
    // 位置放在两个添加按钮之后，是为了不打断 DSH 原本的版式。
    var block = el("div", "pfmp_addBlock");
    var area = el("div", "pfmp_addActions");
    // 服务商只能从配置文件里来，本项目没有"待激活的内置提供方"这个目录，所以这个
    // 按钮永远没有可加的东西：禁掉并指向自定义入口，免得点了个没反应的按钮。
    var add = button("pfmp_addButton", T.add);
    add.disabled = true;
    add.title = T.addUnsupported;
    area.appendChild(add);
    var custom = button("pfmp_addButton", T.customAdd);
    custom.disabled = state.busy;
    custom.addEventListener("click", toggleCreateCard);
    area.appendChild(custom);
    block.appendChild(area);

    var quick = el("div", "pfmp_addActions");
    quick.appendChild(textNode("span", "pfmp_modelFieldLabel", T.presetLabel));
    PRESETS.forEach(function (preset) {
      var b = button("pfmp_linkButton", preset.name);
      b.disabled = state.busy;
      b.title = preset.baseURL + "  " + preset.model;
      b.addEventListener("click", function () { openCreateWithPreset(preset); });
      quick.appendChild(b);
    });
    block.appendChild(quick);
    return block;
  }

  /* ------------------------------------------------------------------ 渲染 */
  function render() {
    if (!ROOT) return;
    clear(ROOT);

    var section = el("div", "pfmp_section");
    section.appendChild(textNode("h3", "pfmp_title", T.title));
    section.appendChild(textNode("p", "pfmp_intro", T.intro));

    if (state.status === "error") {
      section.appendChild(textNode("p", "pfmp_error", T.loadFailed + "：" + state.error));
      var retry = button("pfmp_secondaryButton", T.retry);
      retry.addEventListener("click", function () { reload(); });
      section.appendChild(retry);
      ROOT.appendChild(section);
      return;
    }

    if (state.status !== "ready") {
      section.appendChild(textNode("p", "pfmp_notice", T.loading));
      ROOT.appendChild(section);
      return;
    }

    if (!state.ollamaUp) section.appendChild(textNode("p", "pfmp_notice", T.ollamaDown));
    if (state.notice) section.appendChild(textNode("p", "pfmp_savedNotice", state.notice));
    if (state.failure && !state.draft) section.appendChild(textNode("p", "pfmp_error", state.failure));

    var rows = el("ul", "pfmp_rows");
    rows.appendChild(buildLocalCard());
    state.providers.forEach(function (provider) {
      rows.appendChild(buildProviderCard(provider));
    });
    section.appendChild(rows);
    section.appendChild(buildAddArea());
    ROOT.appendChild(section);
  }

  /* ------------------------------------------------------------------ 对外 */
  function mount(container) {
    if (!container) return;
    ROOT = container;
    // 设计令牌挂在 .pf-mp 上，容器没带这个类的话面板会是一堆没有颜色的裸控件。
    // 只补不加倍：宿主自己带上 pf-mp（以及暗色的 pf-dark）时这里什么都不做。
    if (!/(^|\s)pf-mp(\s|$)/.test(String(container.className || ""))) {
      container.className = (container.className ? container.className + " " : "") + "pf-mp";
    }
    reload();
  }

  window.PFModelPanel = {
    mount: mount,
    reload: reload
  };
})();
