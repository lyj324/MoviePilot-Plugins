/* SubscribeConfigurator — frontend patch v3
 * v3 changes vs v2:
 *   - Inject EXACTLY ONCE per dialog (skip nested .v-card to avoid double injection)
 *   - Use Vuetify VTextField-style outlined inputs (line-bottom border, theme-friendly)
 *   - Tighter layout matching MP native dialog aesthetic
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

  // Vuetify-style outlined VTextField-ish. Reads CSS vars the app already provides
  // (--v-theme-on-surface, --v-theme-surface, --v-border-color, --v-medium-emphasis-opacity).
  function buildField(field, overrides, defaultEp) {
    const wrap = el("div", {
      class: "mp-sc-field",
      style:
        "padding: 6px 0;" +
        "font-family: inherit;",
    });

    const label = el("label", {
      style:
        "display: block; font-size: 12px; line-height: 18px;" +
        "color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));",
      text: field.label,
    });
    wrap.appendChild(label);

    const input = el("input", {
      type: field.type || "text",
      placeholder: field.placeholder || "",
      "data-mp-model": field.model,
      class: "mp-sc-input",
      style:
        "width: 100%; box-sizing: border-box;" +
        "padding: 4px 12px 8px 0;" +
        "font: inherit; font-size: 14px;" +
        "color: rgb(var(--v-theme-on-surface));" +
        "background: transparent;" +
        "border: none;" +
        "border-bottom: 1px solid rgba(var(--v-theme-on-surface), var(--v-border-opacity));" +
        "border-radius: 0;" +
        "outline: none;" +
        "transition: border-color 0.15s ease;",
    });
    const cur = overrides[field.model];
    if (cur !== undefined && cur !== null) input.value = String(cur);
    if (field.model === "start_episode" && !input.value && defaultEp > 0)
      input.value = String(defaultEp);

    input.addEventListener("focus", function () {
      input.style.borderBottomColor =
        "2px solid rgb(var(--v-theme-primary))";
      input.style.borderBottom =
        "2px solid rgb(var(--v-theme-primary))";
    });
    input.addEventListener("blur", function () {
      input.style.borderBottom =
        "1px solid rgba(var(--v-theme-on-surface), var(--v-border-opacity))";
    });

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
    return wrap;
  }

  const FIELDS = [
    { model: "start_episode", label: "开始集数", type: "number", placeholder: "0 = 不指定" },
    { model: "filter", label: "过滤规则（空格分隔）", type: "text" },
    { model: "include", label: "包含关键词（空格分隔）", type: "text" },
    { model: "exclude", label: "排除关键词（空格分隔）", type: "text" },
    { model: "quality", label: "质量（空格分隔，如 BluRay WEB-DL）", type: "text" },
    { model: "resolution", label: "分辨率（空格分隔，如 1080p 2160p）", type: "text" },
    { model: "effect", label: "效果（空格分隔，如 HDR SDR）", type: "text" },
  ];

  function buildPanel() {
    const overrides = readOverrides();
    const defaultEp = readDefaultEpisode();

    // Divider + subtle heading — Vuetify style
    const panel = el("div", {
      [PANEL_MARKER]: "v3",
      style:
        "margin-top: 8px;" +
        "padding-top: 12px;" +
        "border-top: 1px solid rgba(var(--v-theme-on-surface), var(--v-border-opacity));" +
        "font-family: inherit;",
    });
    panel.appendChild(el("div", {
      style:
        "font-size: 13px; font-weight: 500;" +
        "color: rgba(var(--v-theme-on-surface), var(--v-high-emphasis-opacity));" +
        "letter-spacing: 0.0125em;" +
        "margin-bottom: 4px;",
      text: "订阅增强（SubscribeConfigurator）",
    }));
    panel.appendChild(el("div", {
      style:
        "font-size: 11px;" +
        "color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));" +
        "margin-bottom: 8px;",
      text: "字段值保存到 localStorage，提交订阅时自动附加。可在订阅详情页继续编辑。",
    }));

    FIELDS.forEach(function (field) {
      panel.appendChild(buildField(field, overrides, defaultEp));
    });
    return panel;
  }

  // v3: pick .v-dialog only (Vuetify). Skip if already patched. Skip if "开始集数"
  // exists (edit dialog). Skip if no form-like controls.
  function tryInject(root) {
    if (!root || typeof root.querySelectorAll !== "function") return;
    const candidates = root.querySelectorAll(".v-dialog");
    let injected = 0;
    candidates.forEach(function (dialog) {
      if (!dialog || dialog.__mp_sc_patched) return;
      const text = (dialog.textContent || "").trim();
      if (text.length < 4) return;
      // Skip edit dialog (already exposes fields natively)
      if (text.indexOf("开始集数") !== -1) return;
      // Skip if no form-like controls
      if (!dialog.querySelector("button, .v-btn, input, .v-input")) return;
      if (dialog.querySelector("[" + PANEL_MARKER + "]")) {
        dialog.__mp_sc_patched = true;
        return;
      }
      // Inject into .v-card-text (Vuetify's content slot). Fall back to dialog.
      const target = dialog.querySelector(".v-card-text, .v-card, form") || dialog;
      target.appendChild(buildPanel());
      dialog.__mp_sc_patched = true;
      injected += 1;
      console.info(
        "[subscribeconfigurator v3] injected, dialog snippet:",
        text.substring(0, 60).replace(/\s+/g, " ")
      );
    });
    if (injected > 0) {
      console.info("[subscribeconfigurator v3] injected into", injected, "dialog(s)");
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
    console.info("[subscribeconfigurator v3] loaded, MutationObserver active");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", attach);
  } else {
    attach();
  }
})();