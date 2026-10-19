/* SubscribeConfigurator — frontend patch v1
 * Injected by the SubscribeConfigurator MP plugin into /public/index.html.
 * Responsibilities:
 *   1. Intercept fetch POST /api/v1/subscribe and merge per-subscription overrides
 *      from localStorage into the JSON body before it leaves the browser.
 *   2. MutationObserver watch for the Add-Subscribe dialog and inject a panel
 *      with start_episode / filter / include / exclude / quality / resolution / effect
 *      inputs. Field changes are persisted to localStorage.
 *
 * Safe to load multiple times: all state is read from localStorage; markers
 * prevent double-injection. Errors are caught and logged; never throws.
 */
(function () {
  "use strict";

  const LS_OVERRIDES_KEY = "mp_subscribe_overrides";
  const LS_DEFAULT_EPISODE_KEY = "mp_subscribe_default_start_episode";
  const PANEL_MARKER = "data-mp-subscribe-configurator";

  // ── localStorage helpers ───────────────────────────────────────────
  function readOverrides() {
    try {
      return JSON.parse(localStorage.getItem(LS_OVERRIDES_KEY) || "{}");
    } catch (e) {
      return {};
    }
  }

  function writeOverrides(obj) {
    try {
      localStorage.setItem(LS_OVERRIDES_KEY, JSON.stringify(obj));
    } catch (e) {
      /* private mode / quota — silently ignore */
    }
  }

  function readDefaultEpisode() {
    const raw = localStorage.getItem(LS_DEFAULT_EPISODE_KEY);
    if (!raw) return 0;
    const n = parseInt(raw, 10);
    return isNaN(n) ? 0 : n;
  }

  // ── fetch interception ────────────────────────────────────────────
  const OrigFetch = window.fetch;
  window.fetch = function (resource, init) {
    try {
      const url = typeof resource === "string"
        ? resource
        : (resource && resource.url) || "";
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
            if (
              defaultEp > 0 &&
              (body.start_episode === undefined ||
                body.start_episode === null ||
                body.start_episode === 0)
            ) {
              body.start_episode = defaultEp;
              changed = true;
            }
            if (changed) init.body = JSON.stringify(body);
          } catch (e) {
            /* non-JSON body — pass through */
          }
        }
      }
    } catch (e) {
      /* never break fetch */
    }
    return OrigFetch.apply(this, arguments);
  };

  // ── DOM injection ─────────────────────────────────────────────────
  function el(tag, props, children) {
    const node = document.createElement(tag);
    if (props) {
      for (const k in props) {
        if (k === "style") {
          node.style.cssText = props[k];
        } else if (k === "text") {
          node.textContent = props[k];
        } else if (k.indexOf("on") === 0 && typeof props[k] === "function") {
          node.addEventListener(k.slice(2).toLowerCase(), props[k]);
        } else {
          node.setAttribute(k, props[k]);
        }
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

  const FIELDS = [
    { model: "start_episode", label: "开始集数", type: "number", placeholder: "0 = 不指定" },
    { model: "filter", label: "过滤规则（空格分隔）", type: "text", placeholder: "" },
    { model: "include", label: "包含关键词（空格分隔）", type: "text", placeholder: "" },
    { model: "exclude", label: "排除关键词（空格分隔）", type: "text", placeholder: "" },
    { model: "quality", label: "质量（空格分隔，如 BluRay WEB-DL）", type: "text", placeholder: "" },
    { model: "resolution", label: "分辨率（空格分隔，如 1080p 2160p）", type: "text", placeholder: "" },
    { model: "effect", label: "效果（空格分隔，如 HDR SDR）", type: "text", placeholder: "" },
  ];

  function buildPanel() {
    const overrides = readOverrides();
    const defaultEp = readDefaultEpisode();

    const panel = el("div", {
      [PANEL_MARKER]: "v1",
      style:
        "margin-top: 16px; padding: 12px; border: 1px dashed #888; border-radius: 6px;" +
        " font-size: 13px; background: rgba(127,127,127,0.08);",
    });

    panel.appendChild(
      el("div", {
        style: "font-weight: 600; margin-bottom: 8px; opacity: 0.85;",
        text: "订阅增强（SubscribeConfigurator）",
      })
    );

    FIELDS.forEach(function (field) {
      const wrap = el("div", { style: "margin-bottom: 8px;" });
      wrap.appendChild(
        el("label", {
          style: "display: block; font-size: 12px; opacity: 0.75; margin-bottom: 3px;",
          text: field.label,
        })
      );
      const input = el("input", {
        type: field.type || "text",
        placeholder: field.placeholder || "",
        "data-mp-model": field.model,
        style:
          "width: 100%; padding: 6px 8px; border-radius: 4px; border: 1px solid #888;" +
          " background: rgba(0,0,0,0.2); color: inherit; font: inherit; box-sizing: border-box;",
      });
      const cur = overrides[field.model];
      if (cur !== undefined && cur !== null) input.value = String(cur);
      if (field.model === "start_episode" && !input.value && defaultEp > 0) {
        input.value = String(defaultEp);
      }
      input.addEventListener("input", function () {
        const next = readOverrides();
        const val = input.value.trim();
        if (val === "") {
          delete next[field.model];
        } else if (field.type === "number") {
          const n = parseInt(val, 10);
          next[field.model] = isNaN(n) ? null : n;
        } else {
          next[field.model] = val;
        }
        writeOverrides(next);
      });
      wrap.appendChild(input);
      panel.appendChild(wrap);
    });

    panel.appendChild(
      el("div", {
        style:
          "font-size: 11px; opacity: 0.6; margin-top: 6px; line-height: 1.4;",
        text:
          "字段值保存到 localStorage，每次添加订阅自动套用。可在 MP 订阅详情页继续编辑。",
      })
    );

    return panel;
  }

  function tryInject(root) {
    if (!root || typeof root.querySelectorAll !== "function") return;
    const candidates = root.querySelectorAll(
      ".v-dialog .v-card, .v-overlay__content, [role='dialog']"
    );
    candidates.forEach(function (dialog) {
      if (!dialog || dialog.__mp_subscribe_configurator_patched) return;
      const text = (dialog.textContent || "").trim();
      if (text.indexOf("订阅") === -1) return;
      if (dialog.querySelector("[" + PANEL_MARKER + "]")) {
        dialog.__mp_subscribe_configurator_patched = true;
        return;
      }
      const target = dialog.querySelector("form") || dialog;
      target.appendChild(buildPanel());
      dialog.__mp_subscribe_configurator_patched = true;
      // eslint-disable-next-line no-console
      console.info("[subscribeconfigurator] panel injected");
    });
  }

  // ── boot ──
  function boot() {
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
    // eslint-disable-next-line no-console
    console.info("[subscribeconfigurator] patch loaded");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();