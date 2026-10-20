/* SubscribeConfigurator — frontend patch v9
 * v9 changes vs v8:
 *   - VISUAL MATCH with MP native Vuetify v-text-field outlined variant:
 *     - bordered input (1px outline resting, 2px primary on focus)
 *     - floating label that rises + shrinks when focused or filled
 *     - background surface color on the floating label so the border is "cut" behind it
 *   - Panel itself styled as a v-card (rounded, surface bg, subtle border)
 *   - Field grid: 2-col on narrow, 3-col on wide (mimics v-row / v-col-md-4)
 *   - Per-skip-path diagnostic logs retained from v8
 */
(function () {
  "use strict";

  const LS_OVERRIDES_KEY = "mp_subscribe_overrides";
  const LS_DEFAULT_EPISODE_KEY = "mp_subscribe_default_start_episode";
  const PANEL_MARKER = "data-mp-subscribe-configurator";

  function readOverrides() {
    try { return JSON.parse(localStorage.getItem(LS_OVERRIDES_KEY) || "{}"); }
    catch (e) { return {}; }
  }
  function writeOverrides(obj) {
    try { localStorage.setItem(LS_OVERRIDES_KEY, JSON.stringify(obj)); }
    catch (e) {}
  }
  function readDefaultEpisode() {
    const raw = localStorage.getItem(LS_DEFAULT_EPISODE_KEY);
    if (!raw) return 0;
    const n = parseInt(raw, 10);
    return isNaN(n) ? 0 : n;
  }

  // ── fetch interception ──
  const OrigFetch = window.fetch;
  window.fetch = function (resource, init) {
    try {
      const url = typeof resource === "string" ? resource : (resource && resource.url) || "";
      const method = ((init && init.method) || "GET").toUpperCase();
      if (method === "POST" && url.indexOf("/api/v1/subscribe") !== -1) {
        if (init && init.body) {
          try {
            const body = JSON.parse(init.body);
            const overrides = readOverrides();
            let changed = false;
            for (const k in overrides) {
              if (!Object.prototype.hasOwnProperty.call(overrides, k)) continue;
              const v = overrides[k];
              if (v === "" || v === null || v === undefined) continue;
              body[k] = v;
              changed = true;
            }
            const defaultEp = readDefaultEpisode();
            if (defaultEp > 0 && (!body.start_episode || body.start_episode === 0)) {
              body.start_episode = defaultEp;
              changed = true;
            }
            if (changed) init.body = JSON.stringify(body);
          } catch (e) {}
        }
      }
    } catch (e) {}
    return OrigFetch.apply(this, arguments);
  };

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

  // Build one outlined v-text-field-ish input with floating label.
  // Visually matches Vuetify's v-text-field variant="outlined":
  //   - 1px border resting, 2px primary on focus
  //   - label floats above border when focused or filled
  //   - surface bg on the label so it visually "cuts" the border
  function buildField(field, overrides, defaultEp) {
    const wrap = el("div", { class: "mp-sc-field" });

    const cur = overrides[field.model];
    const hasValue = cur !== undefined && cur !== null && cur !== "";
    const displayVal = hasValue
      ? String(cur)
      : (field.model === "start_episode" && defaultEp > 0 ? String(defaultEp) : "");

    // Input (placeholder = label text so :placeholder-shown trick works)
    const input = el("input", {
      type: field.type || "text",
      placeholder: " ",
      "data-mp-model": field.model,
      class: "mp-sc-input",
      autocomplete: "off",
      spellcheck: false,
    });
    input.value = displayVal;

    // Label
    const label = el("label", {
      class: "mp-sc-label",
      for_: "",
      text: field.label,
    });

    // Hint (placeholder text shown only when field is empty)
    const hint = field.placeholder && !hasValue ? el("div", {
      class: "mp-sc-hint",
      text: field.placeholder,
    }) : null;

    input.addEventListener("input", function () {
      const next = readOverrides();
      const val = input.value.trim();
      if (val === "") delete next[field.model];
      else if (field.type === "number") {
        const n = parseInt(val, 10);
        next[field.model] = isNaN(n) ? null : n;
      } else next[field.model] = val;
      writeOverrides(next);
    });

    wrap.appendChild(input);
    wrap.appendChild(label);
    if (hint) wrap.appendChild(hint);
    return wrap;
  }

  const FIELDS = [
    { model: "start_episode", label: "开始集数", type: "number", placeholder: "0 = 不指定" },
    { model: "filter", label: "过滤规则", type: "text", placeholder: "空格分隔" },
    { model: "include", label: "包含关键词", type: "text", placeholder: "空格分隔" },
    { model: "exclude", label: "排除关键词", type: "text", placeholder: "空格分隔" },
    { model: "quality", label: "质量", type: "text", placeholder: "BluRay WEB-DL" },
    { model: "resolution", label: "分辨率", type: "text", placeholder: "1080p 2160p" },
    { model: "effect", label: "特效", type: "text", placeholder: "HDR SDR" },
  ];

  function buildPanel() {
    const overrides = readOverrides();
    const defaultEp = readDefaultEpisode();

    // Outer container — v-card-like (rounded surface bg + subtle border)
    const panel = el("div", {
      [PANEL_MARKER]: "v9",
      class: "mp-sc-panel",
    });

    // Header strip (like v-card-item)
    const header = el("div", { class: "mp-sc-header" });
    header.appendChild(el("div", {
      class: "mp-sc-title",
      text: "订阅增强（SubscribeConfigurator）",
    }));
    header.appendChild(el("div", {
      class: "mp-sc-hint",
      text: "字段值保存到 localStorage，提交订阅时自动附加。可在订阅详情页继续编辑。",
    }));
    panel.appendChild(header);

    // Grid container — 1 col, 2 col, 3 col responsive
    const grid = el("div", { class: "mp-sc-grid" });
    FIELDS.forEach(function (field) {
      grid.appendChild(buildField(field, overrides, defaultEp));
    });
    panel.appendChild(grid);

    // Inject styles once
    if (!document.getElementById("mp-sc-styles")) {
      const style = document.createElement("style");
      style.id = "mp-sc-styles";
      style.textContent = MP_SC_CSS;
      document.head.appendChild(style);
    }
    return panel;
  }

  // CSS that mimics Vuetify v3 outlined v-text-field visual.
  const MP_SC_CSS = [
    // ── Panel (v-card) ──
    ".mp-sc-panel {",
    "  margin-top: 12px;",
    "  padding: 16px;",
    "  border-radius: 8px;",
    "  background: rgb(var(--v-theme-surface));",
    "  color: rgb(var(--v-theme-on-surface));",
    "  border: 1px solid rgba(var(--v-theme-on-surface), var(--v-border-opacity));",
    "  font-family: inherit;",
    "}",
    ".mp-sc-header { margin-bottom: 12px; }",
    ".mp-sc-title {",
    "  font-size: 14px;",
    "  font-weight: 500;",
    "  letter-spacing: 0.0125em;",
    "  margin-bottom: 4px;",
    "  color: rgba(var(--v-theme-on-surface), var(--v-high-emphasis-opacity));",
    "}",
    ".mp-sc-hint {",
    "  font-size: 12px;",
    "  line-height: 1.5;",
    "  color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));",
    "}",
    // ── Grid (v-row / v-col-md-4) ──
    ".mp-sc-grid {",
    "  display: grid;",
    "  grid-template-columns: 1fr;",
    "  gap: 4px 16px;",
    "}",
    "@media (min-width: 700px) { .mp-sc-grid { grid-template-columns: repeat(2, 1fr); } }",
    "@media (min-width: 1024px) { .mp-sc-grid { grid-template-columns: repeat(3, 1fr); } }",
    // ── Field (v-text-field outlined) ──
    ".mp-sc-field {",
    "  position: relative;",
    "  padding-top: 14px;",
    "  padding-bottom: 8px;",
    "}",
    ".mp-sc-input {",
    "  width: 100%;",
    "  box-sizing: border-box;",
    "  padding: 8px 12px;",
    "  font: inherit;",
    "  font-size: 14px;",
    "  color: rgb(var(--v-theme-on-surface));",
    "  background: transparent;",
    "  border: 1px solid rgba(var(--v-theme-on-surface), 0.38);",
    "  border-radius: 4px;",
    "  outline: none;",
    "  transition: border-color 0.18s ease, border-width 0.18s ease;",
    "}",
    ".mp-sc-input:hover {",
    "  border-color: rgba(var(--v-theme-on-surface), 0.6);",
    "}",
    ".mp-sc-input:focus {",
    "  border-color: rgb(var(--v-theme-primary));",
    "  border-width: 2px;",
    "  padding: 7px 11px;",
    "}",
    // Floating label
    ".mp-sc-label {",
    "  position: absolute;",
    "  left: 12px;",
    "  top: 22px;",
    "  font-size: 14px;",
    "  line-height: 1;",
    "  color: rgba(var(--v-theme-on-surface), 0.6);",
    "  background: rgb(var(--v-theme-surface));",
    "  padding: 0 4px;",
    "  pointer-events: none;",
    "  transition: top 0.18s ease, font-size 0.18s ease, color 0.18s ease;",
    "}",
    ".mp-sc-input:focus ~ .mp-sc-label,",
    ".mp-sc-input:not(:placeholder-shown) ~ .mp-sc-label {",
    "  top: 8px;",
    "  font-size: 12px;",
    "  color: rgb(var(--v-theme-primary));",
    "}",
    ".mp-sc-input:not(:focus):not(:placeholder-shown) ~ .mp-sc-label {",
    "  color: rgba(var(--v-theme-on-surface), var(--v-high-emphasis-opacity));",
    "}",
    // Hint below field (only shown when value empty + has hint text)
    ".mp-sc-field .mp-sc-hint {",
    "  font-size: 11px;",
    "  margin-top: 2px;",
    "  margin-left: 12px;",
    "  color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));",
    "}",
  ].join("\n");

  // v9: precise submit-button match. Diagnostic logs only carry non-sensitive
  // identifiers (dialog index + static reason) — never DOM text — so user-shared
  // console screenshots don't leak subscription/resource titles.
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
      if (text.indexOf("开始集数") !== -1) {
        console.info("[sc v9] dialog #" + idx + " skip: edit dialog (has 开始集数)");
        return;
      }
      if (text.indexOf("总集数") !== -1) {
        console.info("[sc v9] dialog #" + idx + " skip: edit dialog (has 总集数)");
        return;
      }
      const btns = dialog.querySelectorAll("button, .v-btn");
      let isAdd = false;
      for (let i = 0; i < btns.length; i++) {
        const btnText = (btns[i].textContent || "").trim();
        if (/^提交订阅$|^添加订阅$|^新增订阅$|^请选择订阅季$/.test(btnText)) {
          isAdd = true;
        }
        if (btnText === "保存" && text.indexOf("编辑订阅") !== -1) {
          console.info("[sc v9] dialog #" + idx + " skip: edit dialog (has 保存 + 编辑订阅)");
          return;
        }
      }
      if (!isAdd) {
        // Log only the index + reason, not the DOM text or button labels.
        console.info("[sc v9] dialog #" + idx + " skip: no add-subscribe button found");
        return;
      }
      const target = dialog.querySelector(".v-card-text, .v-card, form, .v-overlay__content") || dialog;
      target.appendChild(buildPanel());
      dialog.__mp_sc_patched = true;
      injected += 1;
      console.info("[subscribeconfigurator v9] injected into " + injected + " dialog(s)");
    });
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
    console.info("[subscribeconfigurator v9] loaded, MutationObserver active");
  }

  window.addEventListener("error", function (e) {
    if (e && e.filename && String(e.filename).indexOf("_subscribe_patch") !== -1) {
      console.error("[subscribeconfigurator v9] SCRIPT ERROR", e.message, e.filename, ":" + e.lineno);
    }
  });

  try {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", attach);
    } else {
      attach();
    }
  } catch (e) {
    console.error("[subscribeconfigurator v9] FATAL on attach", e);
  }
})();