/**
 * settings.js，模型设置面板的共享实现。
 *
 * 由门户（hub.html）加载。界面结构与尺寸照搬 DeepSeek Harness 网页端的设置窗口，
 * 数据从 /api/settings 读、也存回它；这里不直接读写配置文件。
 *
 * 三种状态要分清楚：
 *   1. 选了外部接口才展开那组输入框，选本机 Ollama 时收起，免得让人以为都要填。
 *   2. 外部密钥只回传"有没有"，输入框永远留空；留空表示这次不改。
 *   3. 勾了"用模型自带视觉"之后本机视觉模型那栏与本次无关，
 *      但**不隐藏**：隐藏会让人以为配置丢了，给一句说明更清楚。
 *
 * 齿轮图标用的是带齿的轮廓（Feather 的 settings）。
 * 注意不要用“圆心 + 放射线”那种画法：那和深浅色按钮的太阳图标长得一样，用户会认错。
 */
(function () {
  "use strict";

  function $(sel) { return document.querySelector(sel); }

  function showMsg(text, kind) {
    var el = $("#setMsg");
    if (!el) return;
    el.textContent = text || "";
    el.className = "settings-msg" + (kind ? " " + kind : "");
  }

  // 手工 import 进来的 GGUF 在 Ollama 里只有一串 sha 当名字
  // （llamacpp:061d6b24b29a9698…），下拉里排到四十多字符谁也认不出，
  // 截一半显示，但**值仍然是全名**，发给 Ollama 的必须是完整 tag。
  function prettyModel(n) {
    var m = /^llamacpp:([0-9a-f]{8})[0-9a-f]+$/i.exec(n);
    return m ? "llamacpp:" + m[1] + "…（本地 GGUF）" : n;
  }

  function fillSelect(sel, items, current, emptyText) {
    if (!sel) return;
    sel.innerHTML = "";
    if (!items.length) {
      var o0 = document.createElement("option");
      o0.value = "";
      o0.textContent = emptyText || "（本机没有可用的）";
      sel.appendChild(o0);
      return;
    }
    items.forEach(function (it) {
      var o = document.createElement("option");
      o.value = it.value;
      o.textContent = it.label;
      if (it.value === current) o.selected = true;
      sel.appendChild(o);
    });
    // 配置里写着一个本机没有的模型时仍然列出来并选中。
    // 否则一打开面板就会"顺手"换成列表第一项，用户随手一存就真的换了模型。
    if (current && !items.some(function (i) { return i.value === current; })) {
      var o = document.createElement("option");
      o.value = current;
      o.textContent = current + "（本机未找到）";
      o.selected = true;
      sel.insertBefore(o, sel.firstChild);
    }
  }

  function syncVisibility() {
    var isRemote = $("#setProvider") && $("#setProvider").value === "openai";
    var remote = $("#setRemoteGroup");
    if (remote) remote.hidden = !isRemote;
    var fromLlm = $("#setVisionFromLlm") && $("#setVisionFromLlm").checked;
    var vh = $("#setVisionHint");
    if (vh) {
      vh.textContent = (isRemote && fromLlm)
        ? "当前读图走外部模型自带的视觉，这个下拉暂不生效。"
        : "本机读图用哪个模型。图片会先缩到长边 896 再喂给它。";
    }
  }

  /** 读回服务端配置并铺到界面上。返回 Promise，好让调用方等它铺完再说话。 */
  // 外部模型认不认图，是最容易踩的一个坑：模型没有视觉却勾了「自带视觉」，
  // 读图时把图片发过去会被对方 400 拒掉，而报错来自几十行开外，
  // 很难联想到是这个勾造成的。这里按模型名给一句话。
  // 依据是官方文档：DeepSeek 的视觉指南里明确支持图片的是 deepseek-flash，
  // 别的型号（如 deepseek-v4-pro）文档没提，就别替它打包票。
  function remoteModelHint(name) {
    var n = String(name || "").trim().toLowerCase();
    if (!n) return "";
    if (/deepseek-flash|v4-flash/.test(n)) {
      return n + " 支持图片输入，可以勾上「自带视觉」，读图和写文案都交给它。";
    }
    if (/^deepseek/.test(n)) {
      return "官方文档里支持图片输入的是 deepseek-flash；" + n +
        " 没提到读图，建议下面那个开关先别勾，读图仍用本机视觉模型。";
    }
    return "";
  }

  // 预设：省得去记"地址要不要带 /v1""模型现在叫什么"。
  // DeepSeek 官方 base_url 就是 https://api.deepseek.com（不带 /v1），
  // 我们的代码是自己接 /chat/completions 的，所以两种写法都通。
  var PRESETS = {
    deepseek: {
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-flash",
      visionFromLlm: true,
      note: "已填入 DeepSeek 官方参数（deepseek-flash 支持读图）。填上密钥再保存即可。",
    },
  };

  function applyPreset(key) {
    var p = PRESETS[key];
    if (!p) return;
    // 先把来源切到外部，否则下面那组输入框还是收起的，改了也看不见
    $("#setProvider").value = "openai";
    $("#setBaseUrl").value = p.baseUrl;
    $("#setRemoteModel").value = p.model;
    $("#setVisionFromLlm").checked = !!p.visionFromLlm;
    syncVisibility();
    var mh = $("#setRemoteModelHint");
    if (mh) mh.textContent = remoteModelHint(p.model);
    showMsg(p.note, "ok");
  }

  /** 清除已保存的密钥。后端一直支持 clearApiKey，但界面上从来没发过这个字段，
   *  于是填过一次就只能覆盖、删不掉。 */
  function clearKey() {
    if (!window.confirm("确定清除已保存的接口密钥？\n清掉之后走外部接口就会失败，需要重新填。")) return;
    var btn = $("#setClearKey");
    if (btn) btn.disabled = true;
    showMsg("清除中…");
    fetch("/api/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clearApiKey: true }),
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data || !data.ok) throw new Error((data && data.message) || "清除失败");
        // 同样要等 load() 铺完再写提示，否则会被它收尾的 showMsg("") 擦掉
        return load().then(function () { showMsg("密钥已清除。", "ok"); });
      })
      .catch(function (e) { showMsg("清除失败：" + (e.message || e), "err"); })
      .finally(function () { if (btn) btn.disabled = false; });
  }

  function load() {
    showMsg("读取中…");
    return fetch("/api/settings", { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data || !data.ok) throw new Error((data && data.message) || "读取失败");
        var s = data.settings || {};
        var o = data.options || {};

        $("#setProvider").value = s.provider || "ollama";
        $("#setBaseUrl").value = s.baseUrl || "";
        $("#setApiKey").value = "";
        $("#setKeyHint").textContent = s.hasApiKey
          ? "已保存密钥；留空表示不修改。"
          : "还没有保存过密钥。";
        // 有密钥才给“清除”入口：没密钥时摆一个不能点的按钮只是噪音
        var ck = $("#setClearKey");
        if (ck) ck.hidden = !s.hasApiKey;
        // provider=openai 时 copy 字段就是外部模型的名字
        $("#setRemoteModel").value = s.provider === "openai" ? (s.copy || "") : "";
        $("#setVisionFromLlm").checked = !!s.visionFromLlm;
        var mh = $("#setRemoteModelHint");
        if (mh) mh.textContent = remoteModelHint(s.provider === "openai" ? (s.copy || "") : "");

        var ollama = (o.ollamaModels || []).filter(Boolean);
        // 视觉候选只留看起来能读图的，免得把纯文本模型选来当眼睛
        var visionCand = ollama.filter(function (n) {
          return /vl|vision|llava|minicpm-v|moondream|gemma3/i.test(n);
        });
        fillSelect($("#setVision"), visionCand.map(function (n) { return { value: n, label: n }; }),
          s.vision, "本机没有可读图的模型");
        fillSelect($("#setCopy"), ollama.map(function (n) { return { value: n, label: prettyModel(n) }; }),
          s.copy, "本机没有模型（先 ollama pull）");

        var draw = o.drawingModels || [];
        // 头一项是空值 = 交回自动挑选。没有这一项的话，一旦选过具体模型就再也
        // 退不回自动，而提示里明明写着"留空表示自动挑选"。
        var drawItems = [{ value: "", label: "自动挑选（推荐）" }].concat(draw.map(function (m) {
          return { value: m.name, label: m.name + " · " + m.sizeGB + "GB" + (m.usable ? "" : "（不可用）") };
        }));
        fillSelect($("#setDrawing"), drawItems, s.drawingModel || "",
          "本机没有绘图模型");
        var dh = $("#setDrawingHint");
        if (dh) {
          dh.textContent = draw.length
            ? "当前生效：" + (o.activeDrawingModel || "（未知）") + (o.activeDrawingRoot ? " · " + o.activeDrawingRoot : "")
            : "本机没找到可用的 diffusers 模型目录。留空表示自动挑选。";
        }
        syncVisibility();
        showMsg("");
      })
      .catch(function (e) { showMsg("读取失败：" + (e.message || e), "err"); });
  }

  function save() {
    var btn = $("#setSave");
    var provider = $("#setProvider").value;
    var payload = { provider: provider, visionFromLlm: !!$("#setVisionFromLlm").checked };
    if (provider === "openai") {
      payload.baseUrl = $("#setBaseUrl").value.trim();
      var key = $("#setApiKey").value.trim();
      // 只有真的填了才带上密钥，否则服务端会以为要清空
      if (key) payload.apiKey = key;
      payload.copy = $("#setRemoteModel").value.trim();
    } else {
      payload.copy = $("#setCopy").value;
      payload.vision = $("#setVision").value;
    }
    // 空字符串是合法值（= 自动挑选），所以这里不能像别处那样"有值才带"，
    // 否则选了自动也发不出去。
    var drawSel = $("#setDrawing");
    if (drawSel) payload.drawingModel = drawSel.value || "";

    if (btn) btn.disabled = true;
    showMsg("保存中…");
    fetch("/api/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data || !data.ok) throw new Error((data && data.message) || "保存失败");
        // 必须**等 load() 铺完再写提示**。之前是"调用 load() 紧接着写提示"，
        // 看着没问题，其实 load() 是异步的：那句 showMsg("") 会在几百毫秒后
        // 才跑，正好把刚显示出来的“已保存。”擦掉，用户什么都看不到。
        return load().then(function () {
          showMsg(
            data.drawingModelChanged
              ? "已保存。绘图模型切换为 " + data.activeDrawingModel + "，下次出图生效。"
              : "已保存。",
            "ok"
          );
        });
      })
      .catch(function (e) { showMsg("保存失败：" + (e.message || e), "err"); })
      .finally(function () { if (btn) btn.disabled = false; });
  }

  function open() {
    var m = $("#settingsModal");
    if (!m) return;
    m.hidden = false;
    load();
  }
  function close() {
    var m = $("#settingsModal");
    if (m) m.hidden = true;
  }

  function init() {
    var gear = $("#settingsBtn");
    if (gear) gear.addEventListener("click", open);
    var cl = $("#setClose");
    if (cl) cl.addEventListener("click", close);
    var m = $("#settingsModal");
    if (m) {
      m.addEventListener("click", function (e) {
        if (e.target.closest("[data-close]")) close();
      });
    }
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && m && !m.hidden) close();
    });
    var prov = $("#setProvider");
    if (prov) prov.addEventListener("change", syncVisibility);
    var vfl = $("#setVisionFromLlm");
    if (vfl) vfl.addEventListener("change", syncVisibility);
    // 模型名是手打的，打的时候就得跟着更新那句"认不认图"的提示
    var rm = $("#setRemoteModel");
    if (rm) {
      rm.addEventListener("input", function () {
        var mh = $("#setRemoteModelHint");
        if (mh) mh.textContent = remoteModelHint(rm.value);
      });
    }
    var ps = $("#setPreset");
    if (ps) ps.addEventListener("click", function () { applyPreset("deepseek"); });
    var ck = $("#setClearKey");
    if (ck) ck.addEventListener("click", clearKey);
    var sv = $("#setSave");
    if (sv) sv.addEventListener("click", save);
    var rl = $("#setReload");
    if (rl) rl.addEventListener("click", load);
    var of = $("#setOpenFile");
    if (of) {
      of.addEventListener("click", function () {
        var p = "posterforge/brain.config.json";
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(p).then(function () {
            showMsg("配置路径已复制：" + p, "ok");
          }).catch(function () { showMsg("配置路径：" + p); });
        } else {
          showMsg("配置路径：" + p);
        }
      });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
