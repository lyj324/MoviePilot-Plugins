/* Regression test: the panel must live inside .v-card-text (the scroll area).
 *
 * Run: npm install && node tests/js/run.cjs
 */
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const PLUGIN = path.join(
  __dirname,
  "../../plugins.v3/subscribeconfigurator/patch/_subscribe_patch.js"
);

const assert = require("assert");

let src = fs.readFileSync(PLUGIN, "utf8");
const VERSION_MATCH = src.match(/PANEL_VERSION = "([^"]+)"/);
assert.ok(VERSION_MATCH, "PANEL_VERSION not found in patch JS");
const PANEL_VERSION = VERSION_MATCH[1];

const EXPORT_LINE = "  window.__mp_sc_test = { tryInject: tryInject, buildPanel: buildPanel };\n";
src = src.replace('  window.addEventListener("error"', () => EXPORT_LINE + '  window.addEventListener("error"');

function makeDom(mobile) {
  const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", {
    url: "http://localhost/",
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const { window } = dom;
  window.__MP_SC_CONFIG__ = { default_start_episode: 3, auto_apply_defaults: false };
  window.matchMedia = function (q) {
    return { matches: !!mobile && q.indexOf("max-width") !== -1, media: q, addListener() {}, removeListener() {} };
  };
  window.fetch = function () {
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ data: [] }) });
  };
  window.eval(src);
  return window;
}

function makeDialog(window) {
  const dialog = window.document.createElement("div");
  dialog.className = "v-overlay v-dialog v-dialog--scrollable";
  dialog.setAttribute("role", "dialog");
  const content = window.document.createElement("div");
  content.className = "v-overlay__content";
  const card = window.document.createElement("div");
  card.className = "v-card";
  const text = window.document.createElement("div");
  text.className = "v-card-text";
  const form = window.document.createElement("form");
  const input = window.document.createElement("input");
  input.className = "v-field__input";
  form.appendChild(input);
  const btn = window.document.createElement("button");
  btn.type = "button";
  btn.textContent = "提交订阅";
  form.appendChild(btn);
  text.appendChild(form);
  card.appendChild(text);
  content.appendChild(card);
  dialog.appendChild(content);
  window.document.body.appendChild(dialog);
  return { dialog, text, content };
}

for (const mobile of [false, true]) {
  const window = makeDom(mobile);
  const { text, content } = makeDialog(window);
  window.__mp_sc_test.tryInject(window.document.body);
  const panels = window.document.querySelectorAll("[data-mp-subscribe-configurator]");
  const panel = panels[0];

  assert.strictEqual(panels.length, 1, `exactly one panel (mobile=${mobile})`);
  assert.ok(panel, "panel injected");
  // The panel has to live in Vuetify's scroll container, not the overlay:
  // appending it to .v-overlay__content puts it outside the scroll area and
  // the mobile dialog can no longer reach it.
  assert.strictEqual(panel.parentElement, text, "panel is inside .v-card-text");
  assert.notStrictEqual(panel.parentElement, content, "panel is not a child of .v-overlay__content");
  assert.strictEqual(
    panel.getAttribute("data-mp-subscribe-configurator"),
    PANEL_VERSION,
    "panel version matches the script"
  );
  assert.ok(panel.querySelector(".mp-sc-toggle"), "collapse toggle exists");
  // Mobile starts collapsed so the panel cannot fill the whole dialog.
  assert.strictEqual(
    panel.classList.contains("mp-sc-panel--collapsed"),
    mobile,
    `collapsed=${mobile}`
  );

  console.log(JSON.stringify({
    mobile,
    panelCount: panels.length,
    parentClass: panel.parentElement.className,
    inCardText: panel.parentElement === text,
    directChildOfOverlayContent: panel.parentElement === content,
    collapsed: panel.classList.contains("mp-sc-panel--collapsed"),
    hasToggle: !!panel.querySelector(".mp-sc-toggle"),
    panelVersion: panel.getAttribute("data-mp-subscribe-configurator"),
  }));
} 

console.log("OK inject.test.cjs");
