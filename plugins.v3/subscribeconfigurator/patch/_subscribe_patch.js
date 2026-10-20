/* SubscribeConfigurator — frontend patch v12
 * v12 fixes a CRITICAL bug: MP's frontend bundles axios (XMLHttpRequest adapter), so the
 * v1..v11 window.fetch interceptor NEVER fired and no override was ever applied to the
 * subscribe POST. v12 patches XMLHttpRequest.prototype.open/send instead.
 * v12 also adds:
 *   - "清空全部" button in the panel header (overrides used to require devtools to clear)
 *   - active-override count badge so you can see what's queued
 *   - one-shot auto-clear after a successful subscribe (LS_ONESHOT_KEY)
 */
(function () {
  "use strict";

  const LS_OVERRIDES_KEY = "mp_subscribe_overrides";
  const LS_DEFAULT_EPISODE_KEY = "mp_subscribe_default_start_episode";
  const LS_ONESHOT_KEY = "mp_subscribe_oneshot";
  const PANEL_MARKER = "data-mp-subscribe-configurator";
  const API_BASE = "/api/v1";

  function readOverrides() {
    try { return JSON.parse(localStorage.getItem(LS_OVERRIDES_KEY) || "{}"); }
    catch (e) { return {}; }
  }
  function writeOverrides(obj) {
    try { localStorage.setItem(LS_OVERRIDES_KEY, JSON.stringify(obj)); }
    catch (e) {}
  }
  function clearOverrides() {
    try {
      localStorage.removeItem(LS_OVERRIDES_KEY);
      localStorage.removeItem(LS_DEFAULT_EPISODE_KEY);
    } catch (e) {}
  }
  function readDefaultEpisode() {
    const raw = localStorage.getItem(LS_DEFAULT_EPISODE_KEY);
    if (!raw) return 0;
    const n = parseInt(raw, 10);
    return isNaN(n) ? 0 : n;
  }
  function isOneShot() {
    try { return localStorage.getItem(LS_ONESHOT_KEY) === "1"; }
    catch (e) { return false; }
  }

  // Build the merged subscribe payload from current overrides.
  function mergeOverrides(payload) {
    const overrides = readOverrides();
    let changed = false;
    for (const k in overrides) {
      if (!Object.prototype.hasOwnProperty.call(overrides, k)) continue;
      const v = overrides[k];
      if (v === "" || v === null || v === undefined) continue;
      payload[k] = v;
      changed = true;
    }
    const defaultEp = readDefaultEpisode();
    if (defaultEp > 0 && (!payload.start_episode || payload.start_episode === 0)) {
      payload.start_episode = defaultEp;
      changed = true;
    }
    return changed;
  }

  function maybeOneShot() {
    if (!isOneShot()) return;
    clearOverrides();
    try { localStorage.removeItem(LS_ONESHOT_KEY); } catch (e) {}
    console.info("[subscribeconfigurator v12] one-shot applied, overrides cleared");
  }

  // ── XHR interception (this is the path MP/axios actually uses) ──
  if (window.XMLHttpRequest && !window.__mp_sc_xhr_patched) {
    window.__mp_sc_xhr_patched = true;
    const OrigOpen = XMLHttpRequest.prototype.open;
    const OrigSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (method, url) {
      try {
        this.__mpMethod = String(method || "GET").toUpperCase();
        this.__mpUrl = String(url || "");
      } catch (e) {}
      return OrigOpen.apply(this, arguments);
    };

    XMLHttpRequest.prototype.send = function (body) {
      try {
        const method = this.__mpMethod || "GET";
        const url = this.__mpUrl || "";
        if (method === "POST" && url.indexOf("/subscribe") !== -1 &&
            typeof body === "string" && body.charAt(0) === "{") {
          const payload = JSON.parse(body);
          if (mergeOverrides(payload)) {
            body = JSON.stringify(payload);
            console.info("[subscribeconfigurator v12] overrides merged into subscribe POST");
          }
        }
      } catch (e) {}
      return OrigSend.call(this, body);
    };
  }

  // ── fetch interception (kept as a fallback for any fetch-based code path) ──
  const OrigFetch = window.fetch;
  window.fetch = function (resource, init) {
    try {
      const url = typeof resource === "string" ? resource : (resource && resource.url) || "";
      const method = ((init && init.method) || "GET").toUpperCase();
      if (method === "POST" && url.indexOf("/subscribe") !== -1 && init && init.body &&
          typeof init.body === "string" && init.body.charAt(0) === "{") {
        const payload = JSON.parse(init.body);
        if (mergeOverrides(payload)) init.body = JSON.stringify(payload);
      }
    } catch (e) {}
    return OrigFetch.apply(this, arguments);
  };

  // Clear overrides right after the request that carried them succeeds.
  (function watchOneShot() {
    if (!window.XMLHttpRequest) return;
    const OrigSend2 = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function (body) {
      const xhr = this;
      if (xhr.__mpMethod === "POST" && (xhr.__mpUrl || "").indexOf("/subscribe") !== -1) {
        xhr.addEventListener("load", function () {
          try { if (xhr.status >= 200 && xhr.status < 300) maybeOneShot(); }
          catch (e) {}
        });
      }
      return OrigSend2.call(this, body);
    };
  })();

  // ── DOM helpers ──
  function el(tag, props, children) {
    const node = document.createElement(tag);
    if (props) {
      for (const k in props) {
        if (k === "style") node.style.cssText = props[k];
        else if (k === "text") node.textContent = props[k];
        else if (k.indexOf("on") === 0 && typeof props[k] === "function")
          node.addEventListener(k.slice(2).toLowerCase(), props[k]);
        else node.setAttribute(k, props[k]);
      }
    }
    if (children) {
      for (let i = 0; i < children.length; i++) {
        const c = children[i];
        if (c == null) continue;
        node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
      }
    }
    return node;
  }

  function commitValue(model, val) {
    const next = readOverrides();
    if (val === "" || val === null || val === undefined) delete next[model];
    else next[model] = val;
    writeOverrides(next);
  }

  // ── Option sources (mirroring MP's own data sources) ──
  const NATIVE_OPTIONS = {
    quality: ["蓝光原盘", "Remux", "BluRay", "UHD", "WEB-DL", "HDTV", "H265", "H264"],
    resolution: ["4k", "1080p", "720p"],
    effect: ["杜比视界", "杜比全景声", "HDR", "SDR"],
    season: Array.from({ length: 101 }, (_, i) => String(i)),
  };

  // ── Field builders ──
  function buildTextField(field, overrides, defaultEp) {
    const wrap = el("div", { class: "mp-sc-field" });
    const cur = overrides[field.model];
    const hasValue = cur !== undefined && cur !== null && cur !== "";
    const displayVal = hasValue
      ? String(cur)
      : (field.model === "start_episode" && defaultEp > 0 ? String(defaultEp) : "");

    const input = el("input", {
      type: field.type || "text",
      placeholder: " ",
      "data-mp-model": field.model,
      class: "mp-sc-input",
      autocomplete: "off",
      spellcheck: false,
    });
    input.value = displayVal;
    const label = el("label", { class: "mp-sc-label", text: field.label });
    const hint = field.placeholder && !hasValue
      ? el("div", { class: "mp-sc-hint", text: field.placeholder }) : null;

    input.addEventListener("input", function () {
      const val = input.value.trim();
      if (val === "") commitValue(field.model, "");
      else if (field.type === "number") {
        const n = parseInt(val, 10);
        commitValue(field.model, isNaN(n) ? "" : n);
      } else commitValue(field.model, val);
    });

    wrap.appendChild(input);
    wrap.appendChild(label);
    if (hint) wrap.appendChild(hint);
    return wrap;
  }

  function buildSelectField(field, overrides) {
    const wrap = el("div", { class: "mp-sc-field mp-sc-field--select" });
    const cur = overrides[field.model];
    const current = cur === undefined || cur === null ? "" : String(cur);
    const isNative = current === "" || field.options.indexOf(current) !== -1;

    const box = el("div", { class: "mp-sc-selectbox" });
    const select = el("select", { class: "mp-sc-select", "data-mp-model": field.model });
    select.appendChild(el("option", { value: "" }));
    field.options.forEach(function (opt) {
      select.appendChild(el("option", { value: opt, text: field.optionLabel ? field.optionLabel(opt) : opt }));
    });
    select.appendChild(el("option", { value: "__custom__", text: "自定义…" }));
    select.value = isNative ? current : "__custom__";

    box.appendChild(select);
    box.appendChild(el("label", { class: "mp-sc-label", text: field.label }));

    const customWrap = el("div", { class: "mp-sc-custom", style: "display:none" });
    const customInput = el("input", {
      type: "text", class: "mp-sc-input", placeholder: "自定义值",
      "data-mp-custom": field.model, autocomplete: "off",
    });
    if (!isNative && current) customInput.value = current;
    customWrap.appendChild(customInput);
    wrap.appendChild(box);
    wrap.appendChild(customWrap);

    select.addEventListener("change", function () {
      const v = select.value;
      if (v === "__custom__") {
        customWrap.style.display = "block";
        customInput.focus();
        return;
      }
      customWrap.style.display = "none";
      customInput.value = "";
      commitValue(field.model, v);
    });
    customInput.addEventListener("input", function () {
      commitValue(field.model, customInput.value.trim());
    });
    if (!isNative && current) customWrap.style.display = "block";
    return wrap;
  }

  // Multi-select backed by an async API list. Renders a placeholder select that
  // swaps in options once loaded; on failure it degrades to a comma-separated
  // text input so the field is never a dead end.
  function buildAsyncMultiField(field, overrides) {
    const wrap = el("div", { class: "mp-sc-field" });
    const cur = overrides[field.model];
    const selected = Array.isArray(cur) ? cur.slice() : (cur ? [String(cur)] : []);

    const label = el("label", { class: "mp-sc-label", text: field.label });
    const select = el("select", { class: "mp-sc-select mp-sc-select--multi", multiple: "", size: "4", "data-mp-model": field.model });
    select.disabled = true;
    select.appendChild(el("option", { value: "", text: "加载中…" }));
    wrap.appendChild(select);
    wrap.appendChild(label);

    const hint = el("div", { class: "mp-sc-hint", text: field.placeholder || "" });

    function applyList(items) {
      // items: [{value, label}]
      select.innerHTML = "";
      items.forEach(function (it) {
        select.appendChild(el("option", { value: it.value, text: it.label }));
      });
      select.disabled = false;
      Array.prototype.forEach.call(select.options, function (o) {
        if (selected.indexOf(o.value) !== -1) o.selected = true;
      });
      select.addEventListener("change", function () {
        const vals = Array.prototype.filter.call(select.options, function (o) { return o.selected; })
          .map(function (o) { return o.value; });
        commitValue(field.model, vals.length ? vals : "");
      });
    }

    function degrade() {
      const ta = el("textarea", {
        class: "mp-sc-input mp-sc-textarea",
        rows: "2",
        placeholder: "加载失败，手动填写（多个用空格分隔）",
      });
      ta.value = selected.join(" ");
      ta.addEventListener("input", function () {
        const vals = ta.value.split(/\s+/).filter(Boolean);
        commitValue(field.model, vals.length ? vals : "");
      });
      select.replaceWith(ta);
      wrap.appendChild(hint);
      if (!hint.parentNode) wrap.appendChild(hint);
    }

    fetch(API_BASE + field.api, { credentials: "same-origin" })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); })
      .then(function (json) {
        const data = json && json.data !== undefined ? json.data : json;
        const items = (data || []).map(field.mapItem);
        applyList(items);
        wrap.appendChild(hint);
      })
      .catch(function () { degrade(); });

    return wrap;
  }

  // Single-select backed by an async API list; degrades to free text on failure.
  function buildAsyncSingleField(field, overrides) {
    const wrap = el("div", { class: "mp-sc-field mp-sc-field--select" });
    const cur = overrides[field.model];
    const current = cur === undefined || cur === null ? "" : String(cur);

    const box = el("div", { class: "mp-sc-selectbox" });
    const select = el("select", { class: "mp-sc-select", "data-mp-model": field.model });
    select.appendChild(el("option", { value: "", text: "加载中…" }));
    box.appendChild(select);
    box.appendChild(el("label", { class: "mp-sc-label", text: field.label }));
    wrap.appendChild(box);

    const customWrap = el("div", { class: "mp-sc-custom", style: "display:none" });
    const customInput = el("input", {
      type: "text", class: "mp-sc-input", placeholder: "自定义值",
      "data-mp-custom": field.model, autocomplete: "off",
    });
    if (current && !select.value) customInput.value = current;
    customWrap.appendChild(customInput);
    wrap.appendChild(customWrap);

    select.addEventListener("change", function () {
      const v = select.value;
      if (v === "__custom__") { customWrap.style.display = "block"; customInput.focus(); return; }
      customWrap.style.display = "none";
      customInput.value = "";
      commitValue(field.model, v);
    });
    customInput.addEventListener("input", function () {
      commitValue(field.model, customInput.value.trim());
    });

    fetch(API_BASE + field.api, { credentials: "same-origin" })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); })
      .then(function (json) {
        const data = json && json.data !== undefined ? json.data : json;
        const items = (data || []).map(field.mapItem);
        select.innerHTML = "";
        select.appendChild(el("option", { value: "" }));
        items.forEach(function (it) {
          select.appendChild(el("option", { value: it.value, text: it.label }));
        });
        select.appendChild(el("option", { value: "__custom__", text: "自定义…" }));
        const matched = items.some(function (it) { return it.value === current; });
        select.value = current === "" ? "" : (matched ? current : "__custom__");
        if (!matched && current) { customWrap.style.display = "block"; customInput.value = current; }
      })
      .catch(function () {
        // API unavailable (e.g. auth) — expose a plain text input instead.
        select.replaceWith(customInput);
        customWrap.remove();
      });

    return wrap;
  }

  function buildSwitchField(field, overrides) {
    const wrap = el("div", { class: "mp-sc-field mp-sc-field--switch" });
    const cur = overrides[field.model];
    const on = field.model === "best_version" || field.model === "best_version_full" || field.model === "search_imdbid"
      ? cur === true || cur === 1 || cur === "1"
      : cur === true;

    const input = el("input", { type: "checkbox", class: "mp-sc-checkbox", "data-mp-model": field.model });
    input.checked = on;
    input.addEventListener("change", function () { commitValue(field.model, input.checked ? true : ""); });
    wrap.appendChild(input);
    wrap.appendChild(el("label", { class: "mp-sc-switchlabel", text: field.label }));
    if (field.hint) wrap.appendChild(el("div", { class: "mp-sc-hint", text: field.hint }));
    return wrap;
  }

  function buildField(field, overrides, defaultEp) {
    if (field.kind === "async-multi") return buildAsyncMultiField(field, overrides);
    if (field.kind === "async-single") return buildAsyncSingleField(field, overrides);
    if (field.kind === "switch") return buildSwitchField(field, overrides);
    if (field.kind === "select") return buildSelectField(field, overrides);
    return buildTextField(field, overrides, defaultEp);
  }

  // ── Field definitions (mirroring MP EditDialog) ──
  const BASIC_FIELDS = [
    { model: "keyword", label: "搜索关键词", kind: "text", type: "text", placeholder: "指定搜索站点时使用的关键词" },
    { model: "total_episode", label: "总集数", kind: "text", type: "number", placeholder: "剧集总集数" },
    { model: "start_episode", label: "开始集数", kind: "text", type: "number", placeholder: "0 = 不指定" },
    { model: "quality", label: "质量", kind: "select", options: NATIVE_OPTIONS.quality },
    { model: "resolution", label: "分辨率", kind: "select", options: NATIVE_OPTIONS.resolution },
    { model: "effect", label: "特效", kind: "select", options: NATIVE_OPTIONS.effect },
    { model: "sites", label: "订阅站点", kind: "async-multi", api: "/site", placeholder: "留空 = 使用系统设置",
      mapItem: function (s) { return { value: s.name, label: s.name }; } },
    { model: "downloader", label: "下载器", kind: "async-single", api: "/download/clients", placeholder: "留空 = 使用默认",
      mapItem: function (d) { return { value: d.name, label: d.name }; } },
    { model: "best_version", label: "洗版", kind: "switch", hint: "根据洗版优先级进行洗版订阅" },
    { model: "best_version_full", label: "全集洗版", kind: "switch", hint: "对全集进行洗版（电视剧）" },
    { model: "search_imdbid", label: "使用 ImdbID 搜索", kind: "switch", hint: "开启后使用 ImdbID 精确搜索资源" },
  ];

  const ADVANCE_FIELDS = [
    { model: "filter", label: "过滤规则", kind: "text", type: "text", placeholder: "空格分隔（MP schema 字段，原生 UI 未暴露）" },
    { model: "include", label: "包含关键词", kind: "text", type: "text", placeholder: "关键字 / 正则，空格分隔" },
    { model: "exclude", label: "排除关键词", kind: "text", type: "text", placeholder: "关键字 / 正则，空格分隔" },
    { model: "season", label: "指定季", kind: "select", options: NATIVE_OPTIONS.season, optionLabel: function (v) { return v === "0" ? "特别篇" : "第 " + v + " 季"; } },
    { model: "episode_group", label: "剧集组", kind: "text", type: "text", placeholder: "按特定剧集组识别和刮削" },
    { model: "media_category", label: "自定义类别", kind: "text", type: "text", placeholder: "留空自动识别" },
    { model: "custom_words", label: "自定义过滤词", kind: "text", type: "text", placeholder: "自定义下载过滤词" },
  ];

  function buildTab(labelText, fields, overrides, defaultEp) {
    const tab = el("div", { class: "mp-sc-tabpane", style: "display:none" });
    const grid = el("div", { class: "mp-sc-grid" });
    fields.forEach(function (f) { grid.appendChild(buildField(f, overrides, defaultEp)); });
    tab.appendChild(grid);
    tab.setAttribute("data-label", labelText);
    return tab;
  }

  function buildPanel() {
    const overrides = readOverrides();
    const defaultEp = readDefaultEpisode();

    const panel = el("div", { [PANEL_MARKER]: "v12", class: "mp-sc-panel" });

    // Header row: title + active-count badge + clear button
    const header = el("div", { class: "mp-sc-header" });
    const hrow = el("div", { class: "mp-sc-hrow" });

    const activeCount = Object.keys(overrides).length + (defaultEp > 0 ? 1 : 0);
    hrow.appendChild(el("div", {
      class: "mp-sc-title",
      text: "订阅增强（SubscribeConfigurator）",
    }));
    hrow.appendChild(el("span", {
      class: "mp-sc-badge" + (activeCount ? " mp-sc-badge--on" : ""),
      text: activeCount ? ("已填 " + activeCount + " 项") : "未填写",
    }));

    const clearBtn = el("button", { type: "button", class: "mp-sc-clear", text: "清空全部" });
    clearBtn.addEventListener("click", function () {
      clearOverrides();
      try { localStorage.removeItem(LS_ONESHOT_KEY); } catch (e) {}
      const stale = panel.querySelectorAll("[" + PANEL_MARKER + "]");
      // re-render the panel body in place
      const fresh = buildPanel();
      panel.parentNode.replaceChild(fresh, panel);
      console.info("[subscribeconfigurator v12] overrides cleared by user");
    });
    hrow.appendChild(clearBtn);
    header.appendChild(hrow);

    header.appendChild(el("div", {
      class: "mp-sc-hint",
      text: "字段值保存到 localStorage，提交订阅时自动附加。可在订阅详情页继续编辑。",
    }));

    // One-shot toggle
    const osLabel = el("label", { class: "mp-sc-oneshot" });
    const osInput = el("input", { type: "checkbox", class: "mp-sc-checkbox" });
    osInput.checked = isOneShot();
    osInput.addEventListener("change", function () {
      try {
        if (osInput.checked) localStorage.setItem(LS_ONESHOT_KEY, "1");
        else localStorage.removeItem(LS_ONESHOT_KEY);
      } catch (e) {}
    });
    osLabel.appendChild(osInput);
    osLabel.appendChild(el("span", { text: "一次性（提交一次后自动清空）" }));
    header.appendChild(osLabel);

    panel.appendChild(header);

    // Tabs (basic / advance) mirroring MP's own layout
    const tabs = el("div", { class: "mp-sc-tabs" });
    const panes = el("div", { class: "mp-sc-panes" });
    const basicPane = buildTab("基础", BASIC_FIELDS, overrides, defaultEp);
    const advPane = buildTab("进阶", ADVANCE_FIELDS, overrides, defaultEp);
    panes.appendChild(basicPane);
    panes.appendChild(advPane);

    function makeTabBtn(name, pane, active) {
      const b = el("button", { type: "button", class: "mp-sc-tabbtn" + (active ? " mp-sc-tabbtn--active" : ""), text: name });
      b.addEventListener("click", function () {
        Array.prototype.forEach.call(tabs.children, function (c) { c.classList.remove("mp-sc-tabbtn--active"); });
        b.classList.add("mp-sc-tabbtn--active");
        basicPane.style.display = pane === basicPane ? "block" : "none";
        advPane.style.display = pane === advPane ? "block" : "none";
      });
      return b;
    }
    tabs.appendChild(makeTabBtn("基础", basicPane, true));
    tabs.appendChild(makeTabBtn("进阶", advPane, false));

    panel.appendChild(tabs);
    panel.appendChild(panes);
    basicPane.style.display = "block";
    advPane.style.display = "none";

    injectStyles();
    return panel;
  }

  // ── Styles ──
  let stylesInjected = false;
  function injectStyles() {
    if (stylesInjected || document.getElementById("mp-sc-styles")) { stylesInjected = true; return; }
    const style = document.createElement("style");
    style.id = "mp-sc-styles";
    style.textContent = CSS;
    document.head.appendChild(style);
    stylesInjected = true;
  }

  const CSS = [
    ".mp-sc-panel{margin-top:12px;padding:16px;border-radius:8px;background:rgb(var(--v-theme-surface));color:rgb(var(--v-theme-on-surface));border:1px solid rgba(var(--v-theme-on-surface),var(--v-border-opacity));font-family:inherit}",
    ".mp-sc-header{margin-bottom:12px}",
    ".mp-sc-title{font-size:14px;font-weight:500;letter-spacing:.0125em;margin-bottom:4px;color:rgba(var(--v-theme-on-surface),var(--v-high-emphasis-opacity))}",
    ".mp-sc-hint{font-size:12px;line-height:1.5;color:rgba(var(--v-theme-on-surface),var(--v-medium-emphasis-opacity))}",
    ".mp-sc-hrow{display:flex;align-items:center;gap:8px;margin-bottom:4px;flex-wrap:wrap}",
    ".mp-sc-badge{font-size:11px;padding:2px 8px;border-radius:10px;background:rgba(var(--v-theme-on-surface),.12);color:rgba(var(--v-theme-on-surface),var(--v-medium-emphasis-opacity))}",
    ".mp-sc-badge--on{background:rgba(var(--v-theme-primary),.16);color:rgb(var(--v-theme-primary))}",
    ".mp-sc-clear{margin-left:auto;background:none;border:1px solid rgba(var(--v-theme-on-surface),.38);border-radius:4px;padding:2px 10px;font:inherit;font-size:12px;color:rgba(var(--v-theme-on-surface),var(--v-medium-emphasis-opacity));cursor:pointer;transition:border-color .15s,color .15s}",
    ".mp-sc-clear:hover{border-color:rgb(var(--v-theme-primary));color:rgb(var(--v-theme-primary))}",
    ".mp-sc-oneshot{display:flex;align-items:center;gap:6px;margin-top:8px;font-size:12px;color:rgba(var(--v-theme-on-surface),var(--v-medium-emphasis-opacity));cursor:pointer}",
    ".mp-sc-tabs{display:flex;gap:8px;margin-bottom:16px;border-bottom:1px solid rgba(var(--v-theme-on-surface),var(--v-border-opacity))}",
    ".mp-sc-tabbtn{background:none;border:none;padding:8px 4px;margin-bottom:-1px;font:inherit;font-size:14px;font-weight:500;color:rgba(var(--v-theme-on-surface),var(--v-medium-emphasis-opacity));cursor:pointer;border-bottom:2px solid transparent;transition:color .15s,border-color .15s}",
    ".mp-sc-tabbtn--active{color:rgb(var(--v-theme-primary));border-bottom-color:rgb(var(--v-theme-primary))}",
    ".mp-sc-grid{display:grid;grid-template-columns:1fr;gap:4px 16px}",
    "@media (min-width:700px){.mp-sc-grid{grid-template-columns:repeat(2,1fr)}}",
    "@media (min-width:1024px){.mp-sc-grid{grid-template-columns:repeat(3,1fr)}}",
    ".mp-sc-field{position:relative;padding-top:14px;padding-bottom:8px}",
    ".mp-sc-input{width:100%;box-sizing:border-box;padding:8px 12px;font:inherit;font-size:14px;color:rgb(var(--v-theme-on-surface));background:transparent;border:1px solid rgba(var(--v-theme-on-surface),.38);border-radius:4px;outline:none;transition:border-color .18s,border-width .18s}",
    ".mp-sc-input:hover{border-color:rgba(var(--v-theme-on-surface),.6)}",
    ".mp-sc-input:focus{border-color:rgb(var(--v-theme-primary));border-width:2px;padding:7px 11px}",
    ".mp-sc-textarea{min-height:56px;resize:vertical}",
    ".mp-sc-label{position:absolute;left:12px;top:22px;font-size:14px;line-height:1;color:rgba(var(--v-theme-on-surface),.6);background:rgb(var(--v-theme-surface));padding:0 4px;pointer-events:none;transition:top .18s,font-size .18s,color .18s}",
    ".mp-sc-input:focus~.mp-sc-label,.mp-sc-input:not(:placeholder-shown)~.mp-sc-label{top:8px;font-size:12px;color:rgb(var(--v-theme-primary))}",
    ".mp-sc-input:not(:focus):not(:placeholder-shown)~.mp-sc-label{color:rgba(var(--v-theme-on-surface),var(--v-high-emphasis-opacity))}",
    ".mp-sc-field .mp-sc-hint{font-size:11px;margin-top:2px;margin-left:12px;color:rgba(var(--v-theme-on-surface),var(--v-medium-emphasis-opacity))}",
    ".mp-sc-selectbox{position:relative;display:block}",
    ".mp-sc-select{width:100%;box-sizing:border-box;padding:20px 32px 8px 12px;font:inherit;font-size:14px;color:rgb(var(--v-theme-on-surface));background:transparent;border:1px solid rgba(var(--v-theme-on-surface),.38);border-radius:4px;outline:none;appearance:none;-webkit-appearance:none;cursor:pointer;transition:border-color .18s,border-width .18s}",
    ".mp-sc-select:hover{border-color:rgba(var(--v-theme-on-surface),.6)}",
    ".mp-sc-select:focus{border-color:rgb(var(--v-theme-primary));border-width:2px;padding:19px 31px 7px 11px}",
    ".mp-sc-select--multi{padding-top:20px;min-height:96px}",
    ".mp-sc-selectbox::after{content:'';position:absolute;right:12px;top:50%;width:7px;height:7px;margin-top:-6px;border-right:2px solid rgba(var(--v-theme-on-surface),.6);border-bottom:2px solid rgba(var(--v-theme-on-surface),.6);transform:rotate(45deg);pointer-events:none}",
    ".mp-sc-selectbox .mp-sc-label{top:8px;font-size:12px}",
    ".mp-sc-select:focus~.mp-sc-label,.mp-sc-selectbox:hover .mp-sc-label{color:rgb(var(--v-theme-primary))}",
    ".mp-sc-custom{margin-top:6px}",
    ".mp-sc-field--switch{display:flex;align-items:center;gap:8px;padding-top:18px}",
    ".mp-sc-checkbox{width:20px;height:20px;accent-color:rgb(var(--v-theme-primary));cursor:pointer}",
    ".mp-sc-switchlabel{font-size:14px;cursor:pointer}",
  ].join("");

  // ── Injection ──
  function tryInject(root) {
    if (!root || typeof root.querySelectorAll !== "function") return;
    const candidates = root.querySelectorAll(
      ".v-dialog, .v-overlay__content, [role=\"dialog\"]"
    );
    let injected = 0;
    candidates.forEach(function (dialog, idx) {
      if (!dialog) return;
      const old = dialog.querySelector('[data-mp-subscribe-configurator]');
      if (old) old.remove();
      if (dialog.__mp_sc_patched) return;
      if (dialog.classList && dialog.classList.contains("v-card-link")) return;
      const text = (dialog.textContent || "").trim();
      if (text.length < 4) return;
      if (text.indexOf("开始集数") !== -1) return;
      if (text.indexOf("总集数") !== -1) return;
      const btns = dialog.querySelectorAll("button, .v-btn");
      let isAdd = false;
      for (let i = 0; i < btns.length; i++) {
        const btnText = (btns[i].textContent || "").trim();
        if (/^提交订阅$|^添加订阅$|^新增订阅$|^请选择订阅季$/.test(btnText)) isAdd = true;
        if (btnText === "保存" && text.indexOf("编辑订阅") !== -1) return;
      }
      if (!isAdd) return;
      const target = dialog.querySelector(".v-card-text, .v-card, form, .v-overlay__content") || dialog;
      target.appendChild(buildPanel());
      dialog.__mp_sc_patched = true;
      injected += 1;
    });
    if (injected > 0) {
      console.info("[subscribeconfigurator v12] injected into " + injected + " dialog(s)");
    }
  }

  function attach() {
    tryInject(document.body);
    const obs = new MutationObserver(function (muts) {
      muts.forEach(function (m) {
        for (let i = 0; i < m.addedNodes.length; i++) {
          const n = m.addedNodes[i];
          if (n && n.nodeType === 1) tryInject(n);
        }
      });
    });
    obs.observe(document.body, { childList: true, subtree: true });
    console.info("[subscribeconfigurator v12] loaded, MutationObserver active");
  }

  window.addEventListener("error", function (e) {
    if (e && e.filename && String(e.filename).indexOf("_subscribe_patch") !== -1) {
      console.error("[subscribeconfigurator v12] SCRIPT ERROR", e.message, ":" + e.lineno);
    }
  });

  try {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", attach);
    else attach();
  } catch (e) {
    console.error("[subscribeconfigurator v12] FATAL on attach", e);
  }
})();