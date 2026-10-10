/**
 * settings.js，设置面板的外壳与「通用设置」页。
 *
 * 分两页，和 DeepSeek Harness 的导航结构一致：
 *   通用设置  本机的东西：本机模型、绘图模型、旅游规划的思考模式
 *   模型      服务商与模型的多份配置，交给 model-panel.js（那份是照 DSH 搬的）
 *
 * 两页的数据来源不同，别搞混：
 *   通用设置 → /api/settings    只管本机的项
 *   模型     → /api/providers   管有哪些服务商、密钥、模型，以及当前用哪个
 * 外接服务商时 copy/vision 是从服务商结构解析出来的，所以这一页在那种情况下
 * 只作展示、不让改（服务端也会忽略这两个字段）。
 *
 * 齿轮图标用的是带齿的轮廓（Feather 的 settings）。
 * 不要用"圆心 + 放射线"那种画法：那和旁边深浅色按钮的太阳图标长得一样，用户会认错。
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

  /* ---------------------------------------------------------------- 页面切换 */

  var PAGE_TITLE = { general: "通用设置", models: "模型" };
  var mountedOnce = false;

  /** 面板的明暗跟着页面走。DSH 那套令牌挂在 .pf-mp / .pf-mp.pf-dark 上，要手动同步。 */
  function syncPanelTheme() {
    var host = document.querySelector(".pf-mp");
    if (!host) return;
    var dark = document.documentElement.getAttribute("data-theme") === "dark";
    host.classList.toggle("pf-dark", dark);
  }

  function showPage(name) {
    var key = PAGE_TITLE[name] ? name : "general";
    var items = document.querySelectorAll(".settings-nav-item");
    for (var i = 0; i < items.length; i++) {
      items[i].classList.toggle("on", items[i].getAttribute("data-page") === key);
    }
    var bodies = document.querySelectorAll("[data-page-body]");
    for (var j = 0; j < bodies.length; j++) {
      bodies[j].hidden = bodies[j].getAttribute("data-page-body") !== key;
    }
    // 保存栏只属于通用设置页；模型页每张卡自己带「取消 / 保存」
    var foot = document.querySelector("[data-page-foot]");
    if (foot) foot.hidden = key !== "general";
    var t = $("#setPageTitle");
    if (t) t.textContent = PAGE_TITLE[key];

    if (key === "models") {
      syncPanelTheme();
      var host = $("#settingsModels");
      if (host && window.PFModelPanel) {
        // 只在第一次进入时挂载，之后靠它自己的 reload 刷新，
        // 免得每次切页都把正在编辑的表单重画一遍、把草稿冲掉
        if (!mountedOnce) { window.PFModelPanel.mount(host); mountedOnce = true; }
        else window.PFModelPanel.reload();
      }
    }
  }

  /* ------------------------------------------------------------ 通用设置页 */

  function load() {
    showMsg("读取中…");
    return fetch("/api/settings", { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data || !data.ok) throw new Error((data && data.message) || "读取失败");
        var s = data.settings || {};
        var o = data.options || {};

        var ollama = (o.ollamaModels || []).filter(Boolean);
        // 读图候选只留看起来能读图的，免得把纯文本模型选来当眼睛
        var visionCand = ollama.filter(function (n) {
          return /vl|vision|llava|minicpm-v|moondream|gemma3/i.test(n);
        });
        fillSelect($("#setCopy"), ollama.map(function (n) { return { value: n, label: prettyModel(n) }; }),
          s.copy, "本机没有模型（先 ollama pull）");
        fillSelect($("#setVision"), visionCand.map(function (n) { return { value: n, label: n }; }),
          s.vision, "本机没有可读图的模型");

        var draw = o.drawingModels || [];
        // 头一项是空值 = 交回自动挑选。没有这一项的话，一旦选过具体模型就再也
        // 退不回自动，而提示里明明写着"留空表示自动挑选"。
        var drawItems = [{ value: "", label: "自动挑选（推荐）" }].concat(draw.map(function (m) {
          return { value: m.name, label: m.name + " · " + m.sizeGB + "GB" + (m.usable ? "" : "（不可用）") };
        }));
        fillSelect($("#setDrawing"), drawItems, s.drawingModel || "", "本机没有绘图模型");

        var dh = $("#setDrawingHint");
        if (dh) {
          dh.textContent = draw.length
            ? "当前生效：" + (o.activeDrawingModel || "（未知）") + (o.activeDrawingRoot ? " · " + o.activeDrawingRoot : "")
            : "本机没找到可用的 diffusers 模型目录。留空表示自动挑选。";
        }

        var vh = $("#setVisionHint");
        if (vh) {
          vh.textContent = o.visionRoute === "llm"
            ? "当前读图交给外面那个自带视觉的模型了，这一项暂不生效。"
            : "本机读图用哪个模型。图片会先缩到长边 896 再喂给它。";
        }

        var pt = $("#setPlanThinking");
        if (pt) pt.checked = !!s.planThinking;

        // 外接服务商时这两个是从服务商结构解析出来的，改了也会被解析结果盖回去，
        // 直接禁掉，免得用户以为改成功了
        var locked = !!s.activeProviderId;
        ["#setCopy", "#setVision"].forEach(function (sel) {
          var el = $(sel);
          if (el) {
            el.disabled = locked;
            el.title = locked ? "当前用的是外部服务商，本机模型不参与；去「模型」页切换" : "";
          }
        });
        showMsg(locked ? "当前用着外部服务商，本机模型那两栏不参与。" : "");
      })
      .catch(function (e) { showMsg("读取失败：" + (e.message || e), "err"); });
  }

  function save() {
    var btn = $("#setSave");
    var payload = {
      drawingModel: ($("#setDrawing") && $("#setDrawing").value) || "",
      planThinking: !!($("#setPlanThinking") && $("#setPlanThinking").checked),
    };
    // 外接服务商时这两个由服务商结构决定，不往上报
    var copyEl = $("#setCopy");
    var visEl = $("#setVision");
    if (copyEl && !copyEl.disabled && copyEl.value) payload.copy = copyEl.value;
    if (visEl && !visEl.disabled && visEl.value) payload.vision = visEl.value;

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
        // 必须**等 load() 铺完再写提示**。load() 是异步的，它末尾那句 showMsg("")
        // 会在几百毫秒后才跑，正好把刚显示出来的"已保存。"擦掉。
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

  /* ------------------------------------------------------------------ 开关 */

  function open() {
    var m = $("#settingsModal");
    if (!m) return;
    m.hidden = false;
    showPage("general");
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

    var items = document.querySelectorAll(".settings-nav-item");
    for (var i = 0; i < items.length; i++) {
      (function (btn) {
        btn.addEventListener("click", function () { showPage(btn.getAttribute("data-page")); });
      })(items[i]);
    }

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

    // 面板的明暗要跟着页面主题走（切换按钮在导航栏上，不在面板里）
    new MutationObserver(syncPanelTheme).observe(document.documentElement, {
      attributes: true, attributeFilter: ["data-theme"],
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
