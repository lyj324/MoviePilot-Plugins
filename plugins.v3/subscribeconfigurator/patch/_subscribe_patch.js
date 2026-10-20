/* SubscribeConfigurator — frontend patch v10
 * v10 changes vs v9:
 *   - quality / resolution / effect are now SELECT dropdowns with MP-native option
 *     lists (extracted from MP frontend bundle: qualityOptions / resolutionOptions /
 *     effectOptions) instead of free-text inputs, so users always pick legal values.
 *     A "自定义…" escape hatch keeps free input available.
 *   - Filter / include / exclude stay as free-text inputs (they are regex-capable).
 *   - Rest of v9 visuals unchanged (outlined v-text-field, floating label, card).
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
    // dropdown-backed fields (quality / resolution / effect) render as selects
    if (field.options) return buildSelectField(field, overrides);

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

  // MP-native option lists, extracted verbatim from the MP v3 frontend bundle
  // (index-*.js: qualityOptions / resolutionOptions / effectOptions). Using the exact
  // strings MP's own v-autocomplete fields offer, so we never send illegal values.
  const NATIVE_OPTIONS = {
    quality: ["蓝光原盘", "Remux", "BluRay", "UHD", "WEB-DL", "HDTV", "H265", "H264"],
    resolution: ["4k", "1080p", "720p"],
    effect: ["杜比视界", "杜比全景声", "HDR", "SDR"],
  };

  // Select-backed field (quality / resolution / effect): a native <select> styled to
  // match Vuetify v-autocomplete (outlined box + floating label + chevron).
  // An empty first option mirrors MP's "全部" (no filter). A "自定义…" option reveals
  // a free-text input for values outside the native list.
  function buildSelectField(field, overrides) {
    const wrap = el("div", { class: "mp-sc-field mp-sc-field--select" });
    const cur = overrides[field.model];
    const current = cur === undefined || cur === null ? "" : String(cur);
    const isNative = current === "" || field.options.indexOf(current) !== -1;

    const box = el("div", { class: "mp-sc-selectbox" });
    const select = el("select", {
      class: "mp-sc-select",
      "data-mp-model": field.model,
    });
    select.appendChild(el("option", { value: "" }));
    field.options.forEach(function (opt) {
      select.appendChild(el("option", { value: opt, text: opt }));
    });
    select.appendChild(el("option", { value: "__custom__", text: "自定义…" }));
    select.value = isNative ? current : "__custom__";

    box.appendChild(select);
    box.appendChild(el("label", { class: "mp-sc-label", text: field.label }));

    const customWrap = el("div", { class: "mp-sc-custom", style: "display:none" });
    const customInput = el("input", {
      type: "text",
      class: "mp-sc-input",
      placeholder: "自定义值",
      "data-mp-custom": field.model,
      autocomplete: "off",
    });
    if (!isNative && current) customInput.value = current;
    customWrap.appendChild(customInput);
    wrap.appendChild(box);
    wrap.appendChild(customWrap);

    function commit(val) {
      const next = readOverrides();
      if (val === "" || val === "__custom__") delete next[field.model];
      else next[field.model] = val;
      writeOverrides(next);
    }

    select.addEventListener("change", function () {
      const v = select.value;
      if (v === "__custom__") {
        customWrap.style.display = "block";
        customInput.focus();
        return;
      }
      customWrap.style.display = "none";
      customInput.value = "";
      commit(v);
    });
    customInput.addEventListener("input", function () {
      commit(customInput.value.trim());
    });

    if (!isNative && current) customWrap.style.display = "block";
    return wrap;
  }

  const FIELDS = [
    { model: "start_episode", label: "开始集数", type: "number", placeholder: "0 = 不指定" },
    { model: "filter", label: "过滤规则", type: "text", placeholder: "空格分隔" },
    { model: "include", label: "包含关键词", type: "text", placeholder: "空格分隔" },
    { model: "exclude", label: "排除关键词", type: "text", placeholder: "空格分隔" },
    { model: "quality", label: "质量", type: "text", options: NATIVE_OPTIONS.quality },
    { model: "resolution", label: "分辨率", type: "text", options: NATIVE_OPTIONS.resolution },
    { model: "effect", label: "特效", type: "text", options: NATIVE_OPTIONS.effect },
  ];

  function buildPanel() {
    const overrides = readOverrides();
    const defaultEp = readDefaultEpisode();

    // Outer container — v-card-like (rounded surface bg + subtle border)
    const panel = el("div", {
      [PANEL_MARKER]: "v10",
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
    // ── Select (v-autocomplete look) ──
    ".mp-sc-selectbox {",
    "  position: relative;",
    "  display: block;",
    "}",
    ".mp-sc-select {",
    "  width: 100%;",
    "  box-sizing: border-box;",
    "  padding: 20px 32px 8px 12px;",
    "  font: inherit;",
    "  font-size: 14px;",
    "  color: rgb(var(--v-theme-on-surface));",
    "  background: transparent;",
    "  border: 1px solid rgba(var(--v-theme-on-surface), 0.38);",
    "  border-radius: 4px;",
    "  outline: none;",
    "  appearance: none;",
    "  -webkit-appearance: none;",
    "  cursor: pointer;",
    "  transition: border-color 0.18s ease, border-width 0.18s ease;",
    "}",
    ".mp-sc-select:hover {",
    "  border-color: rgba(var(--v-theme-on-surface), 0.6);",
    "}",
    ".mp-sc-select:focus {",
    "  border-color: rgb(var(--v-theme-primary));",
    "  border-width: 2px;",
    "  padding: 19px 31px 7px 11px;",
    "}",
    ".mp-sc-select:invalid, .mp-sc-select option[value=''] { color: rgba(var(--v-theme-on-surface), 0.6); }",
    // chevron affordance (v-autocomplete append icon)
    ".mp-sc-selectbox::after {",
    "  content: '';",
    "  position: absolute;",
    "  right: 12px;",
    "  top: 50%;",
    "  width: 7px;",
    "  height: 7px;",
    "  margin-top: -6px;",
    "  border-right: 2px solid rgba(var(--v-theme-on-surface), 0.6);",
    "  border-bottom: 2px solid rgba(var(--v-theme-on-surface), 0.6);",
    "  transform: rotate(45deg);",
    "  pointer-events: none;",
    "}",
    // select always has a value slot, so its label is always floated
    ".mp-sc-selectbox .mp-sc-label { top: 8px; font-size: 12px; }",
    ".mp-sc-select:focus ~ .mp-sc-label,",
    ".mp-sc-selectbox:hover .mp-sc-label {",
    "  color: rgb(var(--v-theme-primary));",
    "}",
    ".mp-sc-custom { margin-top: 6px; }",
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
        console.info("[sc v10] dialog #" + idx + " skip: edit dialog (has 开始集数)");
        return;
      }
      if (text.indexOf("总集数") !== -1) {
        console.info("[sc v10] dialog #" + idx + " skip: edit dialog (has 总集数)");
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
          console.info("[sc v10] dialog #" + idx + " skip: edit dialog (has 保存 + 编辑订阅)");
          return;
        }
      }
      if (!isAdd) {
        // Log only the index + reason, not the DOM text or button labels.
        console.info("[sc v10] dialog #" + idx + " skip: no add-subscribe button found");
        return;
      }
      const target = dialog.querySelector(".v-card-text, .v-card, form, .v-overlay__content") || dialog;
      target.appendChild(buildPanel());
      dialog.__mp_sc_patched = true;
      injected += 1;
      console.info("[subscribeconfigurator v10] injected into " + injected + " dialog(s)");
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
    console.info("[subscribeconfigurator v10] loaded, MutationObserver active");
  }

  window.addEventListener("error", function (e) {
    if (e && e.filename && String(e.filename).indexOf("_subscribe_patch") !== -1) {
      console.error("[subscribeconfigurator v10] SCRIPT ERROR", e.message, e.filename, ":" + e.lineno);
    }
  });

  try {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", attach);
    } else {
      attach();
    }
  } catch (e) {
    console.error("[subscribeconfigurator v10] FATAL on attach", e);
  }
})();