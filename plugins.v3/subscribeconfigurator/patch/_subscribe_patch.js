/* SubscribeConfigurator — frontend patch v18
 * v18 fixes:
 *   1. Mobile: the injected panel starts collapsed on narrow screens so it
 *      cannot fill the whole subscription dialog. The header keeps the title,
 *      badge and a 展开/收起 toggle; the expanded panel scrolls with the
 *      native `.v-card-text` container instead of adding a nested scroller.
 *   2. Inject into `.v-card-text` (Vuetify's scroll area) instead of
 *      `.v-overlay__content`; this is what made phones unable to scroll.
 *   3. Compact mobile spacing: single-column fields, 48px field height, smaller
 *      labels/hints, sticky tabs and a shorter title ("订阅增强").
 * v17 fixes:
 *   1. Match the native Vuetify form style: 56px outlined fields, 16px input
 *      text, floating 12px labels, icon-aware label position, native-like
 *      tabs/text buttons, and Vuetify-style switches instead of raw checkboxes.
 *   2. Re-inject the inline stylesheet if an SPA re-render removes it.
 *   3. Copy the active `v-theme--*` class onto the teleported dropdown menu so
 *      its CSS variables resolve outside the dialog.
 * v16 fixes:
 *   1. Site options load from `GET /site/rss` (the endpoint the native
 *      subscribe dialog uses), falling back to `/site/` and `/site` for older
 *      builds. `/site` alone needs manage permission, so normal users saw
 *      "加载失败" even though the native dialog worked.
 *   2. Site option values are numeric site IDs. `Subscribe.sites` is
 *      `List[int]`; v15 stored names, which the backend rejected with 422.
 *   3. Manual fallback accepts site names or IDs, resolves names against the
 *      loaded/cached site list, and never sends unresolved names as IDs.
 *   4. Failure state offers "重试加载" and "手动输入" instead of only a prompt.
 *   5. Display selected sites by name, not by raw ID.
 */
(function () {
  "use strict";

  const LS_OVERRIDES_KEY = "mp_subscribe_overrides";
  const LS_DEFAULT_EPISODE_KEY = "mp_subscribe_default_start_episode";
  const LS_ONESHOT_KEY = "mp_subscribe_oneshot";
  const LS_SITE_ITEMS_KEY = "mp_sc_site_items";
  const PANEL_MARKER = "data-mp-subscribe-configurator";
  const PANEL_VERSION = "v18";
  const API_BASE = "/api/v1";
  const OPTION_TTL_MS = 5 * 60 * 1000;
  const OPTION_CACHE = {};

  // Values the panel is allowed to merge into the subscribe POST. Anything
  // else in localStorage is ignored so a stale/manual key cannot inject
  // arbitrary fields into the API payload.
  const ALLOWED_MODELS = new Set([
    "keyword", "total_episode", "start_episode", "quality", "resolution",
    "effect", "sites", "downloader", "save_path", "search_interval",
    "best_version", "best_version_full", "search_imdbid", "filter",
    "include", "exclude", "season", "episode_group", "media_category",
    "custom_words",
  ]);
  const BOOL_MODELS = new Set(["best_version", "best_version_full", "search_imdbid"]);
  const NUM_MODELS = new Set(["total_episode", "start_episode", "season", "search_interval"]);

  // MP keeps the auth token in localStorage under "auth" -> {token, remember, ...}
  function authHeaders() {
    try {
      const raw = localStorage.getItem("auth");
      if (!raw) return {};
      const token = (JSON.parse(raw) || {}).token;
      return token ? { Authorization: "Bearer " + token } : {};
    } catch (e) { return {}; }
  }

  function apiGet(path) {
    return fetch(API_BASE + path, { credentials: "same-origin", headers: authHeaders() });
  }

  // Raw option lists change rarely (sites / downloaders). Cache the parsed
  // array for a few minutes so opening the dialog repeatedly doesn't hammer
  // the API. `fallbacks` lets us try the native endpoint first and older MP
  // variants afterwards.
  function apiGetCached(path, fallbacks) {
    const now = Date.now();
    const hit = OPTION_CACHE[path];
    if (hit && now - hit.at < OPTION_TTL_MS) return Promise.resolve(hit.data);
    const paths = [path].concat(fallbacks || []);
    function attempt(index, lastError) {
      if (index >= paths.length) return Promise.reject(lastError || new Error("no endpoint"));
      return apiGet(paths[index])
        .then(function (r) {
          if (!r.ok) {
            const err = new Error("http " + r.status);
            err.status = r.status;
            throw err;
          }
          return r.json();
        })
        .then(function (json) {
          const data = json && json.data !== undefined ? json.data : json;
          const arr = Array.isArray(data) ? data : [];
          OPTION_CACHE[path] = { at: now, data: arr };
          return arr;
        })
        .catch(function (err) {
          return attempt(index + 1, err);
        });
    }
    return attempt(0, null);
  }

  // Keep the last good site list so the manual fallback can still turn a site
  // name into the numeric ID the backend expects when the API is temporarily
  // unavailable.
  function cacheSiteItems(items) {
    try { localStorage.setItem(LS_SITE_ITEMS_KEY, JSON.stringify(items)); } catch (e) {}
  }
  function readCachedSiteItems() {
    try {
      const parsed = JSON.parse(localStorage.getItem(LS_SITE_ITEMS_KEY) || "[]");
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) { return []; }
  }

  function readOverrides() {
    try {
      const parsed = JSON.parse(localStorage.getItem(LS_OVERRIDES_KEY) || "{}");
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch (e) { return {}; }
  }
  function writeOverrides(obj) {
    try { localStorage.setItem(LS_OVERRIDES_KEY, JSON.stringify(obj)); }
    catch (e) {}
  }
  function clearOverrides() {
    try {
      localStorage.removeItem(LS_OVERRIDES_KEY);
      localStorage.removeItem(LS_DEFAULT_EPISODE_KEY);
      // Keep LS_ONESHOT_KEY: "clear" should not silently re-enable one-shot
      // for a user who explicitly turned it off.
    } catch (e) {}
  }
  function readDefaultEpisode() {
    let raw = null;
    try { raw = localStorage.getItem(LS_DEFAULT_EPISODE_KEY); } catch (e) {}
    if (raw !== null && raw !== "") {
      const n = parseInt(raw, 10);
      return isNaN(n) ? 0 : n;
    }
    // Server-side config is only a fallback; an explicit localStorage value
    // (including "0") always wins.
    const cfg = (typeof window !== "undefined" && window.__MP_SC_CONFIG__) || {};
    if (!cfg.auto_apply_defaults) return 0;
    const n = parseInt(cfg.default_start_episode, 10);
    return isNaN(n) ? 0 : n;
  }
  function isOneShot() {
    try {
      const raw = localStorage.getItem(LS_ONESHOT_KEY);
      // Default ON: prevents overrides from silently leaking into the next
      // subscription. Users can explicitly store "0" to keep them.
      return raw === null ? true : raw === "1";
    } catch (e) { return true; }
  }

  function normalizeOverride(model, value) {
    if (model === "sites") {
      // `Subscribe.sites` is List[int]. Drop old name-based values instead of
      // sending them to the backend, where Pydantic would reject the POST.
      const raw = Array.isArray(value)
        ? value
        : (typeof value === "string" && value.trim() ? value.split(/[,，\s]+/) : []);
      return raw
        .map(function (x) { return parseInt(x, 10); })
        .filter(function (n) { return !isNaN(n); });
    }
    if (model === "downloader") {
      if (Array.isArray(value)) return value.length ? String(value[0]).trim() : "";
      return value === null || value === undefined ? "" : String(value).trim();
    }
    if (BOOL_MODELS.has(model)) {
      return value === true || value === 1 || value === "1" || value === "true";
    }
    if (NUM_MODELS.has(model)) {
      const n = parseInt(value, 10);
      return isNaN(n) ? "" : n;
    }
    return value === null || value === undefined ? "" : String(value).trim();
  }

  function mergeOverrides(payload) {
    if (!payload || typeof payload !== "object") return false;
    const overrides = readOverrides();
    let changed = false;
    for (const k in overrides) {
      if (!Object.prototype.hasOwnProperty.call(overrides, k)) continue;
      if (!ALLOWED_MODELS.has(k)) continue;
      const v = normalizeOverride(k, overrides[k]);
      if (v === "" || v === null || v === undefined) continue;
      if (Array.isArray(v) && v.length === 0) continue;
      payload[k] = v;
      changed = true;
    }
    // Only fill the default when the user did not make an explicit choice.
    // An explicit 0 ("不指定") must override the server default.
    const defaultEp = readDefaultEpisode();
    const explicitStart = Object.prototype.hasOwnProperty.call(overrides, "start_episode");
    if (defaultEp > 0 && !explicitStart && !payload.start_episode) {
      payload.start_episode = defaultEp;
      changed = true;
    }
    return changed;
  }

  function maybeOneShot() {
    if (!isOneShot()) return;
    clearOverrides();
    console.info("[subscribeconfigurator v18] one-shot applied, overrides cleared");
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
      let merged = false;
      try {
        if ((this.__mpMethod || "") === "POST" && (this.__mpUrl || "").indexOf("/subscribe") !== -1 &&
            typeof body === "string" && body.charAt(0) === "{") {
          const payload = JSON.parse(body);
          if (mergeOverrides(payload)) {
            body = JSON.stringify(payload);
            merged = true;
            console.info("[subscribeconfigurator v18] overrides merged into subscribe POST");
          }
        }
      } catch (e) {}
      const xhr = this;
      if (merged) {
        xhr.addEventListener("load", function () {
          try { if (xhr.status >= 200 && xhr.status < 300) maybeOneShot(); } catch (e) {}
        });
      }
      return OrigSend.call(this, body);
    };
  }

  const OrigFetch = window.fetch;
  window.fetch = function (resource, init) {
    let merged = false;
    try {
      const url = typeof resource === "string" ? resource : (resource && resource.url) || "";
      if (((init && init.method) || "GET").toUpperCase() === "POST" &&
          url.indexOf("/subscribe") !== -1 && init && typeof init.body === "string" &&
          init.body.charAt(0) === "{") {
        const payload = JSON.parse(init.body);
        if (mergeOverrides(payload)) {
          init.body = JSON.stringify(payload);
          merged = true;
        }
      }
    } catch (e) {}
    const promise = OrigFetch.apply(window, arguments);
    if (merged && promise && typeof promise.then === "function") {
      promise.then(function (res) {
        if (res && res.ok) maybeOneShot();
      }).catch(function () {});
    }
    return promise;
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

  // The menu is teleported to <body>, outside the Vuetify theme wrapper. Copy
  // the active `v-theme--*` class so `--v-theme-*` variables still resolve;
  // otherwise the menu falls back to transparent/black and looks detached
  // from the dialog.
  function inheritThemeClass(target, anchor) {
    try {
      const source = anchor.closest(".v-theme--glass, .v-theme--light, .v-theme--dark, .v-theme--purple, .v-theme--transparent, .v-application") ||
        document.querySelector(".v-application") || document.documentElement;
      [source, document.documentElement, document.body].forEach(function (host) {
        if (!host || !host.className) return;
        String(host.className).split(/\s+/).forEach(function (name) {
          if (name.indexOf("v-theme--") === 0) target.classList.add(name);
        });
      });
      const dataTheme = (source.getAttribute && source.getAttribute("data-theme")) ||
        document.documentElement.getAttribute("data-theme") ||
        (document.body && document.body.getAttribute("data-theme"));
      if (dataTheme) target.setAttribute("data-theme", dataTheme);
    } catch (e) {}
  }

  function openDropdown(anchor, items, opts) {
    // toggle
    if (openMenu && openMenu.anchor === anchor) { closeOpenMenu(); return; }
    closeOpenMenu();
    const refresh = opts && opts.refresh;
    const rect = anchor.getBoundingClientRect();
    const menu = el("div", { class: "mp-sc-menu" });
    inheritThemeClass(menu, anchor);
    const list = el("div", { class: "mp-sc-menu__list" });
    items.forEach(function (it) {
      const row = el("div", { class: "mp-sc-menu__item" + (it.selected ? " mp-sc-menu__item--sel" : "") },
        [el("span", { class: "mp-sc-menu__title", text: it.label })]);
      if (opts && opts.multi) {
        const box = el("span", { class: "mp-sc-cb" + (it.selected ? " mp-sc-cb--on" : "") });
        row.insertBefore(box, row.firstChild);
        row.addEventListener("click", function (ev) {
          ev.stopPropagation();
          // onSelect re-reads localStorage and returns the new checked state.
          const nowSel = !!it.onSelect();
          it.selected = nowSel;
          box.classList.toggle("mp-sc-cb--on", nowSel);
          row.classList.toggle("mp-sc-menu__item--sel", nowSel);
          if (refresh) refresh();
        });
      } else {
        row.addEventListener("click", function () {
          it.onSelect();
          closeOpenMenu();
          if (refresh) refresh();
        });
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
    openMenu = { el: menu, anchor: anchor, refresh: refresh };
  }

  function buildDropdown(field, overrides) {
    const wrap = el("div", { class: "mp-sc-field mp-sc-dd" });
    const cur = overrides[field.model];
    const current = cur === undefined || cur === null ? "" : String(cur);

    const anchor = el("div", { class: "mp-sc-dd__field" + (field.icon ? " mp-sc-has-icon" : ""), tabindex: "0", role: "button" });
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
      anchor.classList.toggle("mp-sc-dd--filled", !!s);
    };

    const doOpen = function (ev) {
      if (ev) ev.stopPropagation();
      const ov = readOverrides();
      const v = ov[field.model];
      const s = v === undefined || v === null ? "" : String(v);
      const isNative = s === "" || field.options.indexOf(s) !== -1;
      const items = field.options.map(function (o) {
        return { label: field.optionLabel ? field.optionLabel(o) : o, selected: s === o,
                 onSelect: function () { commitValue(field.model, s === o ? "" : o); } };
      });
      items.unshift({ label: field.placeholder || "全部", selected: s === "",
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
    if (field.hint) wrap.appendChild(el("div", { class: "mp-sc-hint", text: field.hint }));
    refresh();
    return wrap;
  }

  // Async dropdown that loads its options from an MP API endpoint.
  function buildAsyncDropdown(field, overrides) {
    const wrap = el("div", { class: "mp-sc-field mp-sc-dd" });
    const isMulti = !!field.multi;

    const anchor = el("div", { class: "mp-sc-dd__field mp-sc-dd__field--loading" + (field.icon ? " mp-sc-has-icon" : ""), tabindex: "0", role: "button" });
    if (field.icon) anchor.appendChild(el("span", { class: "mp-sc-ico", html: svgIcon(field.icon) }));
    const valEl = el("div", { class: "mp-sc-dd__value mp-sc-dd__value--ph", text: "加载中…" });
    anchor.appendChild(valEl);
    anchor.appendChild(el("span", { class: "mp-sc-dd__arrow" }));
    anchor.appendChild(el("label", { class: "mp-sc-label", text: field.label }));

    let items = [];           // [{value,label}]
    let loaded = false;
    let failed = false;

    function sameValue(a, b) { return String(a) === String(b); }

    function siteLabel(value) {
      if (field.model !== "sites") return String(value);
      const list = items.length ? items : readCachedSiteItems();
      for (let i = 0; i < list.length; i++) {
        if (sameValue(list[i].value, value)) return list[i].label;
      }
      return String(value);
    }

    function refresh() {
      const ov = readOverrides();
      const v = ov[field.model];
      const sel = Array.isArray(v) ? v : (v ? [String(v)] : []);
      const labels = sel.map(siteLabel);
      valEl.textContent = labels.length
        ? (labels.length > 2 ? labels.slice(0, 2).join("、") + " 等 " + labels.length + " 项" : labels.join("、"))
        : (field.placeholder || "全部");
      valEl.classList.remove("mp-sc-dd__value--error");
      valEl.classList.toggle("mp-sc-dd__value--ph", !sel.length);
      anchor.classList.toggle("mp-sc-dd--filled", sel.length > 0);
    }

    function siteValueFromToken(token) {
      const text = String(token).trim();
      if (!text) return null;
      if (/^\d+$/.test(text)) return parseInt(text, 10);
      const list = items.length ? items : readCachedSiteItems();
      const lower = text.toLowerCase();
      for (let i = 0; i < list.length; i++) {
        if (String(list[i].label).trim().toLowerCase() === lower || sameValue(list[i].value, text)) {
          const value = parseInt(list[i].value, 10);
          return isNaN(value) ? null : value;
        }
      }
      return null;
    }

    function promptManual() {
      const ov = readOverrides();
      const raw = ov[field.model];
      const current = Array.isArray(raw) ? raw : (raw ? [String(raw)] : []);
      const initial = current.map(siteLabel).join(",");
      const val = window.prompt(
        "手动输入「" + field.label + "」" +
        (isMulti ? "：可填站点名称或 ID，多个用逗号分隔。" : "。"),
        initial
      );
      if (val === null) return;
      const tokens = val.trim() ? val.trim().split(/[,，\s]+/).filter(Boolean) : [];
      if (!tokens.length) { commitValue(field.model, ""); refresh(); return; }
      if (!isMulti) {
        commitValue(field.model, field.model === "sites" ? siteValueFromToken(tokens[0]) : tokens[0]);
        refresh();
        return;
      }
      const values = [];
      const unresolved = [];
      tokens.forEach(function (token) {
        const value = siteValueFromToken(token);
        if (value === null || isNaN(value)) unresolved.push(token);
        else if (values.indexOf(value) === -1) values.push(value);
      });
      if (unresolved.length) {
        const list = items.length ? items : readCachedSiteItems();
        const valid = list.slice(0, 40).map(function (it) {
          return "  " + it.label + " (" + it.value + ")";
        }).join("\n");
        window.alert(
          "无法识别：" + unresolved.join("、") +
          (valid ? "\n\n可选站点：\n" + valid : "\n\n请填写站点 ID（数字）。")
        );
        return;
      }
      commitValue(field.model, values.length ? values : "");
      refresh();
    }

    function load() {
      failed = false;
      loaded = false;
      anchor.classList.add("mp-sc-dd__field--loading");
      valEl.classList.remove("mp-sc-dd__value--ph");
      valEl.classList.remove("mp-sc-dd__value--error");
      valEl.textContent = "加载中…";
      apiGetCached(field.api, field.apiFallbacks)
        .then(function (data) {
          const rows = field.filterItem ? data.filter(field.filterItem) : data;
          items = rows.map(field.mapItem).filter(function (it) {
            return it && it.value !== undefined && it.value !== null && it.value !== "";
          });
          if (field.model === "sites") cacheSiteItems(items);
          loaded = true;
          failed = false;
          anchor.classList.remove("mp-sc-dd__field--loading");
          refresh();
        })
        .catch(function (err) {
          failed = true;
          loaded = true;
          anchor.classList.remove("mp-sc-dd__field--loading");
          valEl.textContent = (err && err.status === 401)
            ? "登录已过期，点此重试/手填"
            : "加载失败，点此重试/手填";
          valEl.classList.add("mp-sc-dd__value--ph");
          valEl.classList.add("mp-sc-dd__value--error");
          console.warn("[subscribeconfigurator v18] load " + field.api + " failed", err && err.status);
        });
    }

    function doOpen(ev) {
      if (ev) ev.stopPropagation();
      if (failed) {
        openDropdown(anchor, [
          { label: "重试加载", selected: false, onSelect: function () { load(); return false; } },
          { label: isMulti ? "手动输入（名称或 ID）" : "手动输入", selected: false,
            onSelect: function () { promptManual(); return false; } },
        ], { refresh: refresh });
        return;
      }
      if (!loaded) return;
      const ov = readOverrides();
      const v = ov[field.model];
      const sel = Array.isArray(v) ? v.slice() : (v ? [String(v)] : []);
      const menuItems = items.map(function (it) {
        return {
          label: it.label,
          selected: sel.some(function (x) { return sameValue(x, it.value); }),
          onSelect: function () {
            // Re-read on every click. v14 captured `sel` once, so choosing A
            // then B wrote only B.
            const now = readOverrides();
            const raw = now[field.model];
            if (isMulti) {
              const next = Array.isArray(raw) ? raw.slice() : (raw ? [String(raw)] : []);
              let i = -1;
              for (let n = 0; n < next.length; n++) {
                if (sameValue(next[n], it.value)) { i = n; break; }
              }
              if (i === -1) next.push(it.value); else next.splice(i, 1);
              commitValue(field.model, next.length ? next : "");
              return i === -1;
            }
            const currentVal = raw === undefined || raw === null ? "" : String(raw);
            const same = sameValue(currentVal, it.value);
            commitValue(field.model, same ? "" : it.value);
            return !same;
          },
        };
      });
      menuItems.unshift({
        label: isMulti ? "全部（清空）" : "跟随系统",
        selected: sel.length === 0,
        onSelect: function () { commitValue(field.model, ""); return false; },
      });
      if (field.model === "sites") {
        menuItems.splice(1, 0, {
          label: "手动输入…",
          selected: false,
          onSelect: function () { closeOpenMenu(); promptManual(); return false; },
        });
      }
      openDropdown(anchor, menuItems, { multi: isMulti, refresh: refresh });
    }
    anchor.addEventListener("click", doOpen);
    wrap.appendChild(anchor);
    if (field.hint) wrap.appendChild(el("div", { class: "mp-sc-hint", text: field.hint }));

    load();
    refresh();
    return wrap;
  }

  function buildTextField(field, overrides, defaultEp) {
    const wrap = el("div", { class: "mp-sc-field" });
    const cur = overrides[field.model];
    const hasValue = cur !== undefined && cur !== null && cur !== "";
    const displayVal = hasValue ? String(cur)
      : (field.model === "start_episode" && defaultEp > 0 ? String(defaultEp) : "");
    const box = el("div", { class: "mp-sc-tf__field" + (field.icon ? " mp-sc-has-icon" : "") });
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
      const input = el("input", { type: "checkbox", class: "mp-sc-switch-input", "data-mp-model": f.model });
      input.checked = cur === true || cur === 1 || cur === "1";
      input.addEventListener("change", function () { commitValue(f.model, input.checked ? true : ""); });
      lab.appendChild(input);
      lab.appendChild(el("span", { class: "mp-sc-sw__track" }, [
        el("span", { class: "mp-sc-sw__thumb" }),
      ]));
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
    { model: "keyword", label: "搜索关键词", kind: "text", type: "text", icon: ICONS.search, hint: "指定搜索站点时使用的关键词" },
    { model: "total_episode", label: "总集数", kind: "text", type: "number", icon: ICONS.list, hint: "剧集总集数" },
    { model: "start_episode", label: "开始集数", kind: "text", type: "number", icon: ICONS.play, hint: "0 = 不指定" },
    { model: "quality", label: "质量", kind: "dropdown", options: NATIVE_OPTIONS.quality, icon: ICONS.hd, hint: "订阅资源质量" },
    { model: "resolution", label: "分辨率", kind: "dropdown", options: NATIVE_OPTIONS.resolution, icon: ICONS.monitor, hint: "订阅资源分辨率" },
    { model: "effect", label: "特效", kind: "dropdown", options: NATIVE_OPTIONS.effect, icon: ICONS.wand, hint: "订阅资源特效" },
    { model: "sites", label: "订阅站点", kind: "async-dropdown", api: "/site/rss",
      apiFallbacks: ["/site/", "/site"], icon: ICONS.globe, multi: true,
      placeholder: "全部", hint: "订阅的站点范围，不选使用系统设置",
      filterItem: function (s) {
        return s && (s.is_active === undefined || s.is_active === null ||
          s.is_active === true || s.is_active === 1 || s.is_active === "1");
      },
      mapItem: function (s) { return { value: Number(s.id), label: s.name }; } },
    { model: "downloader", label: "下载器", kind: "async-dropdown", api: "/download/clients", icon: ICONS.download,
      placeholder: "跟随系统", hint: "指定该订阅使用的下载器",
      mapItem: function (d) { return { value: d.name, label: d.name }; } },
    { model: "save_path", label: "保存路径", kind: "text", type: "text", icon: ICONS.folder, hint: "指定该订阅的下载保存路径，留空自动使用设定的下载目录" },
    { model: "search_interval", label: "搜索周期", kind: "dropdown", icon: ICONS.timer, placeholder: "跟随系统",
      hint: "仅在开启订阅定时搜索时生效；手动搜索和 RSS 刷新不受影响",
      options: ["6", "12", "24", "48", "72", "168"],
      optionLabel: function (v) { return v + " 小时"; } },
  ];
  const BASIC_SWITCHES = [
    { model: "best_version", label: "洗版", hint: "根据洗版优先级进行洗版订阅" },
    { model: "best_version_full", label: "全集洗版", hint: "对全集进行洗版" },
    { model: "search_imdbid", label: "使用 ImdbID 搜索", hint: "精确搜索资源" },
  ];
  const ADVANCE_FIELDS = [
    { model: "filter", label: "过滤规则", kind: "text", type: "text", icon: ICONS.filter, hint: "空格分隔（MP schema 字段，原生 UI 未暴露）" },
    { model: "include", label: "包含", kind: "text", type: "text", icon: ICONS.plus, hint: "包含规则，支持关键字 / 正则表达式" },
    { model: "exclude", label: "排除", kind: "text", type: "text", icon: ICONS.minus, hint: "排除规则，支持关键字 / 正则表达式" },
    { model: "season", label: "指定季", kind: "dropdown", options: NATIVE_OPTIONS.season, icon: ICONS.list,
      hint: "指定任意季订阅",
      optionLabel: function (v) { return v === "0" ? "特别篇" : "第 " + v + " 季"; } },
    { model: "episode_group", label: "剧集组", kind: "text", type: "text", hint: "按特定剧集组识别和刮削" },
    { model: "media_category", label: "自定义类别", kind: "text", type: "text", hint: "指定类别名称，留空自动识别" },
    { model: "custom_words", label: "自定义词", kind: "text", type: "text", hint: "自定义下载过滤词" },
  ];

  function buildPanel() {
    const overrides = readOverrides();
    const defaultEp = readDefaultEpisode();
    const isMobile = !!(window.matchMedia && window.matchMedia("(max-width:699px)").matches);

    const panel = el("div", {
      [PANEL_MARKER]: PANEL_VERSION,
      class: "mp-sc-panel" + (isMobile ? " mp-sc-panel--collapsed" : ""),
    });

    const header = el("div", { class: "mp-sc-header" });
    const hrow = el("div", { class: "mp-sc-hrow" });
    const hasStartOverride = Object.prototype.hasOwnProperty.call(overrides, "start_episode");
    const activeCount = Object.keys(overrides).length + (defaultEp > 0 && !hasStartOverride ? 1 : 0);
    hrow.appendChild(el("div", { class: "mp-sc-title",
      text: isMobile ? "订阅增强" : "订阅增强（SubscribeConfigurator）" }));
    hrow.appendChild(el("span", { class: "mp-sc-badge" + (activeCount ? " mp-sc-badge--on" : ""),
      text: activeCount ? ("已填 " + activeCount + " 项") : "未填写" }));
    const clearBtn = el("button", { type: "button", class: "mp-sc-clear",
      text: isMobile ? "清空" : "清空全部" });
    clearBtn.addEventListener("click", function (ev) {
      ev.stopPropagation();
      clearOverrides();
      const fresh = buildPanel();
      panel.parentNode.replaceChild(fresh, panel);
      console.info("[subscribeconfigurator v18] overrides cleared by user");
    });
    hrow.appendChild(clearBtn);
    const toggleBtn = el("button", { type: "button", class: "mp-sc-toggle",
      text: isMobile ? "展开" : "收起" });
    toggleBtn.setAttribute("aria-expanded", isMobile ? "false" : "true");
    toggleBtn.addEventListener("click", function (ev) {
      ev.stopPropagation();
      const collapsed = panel.classList.toggle("mp-sc-panel--collapsed");
      toggleBtn.textContent = collapsed ? "展开" : "收起";
      toggleBtn.setAttribute("aria-expanded", collapsed ? "false" : "true");
    });
    hrow.appendChild(toggleBtn);
    header.appendChild(hrow);

    const body = el("div", { class: "mp-sc-body" });
    const osLabel = el("label", { class: "mp-sc-oneshot" });
    const osInput = el("input", { type: "checkbox", class: "mp-sc-checkbox" });
    osInput.checked = isOneShot();
    osInput.addEventListener("change", function (ev) {
      ev.stopPropagation();
      try {
        // Store both states explicitly: absence means "default ON", but an
        // unchecked box must survive a "清空全部" click.
        localStorage.setItem(LS_ONESHOT_KEY, osInput.checked ? "1" : "0");
      } catch (e) {}
    });
    osLabel.appendChild(osInput);
    osLabel.appendChild(el("span", { text: "一次性（默认开启，提交一次后自动清空）" }));
    body.appendChild(osLabel);
    panel.appendChild(header);
    panel.appendChild(body);

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
    body.appendChild(tabs);
    body.appendChild(basicPane);
    body.appendChild(advPane);

    injectStyles();
    return panel;
  }

  function injectStyles() {
    // Check the DOM every time instead of a one-shot boolean: a full SPA
    // re-render or a head cleanup can remove the style tag, which used to
    // leave the panel permanently unstyled until a hard reload.
    if (document.getElementById("mp-sc-styles")) return;
    const style = document.createElement("style");
    style.id = "mp-sc-styles";
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  const ON_SURFACE = "rgb(var(--v-theme-on-surface))";
  const CSS = [
    ".mp-sc-panel{margin-top:12px;padding:16px;border-radius:8px;background:rgb(var(--v-theme-surface));color:" + ON_SURFACE + ";border:1px solid rgba(var(--v-theme-on-surface),.08);font-family:inherit;box-sizing:border-box;max-width:100%;flex:0 0 auto;touch-action:pan-y}",
    ".mp-sc-header{margin-bottom:8px}",
    ".mp-sc-hrow{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
    ".mp-sc-title{font-size:16px;font-weight:500;letter-spacing:.0125em;color:rgba(var(--v-theme-on-surface),var(--v-high-emphasis-opacity));flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
    ".mp-sc-badge{flex:0 0 auto;font-size:11px;padding:1px 8px;border-radius:10px;background:rgba(var(--v-theme-on-surface),.12);color:rgba(var(--v-theme-on-surface),var(--v-medium-emphasis-opacity))}",
    ".mp-sc-badge--on{background:rgba(var(--v-theme-primary),.16);color:rgb(var(--v-theme-primary))}",
    ".mp-sc-clear{flex:0 0 auto;margin-left:auto;background:none;border:none;border-radius:4px;padding:4px 8px;font:inherit;font-size:14px;font-weight:500;color:rgb(var(--v-theme-primary));cursor:pointer}",
    ".mp-sc-clear:hover{background:rgba(var(--v-theme-primary),.08)}",
    ".mp-sc-toggle{display:none;flex:0 0 auto;background:none;border:none;border-radius:4px;padding:4px 8px;font:inherit;font-size:14px;font-weight:500;color:rgb(var(--v-theme-primary));cursor:pointer}",
    ".mp-sc-toggle:hover{background:rgba(var(--v-theme-primary),.08)}",
    ".mp-sc-body{min-width:0}",
    ".mp-sc-oneshot{display:flex;align-items:center;gap:8px;margin-top:4px;font-size:14px;color:rgba(var(--v-theme-on-surface),var(--v-medium-emphasis-opacity));cursor:pointer;user-select:none}",
    // Vuetify-like tabs: 48px height, 16px horizontal padding
    ".mp-sc-tabs{display:flex;gap:0;margin-bottom:16px;border-bottom:1px solid rgba(var(--v-theme-on-surface),.12);min-height:48px}",
    ".mp-sc-tabbtn{background:none;border:none;padding:0 16px;margin:0 0 -1px;font:inherit;font-size:14px;font-weight:500;color:rgba(var(--v-theme-on-surface),var(--v-medium-emphasis-opacity));cursor:pointer;border-bottom:2px solid transparent;min-height:48px}",
    ".mp-sc-tabbtn--active{color:rgb(var(--v-theme-primary));border-bottom-color:rgb(var(--v-theme-primary))}",
    ".mp-sc-grid{display:grid;grid-template-columns:1fr;column-gap:12px}",
    "@media (min-width:700px){.mp-sc-grid{grid-template-columns:repeat(2,1fr)}}",
    "@media (min-width:1100px){.mp-sc-grid{grid-template-columns:repeat(3,1fr)}}",
    ".mp-sc-field{position:relative;padding-top:6px;padding-bottom:0;min-width:0}",
    ".mp-sc-ico{display:flex;align-items:center;justify-content:center;color:rgba(var(--v-theme-on-surface),var(--v-medium-emphasis-opacity));margin-right:8px}",
    // outlined field shell: native Vuetify default height is 56px
    ".mp-sc-tf__field,.mp-sc-dd__field{position:relative;display:flex;align-items:center;box-sizing:border-box;min-height:56px;padding:18px 16px 6px;border:1px solid rgba(var(--v-theme-on-surface),.38);border-radius:4px;background:transparent;transition:border-color .15s,border-width .15s}",
    ".mp-sc-tf__field{cursor:text}",
    ".mp-sc-dd__field{cursor:pointer}",
    ".mp-sc-tf__field:hover,.mp-sc-dd__field:hover{border-color:rgba(var(--v-theme-on-surface),.6)}",
    ".mp-sc-tf__field:focus-within,.mp-sc-dd__field:focus-within{border-color:rgb(var(--v-theme-primary));border-width:2px;padding:17px 15px 5px}",
    ".mp-sc-dd__field.mp-sc-dd--open{border-color:rgb(var(--v-theme-primary));border-width:2px;padding:17px 15px 5px}",
    ".mp-sc-dd__field--loading{opacity:.7}",
    ".mp-sc-input{flex:1 1 auto;min-width:0;width:100%;border:none;background:transparent;font:inherit;font-size:16px;color:" + ON_SURFACE + ";outline:none;padding:0;margin:0;box-shadow:none}",
    ".mp-sc-dd__value{flex:1 1 auto;min-width:0;font-size:16px;line-height:1.4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
    ".mp-sc-dd__value--ph{color:rgba(var(--v-theme-on-surface),var(--v-medium-emphasis-opacity))}",
    ".mp-sc-dd__value--error{font-size:14px;white-space:normal;line-height:1.25}",
    ".mp-sc-dd__arrow{flex:0 0 auto;width:8px;height:8px;margin-left:8px;border-right:2px solid rgba(var(--v-theme-on-surface),.6);border-bottom:2px solid rgba(var(--v-theme-on-surface),.6);transform:rotate(45deg) translateY(-2px);transition:transform .15s}",
    ".mp-sc-dd--open .mp-sc-dd__arrow{transform:rotate(225deg) translateY(-2px)}",
    // floating label: inside when empty, on the outline when filled/focused
    ".mp-sc-label{position:absolute;left:12px;top:50%;transform:translateY(-50%);margin:0;padding:0;font-size:16px;line-height:1;color:rgba(var(--v-theme-on-surface),var(--v-medium-emphasis-opacity));background:transparent;pointer-events:none;white-space:nowrap;transition:top .15s,font-size .15s,color .15s,background .15s,padding .15s}",
    ".mp-sc-has-icon .mp-sc-label{left:44px}",
    ".mp-sc-tf__field:focus-within .mp-sc-label,.mp-sc-dd__field:focus-within .mp-sc-label,.mp-sc-dd--filled .mp-sc-label,.mp-sc-dd--open .mp-sc-label,.mp-sc-input:not(:placeholder-shown)+.mp-sc-label{top:0;font-size:12px;background:rgb(var(--v-theme-surface));padding:0 4px}",
    ".mp-sc-tf__field:focus-within .mp-sc-label,.mp-sc-dd__field:focus-within .mp-sc-label,.mp-sc-dd--open .mp-sc-label{color:rgb(var(--v-theme-primary))}",
    ".mp-sc-dd__field:not(.mp-sc-dd--open):not(:focus-within) .mp-sc-dd__value--ph:not(.mp-sc-dd__value--error){color:transparent}",
    ".mp-sc-hint{font-size:12px;line-height:1.4;color:rgba(var(--v-theme-on-surface),var(--v-medium-emphasis-opacity));padding:4px 2px 10px}",
    // teleported menu
    // NOTE: background must be --v-theme-surface. In MP's glass theme
    // --v-theme-surface-bright is 204,191,214 (light lavender) while
    // --v-theme-on-surface is 242,245,250 (near white) -> unreadable menu.
    ".mp-sc-menu{z-index:3000;background:rgb(var(--v-theme-surface));color:" + ON_SURFACE + ";border-radius:4px;border:1px solid rgba(var(--v-theme-on-surface),.12);box-shadow:0 6px 20px rgba(0,0,0,.55);overflow:hidden}",
    ".mp-sc-menu__list{max-height:260px;overflow-y:auto;padding:8px 0}",
    ".mp-sc-menu__item{display:flex;align-items:center;gap:8px;padding:10px 16px;font-size:16px;line-height:1.4;cursor:pointer;white-space:nowrap}",
    ".mp-sc-menu__item:hover{background:rgba(var(--v-theme-on-surface),.08)}",
    ".mp-sc-menu__item--sel{color:rgb(var(--v-theme-primary))}",
    ".mp-sc-cb{flex:0 0 auto;width:18px;height:18px;border-radius:2px;border:2px solid rgba(var(--v-theme-on-surface),.54)}",
    ".mp-sc-cb--on{background:rgb(var(--v-theme-primary));border-color:rgb(var(--v-theme-primary))}",
    // Vuetify-like switch
    ".mp-sc-switchrow{display:flex;flex-wrap:wrap;gap:8px 28px;padding:4px 2px 12px}",
    ".mp-sc-sw{position:relative;display:flex;flex-wrap:wrap;align-items:flex-start;gap:0 8px;cursor:pointer;user-select:none;flex:1 1 240px;min-width:0}",
    ".mp-sc-checkbox{width:20px;height:20px;flex:0 0 auto;margin:0;accent-color:rgb(var(--v-theme-primary));cursor:pointer}",
    ".mp-sc-switch-input{position:absolute;opacity:0;width:0;height:0;margin:0;pointer-events:none}",
    ".mp-sc-sw__track{position:relative;flex:0 0 auto;width:36px;height:14px;margin-top:3px;border-radius:7px;background:rgba(var(--v-theme-on-surface),.38);transition:background .2s}",
    ".mp-sc-sw__thumb{position:absolute;top:-3px;left:-2px;width:20px;height:20px;border-radius:50%;background:rgb(var(--v-theme-surface));box-shadow:0 1px 3px rgba(0,0,0,.35);transition:transform .2s,background .2s}",
    ".mp-sc-switch-input:checked + .mp-sc-sw__track{background:rgba(var(--v-theme-primary),.54)}",
    ".mp-sc-switch-input:checked + .mp-sc-sw__track .mp-sc-sw__thumb{transform:translateX(16px);background:rgb(var(--v-theme-primary))}",
    ".mp-sc-switch-input:focus-visible + .mp-sc-sw__track{outline:2px solid rgba(var(--v-theme-primary),.5);outline-offset:2px}",
    ".mp-sc-sw__text{font-size:16px;line-height:20px;white-space:nowrap}",
    ".mp-sc-sw__hint{font-size:12px;line-height:1.35;color:rgba(var(--v-theme-on-surface),var(--v-medium-emphasis-opacity));flex:1 1 100%;padding-left:44px}",
    // Mobile: keep the panel compact and let the native `.v-card-text` scroll
    // container handle vertical scrolling. Do NOT give `.mp-sc-body` its own
    // max-height/overflow; nested scroll areas are what made the dialog feel
    // unscrollable on phones. These rules must stay last so they override the
    // base field/tab/switch rules above.
    "@media (max-width:699px){",
    ".mp-sc-panel{padding:12px;margin-top:8px}",
    ".mp-sc-header{margin-bottom:6px}",
    ".mp-sc-hrow{gap:6px;flex-wrap:nowrap}",
    ".mp-sc-title{font-size:15px}",
    ".mp-sc-badge{font-size:10px;padding:1px 6px}",
    ".mp-sc-clear{font-size:13px;padding:2px 4px}",
    ".mp-sc-toggle{display:inline-flex;align-items:center;font-size:13px;padding:2px 4px}",
    ".mp-sc-panel--collapsed .mp-sc-body{display:none}",
    ".mp-sc-oneshot{font-size:12px;margin-top:0;margin-bottom:6px;align-items:flex-start}",
    ".mp-sc-tabs{position:sticky;top:0;z-index:2;background:rgb(var(--v-theme-surface));margin-bottom:8px;min-height:40px}",
    ".mp-sc-tabbtn{min-height:40px;padding:0 12px;font-size:13px}",
    ".mp-sc-tf__field,.mp-sc-dd__field{min-height:48px;padding:14px 12px 4px}",
    ".mp-sc-tf__field:focus-within,.mp-sc-dd__field:focus-within,.mp-sc-dd__field.mp-sc-dd--open{padding:13px 11px 3px}",
    ".mp-sc-label{font-size:14px}",
    ".mp-sc-has-icon .mp-sc-label{left:40px}",
    ".mp-sc-input,.mp-sc-dd__value{font-size:15px}",
    ".mp-sc-hint{padding:2px 2px 6px;font-size:11px}",
    ".mp-sc-switchrow{gap:6px 16px;padding-bottom:8px}",
    ".mp-sc-sw{flex-basis:100%}",
    ".mp-sc-sw__text{font-size:15px}",
    ".mp-sc-sw__hint{padding-left:0}",
    "}",
  ].join("");

  const DIALOG_SELECTOR = '.v-dialog, .v-overlay__content, [role="dialog"]';

  function tryInject(root) {
    if (!root) return;
    // Cheap self-heal: if an SPA re-render dropped the <style> tag while the
    // panel survived, this restores it on the next scan.
    injectStyles();
    const candidates = [];
    if (root.nodeType === 1 && root.matches && root.matches(DIALOG_SELECTOR)) {
      candidates.push(root);
    }
    if (typeof root.querySelectorAll === "function") {
      root.querySelectorAll(DIALOG_SELECTOR).forEach(function (d) { candidates.push(d); });
    }
    let injected = 0;
    candidates.forEach(function (dialog) {
      if (!dialog) return;
      const old = dialog.querySelector("[" + PANEL_MARKER + "]");
      if (old) {
        // A live panel from this build is fine; do NOT remove it before
        // checking the patched flag (v14 did, so a repeat scan deleted the UI).
        if (old.getAttribute(PANEL_MARKER) === PANEL_VERSION) {
          dialog.__mp_sc_patched = true;
          return;
        }
        old.remove();
        dialog.__mp_sc_patched = false;
      } else if (dialog.__mp_sc_patched) {
        // SPA re-render dropped the panel but kept the element flag.
        dialog.__mp_sc_patched = false;
      }
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
      // Inject into the native scroll container instead of the dialog root.
      // `.v-card-text` is the element Vuetify gives `overflow-y:auto` to
      // (`.v-dialog--scrollable > .v-overlay__content > .v-card > .v-card-text`).
      // Appending to `.v-overlay__content` puts the panel outside that scroll
      // area; on mobile the dialog then cannot scroll to the panel or the
      // submit button. If the card has not rendered yet, skip this pass and
      // let the next MutationObserver scan retry.
      const target = dialog.querySelector(".v-card-text") || dialog.querySelector(".v-card");
      if (!target) return;
      target.appendChild(buildPanel());
      dialog.__mp_sc_patched = true;
      injected += 1;
    });
    if (injected > 0) console.info("[subscribeconfigurator v18] injected into " + injected + " dialog(s)");
  }

  let injectTimer = null;
  let pendingRoots = [];
  function scheduleInject(root) {
    if (!root) root = document.body;
    if (pendingRoots.indexOf(root) === -1) pendingRoots.push(root);
    if (injectTimer) return;
    // MP's dialog renders many nested nodes; coalesce them into one scan.
    injectTimer = setTimeout(function () {
      injectTimer = null;
      const roots = pendingRoots;
      pendingRoots = [];
      roots.forEach(tryInject);
    }, 100);
  }

  function attach() {
    tryInject(document.body);
    const obs = new MutationObserver(function (muts) {
      muts.forEach(function (m) {
        for (let i = 0; i < m.addedNodes.length; i++) {
          const n = m.addedNodes[i];
          if (!n || n.nodeType !== 1) continue;
          scheduleInject(n);
          // The dialog card can render after the overlay. If only a descendant
          // (e.g. .v-card-text) was added, scanning that node alone would miss
          // the ancestor dialog, so schedule the closest dialog too.
          const host = n.closest ? n.closest(DIALOG_SELECTOR) : null;
          if (host && host !== n) scheduleInject(host);
        }
      });
    });
    obs.observe(document.body, { childList: true, subtree: true });
    console.info("[subscribeconfigurator v18] loaded (XHR hook + custom dropdown)");
  }

  window.addEventListener("error", function (e) {
    if (e && e.filename && String(e.filename).indexOf("_subscribe_patch") !== -1)
      console.error("[subscribeconfigurator v18] SCRIPT ERROR", e.message, ":" + e.lineno);
  });

  try {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", attach);
    else attach();
  } catch (e) { console.error("[subscribeconfigurator v18] FATAL", e); }
})();