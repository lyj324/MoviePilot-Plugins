/* SubscribeConfigurator — frontend patch v13
 * v13 replaces native <select> with a custom dropdown (native select renders its popup
 * with the OS, so CSS cannot theme it and it reads as a light box on MP's dark dialog).
 * The menu is teleported to document.body with fixed positioning so the dialog's
 * overflow can never clip it — same technique Vuetify uses.
 * Also in v13: switches moved to a dedicated full-width row (no more wrapped labels),
 * missing native fields added (search_interval / save_path), and mdi icons copied from
 * MP's own EditDialog markup for visual parity.
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
      localStorage.removeItem(LS_ONESHOT_KEY);
    } catch (e) {}
  }
  function readDefaultEpisode() {
    const raw = localStorage.getItem(LS_DEFAULT_EPISODE_KEY);
    if (!raw) return 0;
    const n = parseInt(raw, 10);
    return isNaN(n) ? 0 : n;
  }
  function isOneShot() {
    try { return localStorage.getItem(LS_ONESHOT_KEY) === "1"; } catch (e) { return false; }
  }

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
    console.info("[subscribeconfigurator v13] one-shot applied, overrides cleared");
  }

  // ── transport interception (MP uses axios → XMLHttpRequest) ──
  if (window.XMLHttpRequest && !window.__mp_sc_xhr_patched) {
    window.__mp_sc_xhr_patched = true;
    const OrigOpen = XMLHttpRequest.prototype.open;
    const OrigSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
      try { this.__mpMethod = String(method || "GET").toUpperCase(); this.__mpUrl = String(url || ""); }
      catch (e) {}
      return OrigOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function (body) {
      try {
        if ((this.__mpMethod || "") === "POST" && (this.__mpUrl || "").indexOf("/subscribe") !== -1 &&
            typeof body === "string" && body.charAt(0) === "{") {
          const payload = JSON.parse(body);
          if (mergeOverrides(payload)) {
            body = JSON.stringify(payload);
            console.info("[subscribeconfigurator v13] overrides merged into subscribe POST");
          }
        }
      } catch (e) {}
      const xhr = this;
      if (xhr.__mpMethod === "POST" && (xhr.__mpUrl || "").indexOf("/subscribe") !== -1) {
        xhr.addEventListener("load", function () {
          try { if (xhr.status >= 200 && xhr.status < 300) maybeOneShot(); } catch (e) {}
        });
      }
      return OrigSend.call(this, body);
    };
  }

  const OrigFetch = window.fetch;
  window.fetch = function (resource, init) {
    try {
      const url = typeof resource === "string" ? resource : (resource && resource.url) || "";
      if (((init && init.method) || "GET").toUpperCase() === "POST" &&
          url.indexOf("/subscribe") !== -1 && init && typeof init.body === "string" &&
          init.body.charAt(0) === "{") {
        const payload = JSON.parse(init.body);
        if (mergeOverrides(payload)) init.body = JSON.stringify(payload);
      }
    } catch (e) {}
    return OrigFetch.apply(this, arguments);
  };

  // ── helpers ──
  function el(tag, props, children) {
    const node = document.createElement(tag);
    if (props) {
      for (const k in props) {
        if (k === "style") node.style.cssText = props[k];
        else if (k === "text") node.textContent = props[k];
        // `html` is only ever fed the hardcoded ICONS.* SVG constants defined below —
        // never user input or DOM-derived text (that always goes through `text`).
        else if (k === "html") node.innerHTML = props[k];
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
    else if (model === "search_interval") {
      // MP schema: null = follow system, otherwise int hours
      const n = parseInt(val, 10);
      if (isNaN(n)) delete next[model]; else next[model] = n;
    } else if (model === "season" || model === "total_episode" || model === "start_episode") {
      const n = parseInt(val, 10);
      if (isNaN(n)) delete next[model]; else next[model] = n;
    } else next[model] = val;
    writeOverrides(next);
  }
  const svgIcon = (d, extra) =>
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-hidden="true" ' +
    'style="font-size:20px;width:20px;height:20px;flex:0 0 auto;" ' + (extra || "") + '>' +
    '<path fill="currentColor" d="' + d + '"></path></svg>';

  const ICONS = {
    search: "M9.5 3A6.5 6.5 0 0 1 16 9.5c0 1.61-.59 3.09-1.56 4.23l.27.27h.79l5 5-1.5 1.5-5-5v-.79l-.27-.27A6.52 6.52 0 0 1 9.5 16 6.5 6.5 0 0 1 3 9.5 6.5 6.5 0 0 1 9.5 3m0 2C7 5 5 7 5 9.5S7 14 9.5 14 14 12 14 9.5 12 5 9.5 5",
    list: "M3 10h11v2H3zm0-4h11v2H3zm0 8h7v2H3zm13-1v8l6-4z",
    play: "M12 20a7 7 0 0 1-7-7 7 7 0 0 1 7-7 7 7 0 0 1 7 7 7 7 0 0 1-7 7m7.03-12.61 2.42-2.42-.45-.45-2.42 2.42A7 7 0 0 0 12 4a8 8 0 0 0-8 8 8 8 0 0 0 8 8 8 8 0 0 0 6.03-2.61",
    hd: "M14.5 13.5h2v-3h-2M18 14a1 1 0 0 1-1 1h-.75v1.5h-1.5V15H14a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1m-7 5H9.5v-2h-2v2H6V9h1.5v2.5h2V9H11m8-5H5c-1.11 0-2 .89-2 2v12a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2",
    monitor: "M21 16H3V4h18m0-2H3a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h7v2H8v2h8v-2h-2v-2h7a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2",
    wand: "M15.14 3c-.51 0-1.02.2-1.41.59L2.59 14.73c-.78.78-.78 2.05 0 2.83s2.05.78 2.83 0L18.41 9.14V7.5h-1.5V3zM2 21h2v2H2zM7.5 9.5 9 11l-1.5 1.5L6 11zm6.5-1.5 2 2-1.5 1.5-2-2z",
    globe: "M12 2a10 10 0 0 1 10 10 10 10 0 0 1-10 10A10 10 0 0 1 2 12 10 10 0 0 1 12 2m0 2a8 8 0 0 0-6.32 3.1A19.8 19.8 0 0 1 10.5 10C10.17 7.72 10 5.35 10 3.46A8 8 0 0 1 12 4m4.54 2.06c-.27 2.02-.72 4.55-1.63 6.92A8 8 0 0 0 19.4 7.1 8 8 0 0 0 12 4m-2 12.54c.26-2.03.71-4.55 1.62-6.92A8 8 0 0 0 4.6 16.9 8 8 0 0 0 10 20m7.54-2.06c-.27-2.02-.71-4.55-1.62-6.92a8 8 0 0 0 7.48 4.38A8 8 0 0 1 10 20m1-16a19.9 19.9 0 0 1 4.82 4.9A8 8 0 0 0 10.5 10c.33 2.28.5 4.65.5 6.54A8 8 0 0 1 4.6 7.1 8 8 0 0 1 11 4",
    download: "M19 9h-4V3H9v6H5l7 7zM5 18v2h14v-2z",
    folder: "M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8z",
    timer: "M15 1H9v2h6zm-4 13h2V8h-2zm8.03-6.61 1.42-1.42a11 11 0 0 0-1.42-1.42l-1.42 1.42A9 9 0 1 0 19.03 7.39z",
    filter: "M14 12v7.88a1 1 0 0 1-.29.84l-5 5a1 1 0 0 1-1.41-1.41L12.21 19H11a7 7 0 1 1 3-11.88z",
    minus: "M19 13H5v-2h14z",
    plus: "M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6z",
  };

  // ── custom dropdown (teleported to body, fixed positioned) ──
  let openMenu = null;
  function closeOpenMenu() {
    if (openMenu) { try { openMenu.el.remove(); } catch (e) {} try { openMenu.anchor.classList.remove("mp-sc-dd--open"); } catch (e) {} openMenu = null; }
  }
  document.addEventListener("click", function (ev) {
    if (openMenu && !openMenu.el.contains(ev.target) && !openMenu.anchor.contains(ev.target)) closeOpenMenu();
  }, true);
  document.addEventListener("keydown", function (ev) { if (ev.key === "Escape") closeOpenMenu(); });
  window.addEventListener("resize", closeOpenMenu);

  function openDropdown(anchor, items, opts) {
    // toggle
    if (openMenu && openMenu.anchor === anchor) { closeOpenMenu(); return; }
    closeOpenMenu();
    const rect = anchor.getBoundingClientRect();
    const menu = el("div", { class: "mp-sc-menu" });
    const list = el("div", { class: "mp-sc-menu__list" });
    items.forEach(function (it) {
      const row = el("div", { class: "mp-sc-menu__item" + (it.selected ? " mp-sc-menu__item--sel" : "") },
        [el("span", { class: "mp-sc-menu__title", text: it.label })]);
      if (opts && opts.multi) {
        const box = el("span", { class: "mp-sc-cb" + (it.selected ? " mp-sc-cb--on" : "") });
        row.insertBefore(box, row.firstChild);
        row.addEventListener("click", function (ev) {
          ev.stopPropagation();
          it.onSelect();
          const nowSel = !it.selected;
          it.selected = nowSel;
          box.classList.toggle("mp-sc-cb--on", nowSel);
          row.classList.toggle("mp-sc-menu__item--sel", nowSel);
        });
      } else {
        row.addEventListener("click", function () { it.onSelect(); closeOpenMenu(); refresh(); });
      }
      list.appendChild(row);
    });
    menu.appendChild(list);
    menu.style.position = "fixed";
    menu.style.left = rect.left + "px";
    menu.style.width = rect.width + "px";
    menu.style.top = (rect.bottom + 4) + "px";
    document.body.appendChild(menu);
    // flip up if not enough room below
    requestAnimationFrame(function () {
      const h = menu.offsetHeight;
      if (rect.bottom + 4 + h > window.innerHeight - 8) {
        menu.style.top = Math.max(8, rect.top - h - 4) + "px";
      }
    });
    anchor.classList.add("mp-sc-dd--open");
    openMenu = { el: menu, anchor: anchor, refresh: opts && opts.refresh };
    var refresh = opts && opts.refresh;
  }

  function buildDropdown(field, overrides) {
    const wrap = el("div", { class: "mp-sc-field mp-sc-dd" });
    const cur = overrides[field.model];
    const current = cur === undefined || cur === null ? "" : String(cur);
    const isNative = current === "" || field.options.indexOf(current) !== -1;

    const anchor = el("div", { class: "mp-sc-dd__field", tabindex: "0", role: "button" });
    if (field.icon) anchor.appendChild(el("span", { class: "mp-sc-ico", html: svgIcon(field.icon) }));
    const valEl = el("div", { class: "mp-sc-dd__value" + (current ? "" : " mp-sc-dd__value--ph"),
      text: current || (field.placeholder || "全部") });
    anchor.appendChild(valEl);
    anchor.appendChild(el("span", { class: "mp-sc-dd__arrow" }));
    anchor.appendChild(el("label", { class: "mp-sc-label", text: field.label }));

    const refresh = function () {
      const ov = readOverrides();
      const v = ov[field.model];
      const s = v === undefined || v === null ? "" : String(v);
      valEl.textContent = s || (field.placeholder || "全部");
      valEl.classList.toggle("mp-sc-dd__value--ph", !s);
    };

    const doOpen = function (ev) {
      if (ev) ev.stopPropagation();
      const ov = readOverrides();
      const v = ov[field.model];
      const s = v === undefined || v === null ? "" : String(v);
      const items = field.options.map(function (o) {
        return { label: field.optionLabel ? field.optionLabel(o) : o, selected: s === o,
                 onSelect: function () { commitValue(field.model, s === o ? "" : o); } };
      });
      items.unshift({ label: "全部", selected: s === "",
                      onSelect: function () { commitValue(field.model, ""); } });
      items.push({ label: "自定义…", selected: !isNative && s !== "",
                   onSelect: function () {
                     const cur2 = window.prompt("自定义 " + field.label + " 值", s);
                     if (cur2 !== null) commitValue(field.model, cur2.trim());
                   } });
      openDropdown(anchor, items, { refresh: refresh });
    };
    anchor.addEventListener("click", doOpen);
    anchor.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); doOpen(); }
    });
    wrap.appendChild(anchor);
    return wrap;
  }

  // Async dropdown that loads its options from an MP API endpoint.
  function buildAsyncDropdown(field, overrides) {
    const wrap = el("div", { class: "mp-sc-field mp-sc-dd" });
    const cur = overrides[field.model];
    const current = Array.isArray(cur) ? cur.slice() : (cur ? [String(cur)] : []);

    const anchor = el("div", { class: "mp-sc-dd__field mp-sc-dd__field--loading", tabindex: "0", role: "button" });
    if (field.icon) anchor.appendChild(el("span", { class: "mp-sc-ico", html: svgIcon(field.icon) }));
    const valEl = el("div", { class: "mp-sc-dd__value mp-sc-dd__value--ph", text: "加载中…" });
    anchor.appendChild(valEl);
    anchor.appendChild(el("span", { class: "mp-sc-dd__arrow" }));
    anchor.appendChild(el("label", { class: "mp-sc-label", text: field.label }));

    let items = [];           // [{value,label}]
    let loaded = false;
    let failed = false;

    function refresh() {
      const ov = readOverrides();
      const v = ov[field.model];
      const sel = Array.isArray(v) ? v : (v ? [String(v)] : []);
      valEl.textContent = sel.length ? (sel.length > 2 ? sel.slice(0, 2).join("、") + " 等 " + sel.length + " 项" : sel.join("、"))
                                      : (field.placeholder || "全部");
      valEl.classList.toggle("mp-sc-dd__value--ph", !sel.length);
    }

    function doOpen(ev) {
      if (ev) ev.stopPropagation();
      if (!loaded && !failed) return;
      const ov = readOverrides();
      const v = ov[field.model];
      const sel = Array.isArray(v) ? v.slice() : (v ? [String(v)] : []);
      const menuItems = items.map(function (it) {
        return { label: it.label, selected: sel.indexOf(it.value) !== -1,
                 onSelect: function () {
                   const next = sel.slice();
                   const i = next.indexOf(it.value);
                   if (i === -1) next.push(it.value); else next.splice(i, 1);
                   commitValue(field.model, next);
                 } };
      });
      menuItems.unshift({ label: "全部（清空）", selected: sel.length === 0,
                          onSelect: function () { commitValue(field.model, ""); } });
      openDropdown(anchor, menuItems, { multi: true, refresh: refresh });
    }
    anchor.addEventListener("click", doOpen);
    wrap.appendChild(anchor);

    fetch(API_BASE + field.api, { credentials: "same-origin" })
      .then(function (r) { if (!r.ok) throw new Error("http " + r.status); return r.json(); })
      .then(function (json) {
        const data = json && json.data !== undefined ? json.data : json;
        items = (Array.isArray(data) ? data : []).map(field.mapItem);
        loaded = true;
        anchor.classList.remove("mp-sc-dd__field--loading");
        refresh();
      })
      .catch(function () {
        failed = true;
        loaded = true;
        anchor.classList.remove("mp-sc-dd__field--loading");
        valEl.textContent = "加载失败，点此手填";
        valEl.classList.add("mp-sc-dd__value--ph");
      });
    refresh();
    return wrap;
  }

  function buildTextField(field, overrides, defaultEp) {
    const wrap = el("div", { class: "mp-sc-field" });
    const cur = overrides[field.model];
    const hasValue = cur !== undefined && cur !== null && cur !== "";
    const displayVal = hasValue ? String(cur)
      : (field.model === "start_episode" && defaultEp > 0 ? String(defaultEp) : "");
    const box = el("div", { class: "mp-sc-tf__field" });
    if (field.icon) box.appendChild(el("span", { class: "mp-sc-ico", html: svgIcon(field.icon) }));
    const input = el("input", { type: field.type || "text", placeholder: " ",
      "data-mp-model": field.model, class: "mp-sc-input", autocomplete: "off", spellcheck: "false" });
    input.value = displayVal;
    box.appendChild(input);
    box.appendChild(el("label", { class: "mp-sc-label", text: field.label }));
    wrap.appendChild(box);
    if (field.hint) wrap.appendChild(el("div", { class: "mp-sc-hint", text: field.hint }));
    input.addEventListener("input", function () {
      const val = input.value.trim();
      if (val === "") commitValue(field.model, "");
      else if (field.type === "number") { const n = parseInt(val, 10); commitValue(field.model, isNaN(n) ? "" : n); }
      else commitValue(field.model, val);
    });
    return wrap;
  }

  function buildSwitchRow(fields, overrides) {
    const row = el("div", { class: "mp-sc-switchrow" });
    fields.forEach(function (f) {
      const cur = overrides[f.model];
      const lab = el("label", { class: "mp-sc-sw" });
      const input = el("input", { type: "checkbox", class: "mp-sc-checkbox", "data-mp-model": f.model });
      input.checked = cur === true || cur === 1 || cur === "1";
      input.addEventListener("change", function () { commitValue(f.model, input.checked ? true : ""); });
      lab.appendChild(input);
      lab.appendChild(el("span", { class: "mp-sc-sw__text", text: f.label }));
      if (f.hint) lab.appendChild(el("span", { class: "mp-sc-sw__hint", text: f.hint }));
      row.appendChild(lab);
    });
    return row;
  }

  function buildField(field, overrides, defaultEp) {
    if (field.kind === "dropdown") return buildDropdown(field, overrides);
    if (field.kind === "async-dropdown") return buildAsyncDropdown(field, overrides);
    return buildTextField(field, overrides, defaultEp);
  }

  const NATIVE_OPTIONS = {
    quality: ["蓝光原盘", "Remux", "BluRay", "UHD", "WEB-DL", "HDTV", "H265", "H264"],
    resolution: ["4k", "1080p", "720p"],
    effect: ["杜比视界", "杜比全景声", "HDR", "SDR"],
    season: Array.from({ length: 101 }, (_, i) => String(i)),
  };

  const BASIC_FIELDS = [
    { model: "keyword", kind: "text", type: "text", icon: ICONS.search, hint: "指定搜索站点时使用的关键词" },
    { model: "total_episode", kind: "text", type: "number", icon: ICONS.list, hint: "剧集总集数" },
    { model: "start_episode", kind: "text", type: "number", icon: ICONS.play, hint: "0 = 不指定" },
    { model: "quality", kind: "dropdown", options: NATIVE_OPTIONS.quality, icon: ICONS.hd },
    { model: "resolution", kind: "dropdown", options: NATIVE_OPTIONS.resolution, icon: ICONS.monitor },
    { model: "effect", kind: "dropdown", options: NATIVE_OPTIONS.effect, icon: ICONS.wand },
    { model: "sites", kind: "async-dropdown", api: "/site", icon: ICONS.globe, multi: true,
      placeholder: "全部", mapItem: function (s) { return { value: s.name, label: s.name }; } },
    { model: "downloader", kind: "async-dropdown", api: "/download/clients", icon: ICONS.download,
      placeholder: "跟随系统", mapItem: function (d) { return { value: d.name, label: d.name }; } },
    { model: "save_path", kind: "text", type: "text", icon: ICONS.folder, hint: "留空自动使用下载目录" },
    { model: "search_interval", kind: "dropdown", icon: ICONS.timer, placeholder: "跟随系统",
      options: ["6", "12", "24", "48", "72", "168"],
      optionLabel: function (v) { return v + " 小时"; } },
  ];
  const BASIC_SWITCHES = [
    { model: "best_version", label: "洗版", hint: "根据洗版优先级进行洗版订阅" },
    { model: "best_version_full", label: "全集洗版", hint: "对全集进行洗版" },
    { model: "search_imdbid", label: "使用 ImdbID 搜索", hint: "精确搜索资源" },
  ];
  const ADVANCE_FIELDS = [
    { model: "filter", kind: "text", type: "text", icon: ICONS.filter, hint: "空格分隔（MP schema 字段，原生 UI 未暴露）" },
    { model: "include", kind: "text", type: "text", icon: ICONS.plus, hint: "关键字 / 正则，空格分隔" },
    { model: "exclude", kind: "text", type: "text", icon: ICONS.minus, hint: "关键字 / 正则，空格分隔" },
    { model: "season", kind: "dropdown", options: NATIVE_OPTIONS.season, icon: ICONS.list,
      optionLabel: function (v) { return v === "0" ? "特别篇" : "第 " + v + " 季"; } },
    { model: "episode_group", kind: "text", type: "text", hint: "按特定剧集组识别和刮削" },
    { model: "media_category", kind: "text", type: "text", hint: "留空自动识别" },
    { model: "custom_words", kind: "text", type: "text", hint: "自定义下载过滤词" },
  ];

  function buildPanel() {
    const overrides = readOverrides();
    const defaultEp = readDefaultEpisode();

    const panel = el("div", { [PANEL_MARKER]: "v13", class: "mp-sc-panel" });

    const header = el("div", { class: "mp-sc-header" });
    const hrow = el("div", { class: "mp-sc-hrow" });
    const activeCount = Object.keys(overrides).length + (defaultEp > 0 ? 1 : 0);
    hrow.appendChild(el("div", { class: "mp-sc-title", text: "订阅增强（SubscribeConfigurator）" }));
    hrow.appendChild(el("span", { class: "mp-sc-badge" + (activeCount ? " mp-sc-badge--on" : ""),
      text: activeCount ? ("已填 " + activeCount + " 项") : "未填写" }));
    const clearBtn = el("button", { type: "button", class: "mp-sc-clear", text: "清空全部" });
    clearBtn.addEventListener("click", function (ev) {
      ev.stopPropagation();
      clearOverrides();
      const fresh = buildPanel();
      panel.parentNode.replaceChild(fresh, panel);
      console.info("[subscribeconfigurator v13] overrides cleared by user");
    });
    hrow.appendChild(clearBtn);
    header.appendChild(hrow);

    const osLabel = el("label", { class: "mp-sc-oneshot" });
    const osInput = el("input", { type: "checkbox", class: "mp-sc-checkbox" });
    osInput.checked = isOneShot();
    osInput.addEventListener("change", function (ev) {
      ev.stopPropagation();
      try {
        if (osInput.checked) localStorage.setItem(LS_ONESHOT_KEY, "1");
        else localStorage.removeItem(LS_ONESHOT_KEY);
      } catch (e) {}
    });
    osLabel.appendChild(osInput);
    osLabel.appendChild(el("span", { text: "一次性（提交一次后自动清空）" }));
    header.appendChild(osLabel);
    panel.appendChild(header);

    const tabs = el("div", { class: "mp-sc-tabs" });
    const basicPane = el("div", { class: "mp-sc-pane" });
    const advPane = el("div", { class: "mp-sc-pane", style: "display:none" });
    const bg = el("div", { class: "mp-sc-grid" });
    BASIC_FIELDS.forEach(function (f) { bg.appendChild(buildField(f, overrides, defaultEp)); });
    basicPane.appendChild(bg);
    basicPane.appendChild(buildSwitchRow(BASIC_SWITCHES, overrides));
    const ag = el("div", { class: "mp-sc-grid" });
    ADVANCE_FIELDS.forEach(function (f) { ag.appendChild(buildField(f, overrides, defaultEp)); });
    advPane.appendChild(ag);

    function tabBtn(name, target, active) {
      const b = el("button", { type: "button", class: "mp-sc-tabbtn" + (active ? " mp-sc-tabbtn--active" : ""), text: name });
      b.addEventListener("click", function () {
        closeOpenMenu();
        Array.prototype.forEach.call(tabs.children, function (c) { c.classList.remove("mp-sc-tabbtn--active"); });
        b.classList.add("mp-sc-tabbtn--active");
        basicPane.style.display = target === basicPane ? "block" : "none";
        advPane.style.display = target === advPane ? "block" : "none";
      });
      return b;
    }
    tabs.appendChild(tabBtn("基础", basicPane, true));
    tabs.appendChild(tabBtn("进阶", advPane, false));
    panel.appendChild(tabs);
    panel.appendChild(basicPane);
    panel.appendChild(advPane);

    injectStyles();
    return panel;
  }

  let stylesInjected = false;
  function injectStyles() {
    if (stylesInjected || document.getElementById("mp-sc-styles")) { stylesInjected = true; return; }
    const style = document.createElement("style");
    style.id = "mp-sc-styles";
    style.textContent = CSS;
    document.head.appendChild(style);
    stylesInjected = true;
  }

  const ON_SURFACE = "rgb(var(--v-theme-on-surface))";
  const CSS = [
    ".mp-sc-panel{margin-top:12px;padding:16px;border-radius:8px;background:rgb(var(--v-theme-surface));color:" + ON_SURFACE + ";border:1px solid rgba(var(--v-theme-on-surface),var(--v-border-opacity));font-family:inherit}",
    ".mp-sc-header{margin-bottom:12px}",
    ".mp-sc-hrow{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
    ".mp-sc-title{font-size:14px;font-weight:500;letter-spacing:.0125em;color:rgba(var(--v-theme-on-surface),var(--v-high-emphasis-opacity))}",
    ".mp-sc-badge{font-size:11px;padding:1px 8px;border-radius:10px;background:rgba(var(--v-theme-on-surface),.12);color:rgba(var(--v-theme-on-surface),var(--v-medium-emphasis-opacity))}",
    ".mp-sc-badge--on{background:rgba(var(--v-theme-primary),.16);color:rgb(var(--v-theme-primary))}",
    ".mp-sc-clear{margin-left:auto;background:none;border:1px solid rgba(var(--v-theme-on-surface),.38);border-radius:4px;padding:2px 10px;font:inherit;font-size:12px;color:rgba(var(--v-theme-on-surface),var(--v-medium-emphasis-opacity));cursor:pointer}",
    ".mp-sc-clear:hover{border-color:rgb(var(--v-theme-primary));color:rgb(var(--v-theme-primary))}",
    ".mp-sc-oneshot{display:flex;align-items:center;gap:6px;margin-top:8px;font-size:12px;color:rgba(var(--v-theme-on-surface),var(--v-medium-emphasis-opacity));cursor:pointer;user-select:none}",
    ".mp-sc-tabs{display:flex;gap:16px;margin-bottom:16px;border-bottom:1px solid rgba(var(--v-theme-on-surface),var(--v-border-opacity))}",
    ".mp-sc-tabbtn{background:none;border:none;padding:8px 4px;margin-bottom:-1px;font:inherit;font-size:14px;font-weight:500;color:rgba(var(--v-theme-on-surface),var(--v-medium-emphasis-opacity));cursor:pointer;border-bottom:2px solid transparent}",
    ".mp-sc-tabbtn--active{color:rgb(var(--v-theme-primary));border-bottom-color:rgb(var(--v-theme-primary))}",
    ".mp-sc-grid{display:grid;grid-template-columns:1fr;column-gap:12px}",
    "@media (min-width:700px){.mp-sc-grid{grid-template-columns:repeat(2,1fr)}}",
    "@media (min-width:1100px){.mp-sc-grid{grid-template-columns:repeat(3,1fr)}}",
    ".mp-sc-field{position:relative;padding-top:6px;padding-bottom:0;min-width:0}",
    ".mp-sc-ico{display:flex;align-items:center;justify-content:center;color:rgba(var(--v-theme-on-surface),var(--v-medium-emphasis-opacity));margin-right:8px}",
    // outlined field shell shared by text + dropdown
    ".mp-sc-tf__field,.mp-sc-dd__field{display:flex;align-items:center;min-height:40px;padding:6px 10px;border:1px solid rgba(var(--v-theme-on-surface),.38);border-radius:4px;background:transparent;transition:border-color .15s,border-width .15s;cursor:pointer}",
    ".mp-sc-tf__field:hover,.mp-sc-dd__field:hover{border-color:rgba(var(--v-theme-on-surface),.6)}",
    ".mp-sc-dd__field--open{border-color:rgb(var(--v-theme-primary));border-width:2px;padding:5px 9px}",
    ".mp-sc-dd__field--loading{opacity:.7}",
    ".mp-sc-input{flex:1 1 auto;min-width:0;width:100%;border:none;background:transparent;font:inherit;font-size:14px;color:" + ON_SURFACE + ";outline:none;padding:0}",
    ".mp-sc-dd__value{flex:1 1 auto;min-width:0;font-size:14px;line-height:1.4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
    ".mp-sc-dd__value--ph{color:rgba(var(--v-theme-on-surface),var(--v-medium-emphasis-opacity))}",
    ".mp-sc-dd__arrow{flex:0 0 auto;width:8px;height:8px;margin-left:8px;border-right:2px solid rgba(var(--v-theme-on-surface),.6);border-bottom:2px solid rgba(var(--v-theme-on-surface),.6);transform:rotate(45deg) translateY(-2px);transition:transform .15s}",
    ".mp-sc-dd--open .mp-sc-dd__arrow{transform:rotate(225deg) translateY(-2px)}",
    ".mp-sc-label{position:absolute;left:10px;top:-7px;padding:0 4px;font-size:12px;line-height:1;color:rgba(var(--v-theme-on-surface),var(--v-medium-emphasis-opacity));background:rgb(var(--v-theme-surface));pointer-events:none;transition:color .15s}",
    ".mp-sc-dd--open .mp-sc-label,.mp-sc-dd__field:focus .mp-sc-label,.mp-sc-tf__field:focus-within .mp-sc-label{color:rgb(var(--v-theme-primary))}",
    ".mp-sc-hint{font-size:12px;line-height:1.4;color:rgba(var(--v-theme-on-surface),var(--v-medium-emphasis-opacity));padding:4px 2px 10px}",
    // teleported menu
    ".mp-sc-menu{z-index:3000;background:rgb(var(--v-theme-surface-bright,var(--v-theme-surface)));color:" + ON_SURFACE + ";border-radius:4px;border:1px solid rgba(var(--v-theme-on-surface),.12);box-shadow:0 6px 20px rgba(0,0,0,.45);overflow:hidden}",
    ".mp-sc-menu__list{max-height:260px;overflow-y:auto;padding:4px 0}",
    ".mp-sc-menu__item{display:flex;align-items:center;gap:8px;padding:7px 12px;font-size:14px;line-height:1.4;cursor:pointer;white-space:nowrap}",
    ".mp-sc-menu__item:hover{background:rgba(var(--v-theme-on-surface),.08)}",
    ".mp-sc-menu__item--sel{color:rgb(var(--v-theme-primary))}",
    ".mp-sc-cb{flex:0 0 auto;width:16px;height:16px;border-radius:3px;border:2px solid rgba(var(--v-theme-on-surface),.54)}",
    ".mp-sc-cb--on{background:rgb(var(--v-theme-primary));border-color:rgb(var(--v-theme-primary))}",
    // switch row
    ".mp-sc-switchrow{display:flex;flex-wrap:wrap;gap:8px 28px;padding:4px 2px 12px}",
    ".mp-sc-sw{display:flex;align-items:flex-start;gap:8px;cursor:pointer;user-select:none;flex:1 1 240px;min-width:0}",
    ".mp-sc-checkbox{width:20px;height:20px;flex:0 0 auto;margin:0;accent-color:rgb(var(--v-theme-primary));cursor:pointer}",
    ".mp-sc-sw__text{font-size:14px;line-height:20px;white-space:nowrap}",
    ".mp-sc-sw__hint{font-size:12px;line-height:1.35;color:rgba(var(--v-theme-on-surface),var(--v-medium-emphasis-opacity));flex:1 1 100%;padding-left:28px}",
  ].join("");

  function tryInject(root) {
    if (!root || typeof root.querySelectorAll !== "function") return;
    const candidates = root.querySelectorAll(".v-dialog, .v-overlay__content, [role=\"dialog\"]");
    let injected = 0;
    candidates.forEach(function (dialog) {
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
    if (injected > 0) console.info("[subscribeconfigurator v13] injected into " + injected + " dialog(s)");
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
    console.info("[subscribeconfigurator v13] loaded (XHR hook + custom dropdown)");
  }

  window.addEventListener("error", function (e) {
    if (e && e.filename && String(e.filename).indexOf("_subscribe_patch") !== -1)
      console.error("[subscribeconfigurator v13] SCRIPT ERROR", e.message, ":" + e.lineno);
  });

  try {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", attach);
    else attach();
  } catch (e) { console.error("[subscribeconfigurator v13] FATAL", e); }
})();