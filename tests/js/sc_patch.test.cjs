/* DOM-level tests for the SubscribeConfigurator frontend patch, using jsdom.
 *
 * Run: npm install && node tests/js/run.cjs
 *
 * The patch is injected with `window.eval` into a jsdom window, so it runs the
 * real browser code path (XHR/fetch hooks, MutationObserver, localStorage)
 * without a MoviePilot instance.
 */
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const { JSDOM } = require("jsdom");

const PLUGIN = path.join(
  __dirname,
  "../../plugins.v3/subscribeconfigurator/patch/_subscribe_patch.js"
);

let src = fs.readFileSync(PLUGIN, "utf8");
// Derive the expected panel marker from the script itself so a version bump
// does not require editing the tests.
const VERSION_MATCH = src.match(/PANEL_VERSION = "([^"]+)"/);
assert.ok(VERSION_MATCH, "PANEL_VERSION not found in patch JS");
const PANEL_VERSION = VERSION_MATCH[1];
const EXPORT_LINE =
  "  window.__mp_sc_test = { mergeOverrides: mergeOverrides, normalizeOverride: normalizeOverride, " +
  "readDefaultEpisode: readDefaultEpisode, isOneShot: isOneShot, commitValue: commitValue, " +
  "readOverrides: readOverrides, clearOverrides: clearOverrides, tryInject: tryInject };\n";
src = src.replace('  window.addEventListener("error"', () => EXPORT_LINE + '  window.addEventListener("error"');

const tick = () => new Promise((r) => setTimeout(r, 15));

function boot(fetchImpl, promptAnswers) {
  const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", {
    url: "http://localhost/",
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const calls = [];
  const prompts = [];
  const alerts = [];
  let answerIndex = 0;
  window.__MP_SC_CONFIG__ = { default_start_episode: 2, auto_apply_defaults: true };
  window.fetch = function (url, init) {
    calls.push({ url: String(url), init: init });
    return fetchImpl(String(url), init);
  };
  window.prompt = function (msg, def) {
    prompts.push({ msg: msg, def: def });
    if (promptAnswers && answerIndex < promptAnswers.length) return promptAnswers[answerIndex++];
    return "ManualDL";
  };
  window.alert = function (msg) { alerts.push(String(msg)); };
  window.eval(src);
  return { dom, window, calls, prompts, alerts, test: window.__mp_sc_test };
}

function makeDialog(window) {
  const dialog = window.document.createElement("div");
  dialog.className = "v-dialog";
  const target = window.document.createElement("div");
  target.className = "v-card-text";
  const input = window.document.createElement("input");
  input.className = "v-field__input";
  target.appendChild(input);
  const btn = window.document.createElement("button");
  btn.textContent = "提交订阅";
  target.appendChild(btn);
  dialog.appendChild(target);
  window.document.body.appendChild(dialog);
  return dialog;
}

function fieldByLabel(root, label) {
  const fields = root.querySelectorAll(".mp-sc-dd");
  for (const f of fields) {
    const lab = f.querySelector(".mp-sc-label");
    if (lab && lab.textContent === label) return f;
  }
  return null;
}

function click(window, node) {
  node.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
}

function menuRow(window, label) {
  const rows = window.document.querySelectorAll(".mp-sc-menu__item");
  for (const r of rows) {
    const t = r.querySelector(".mp-sc-menu__title");
    if (t && t.textContent === label) return r;
  }
  return null;
}

async function testPureHelpers() {
  const { window, test } = boot(okFetch);
  assert.strictEqual(test.isOneShot(), true, "one-shot defaults ON");
  window.localStorage.setItem("mp_subscribe_oneshot", "0");
  assert.strictEqual(test.isOneShot(), false);
  window.localStorage.removeItem("mp_subscribe_oneshot");

  assert.strictEqual(test.readDefaultEpisode(), 2, "server default used when auto_apply");
  window.localStorage.setItem("mp_subscribe_default_start_episode", "0");
  assert.strictEqual(test.readDefaultEpisode(), 0, "explicit 0 wins");
  window.localStorage.removeItem("mp_subscribe_default_start_episode");

  assert.deepEqual(test.normalizeOverride("sites", "7, 9，11"), [7, 9, 11]);
  assert.deepEqual(test.normalizeOverride("sites", ["7", 9, "x"]), [7, 9]);
  assert.deepEqual(test.normalizeOverride("sites", "A, B，C"), []);
  assert.deepEqual(test.normalizeOverride("sites", "  "), []);
  assert.strictEqual(test.normalizeOverride("downloader", ["X", "Y"]), "X");
  assert.strictEqual(test.normalizeOverride("downloader", "X"), "X");
  assert.strictEqual(test.normalizeOverride("start_episode", "abc"), "");
  assert.strictEqual(test.normalizeOverride("start_episode", "3"), 3);
  assert.strictEqual(test.normalizeOverride("best_version", "true"), true);
  assert.strictEqual(test.normalizeOverride("best_version", "0"), false);

  test.commitValue("sites", [7]);
  let payload = {};
  assert.strictEqual(test.mergeOverrides(payload), true);
  assert.deepEqual(payload.sites, [7]);
  assert.strictEqual(payload.start_episode, 2, "default filled");

  // Explicit 0 must beat the server default.
  test.commitValue("start_episode", 0);
  test.commitValue("sites", [7, 9]);
  payload = {};
  test.mergeOverrides(payload);
  assert.strictEqual(payload.start_episode, 0);
  assert.deepEqual(payload.sites, [7, 9]);

  // Whitelist: unknown keys are ignored.
  window.localStorage.setItem("mp_subscribe_overrides", JSON.stringify({ unknown_evil: "x", keyword: "k" }));
  payload = {};
  test.mergeOverrides(payload);
  assert.strictEqual(payload.unknown_evil, undefined);
  assert.strictEqual(payload.keyword, "k");

  // clearOverrides keeps the one-shot preference.
  window.localStorage.setItem("mp_subscribe_oneshot", "0");
  test.clearOverrides();
  assert.strictEqual(window.localStorage.getItem("mp_subscribe_oneshot"), "0");

  // auto_apply defaults false -> no server default.
  window.__MP_SC_CONFIG__ = { default_start_episode: 5, auto_apply_defaults: false };
  assert.strictEqual(test.readDefaultEpisode(), 0);
  console.log("OK testPureHelpers");
}

function okFetch(url) {
  if (url.indexOf("/download/clients") !== -1) {
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ data: [{ name: "qb" }, { name: "tr" }] }) });
  }
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ data: [
    { id: 7, name: "SiteA", is_active: true },
    { id: 9, name: "SiteB", is_active: true },
    { id: 11, name: "Inactive", is_active: false },
  ] }) });
}

async function testPanelInjectionAndMultiSelect() {
  const { window, test, calls } = boot(okFetch);
  const dialog = makeDialog(window);
  test.tryInject(dialog);
  let panels = dialog.querySelectorAll("[data-mp-subscribe-configurator]");
  assert.strictEqual(panels.length, 1, "panel injected");
  assert.strictEqual(panels[0].getAttribute("data-mp-subscribe-configurator"), PANEL_VERSION);
  assert.strictEqual(panels[0].parentElement.className, "v-card-text", "panel lives in the native scroll container");
  assert.ok(panels[0].textContent.indexOf("订阅增强") !== -1);

  // Re-scan must keep the live panel (v14 deleted it).
  const samePanel = panels[0];
  test.tryInject(dialog);
  panels = dialog.querySelectorAll("[data-mp-subscribe-configurator]");
  assert.strictEqual(panels.length, 1);
  assert.ok(panels[0].isSameNode(samePanel), "panel preserved on re-scan");

  // Old-version panel gets replaced.
  samePanel.setAttribute("data-mp-subscribe-configurator", "v15");
  test.tryInject(dialog);
  panels = dialog.querySelectorAll("[data-mp-subscribe-configurator]");
  assert.strictEqual(panels.length, 1);
  assert.strictEqual(panels[0].getAttribute("data-mp-subscribe-configurator"), PANEL_VERSION);
  assert.ok(!panels[0].isSameNode(samePanel), "old panel replaced");

  // start_episode prefilled from server config.
  const startInput = dialog.querySelector('input[data-mp-model="start_episode"]');
  assert.ok(startInput, "start_episode input present");
  assert.strictEqual(startInput.value, "2", "server default prefilled");

  await tick();
  const sitesField = fieldByLabel(dialog, "订阅站点");
  assert.ok(sitesField, "sites field present");
  const sitesAnchor = sitesField.querySelector(".mp-sc-dd__field");
  click(window, sitesAnchor);
  assert.ok(window.document.querySelector(".mp-sc-menu"), "sites menu open");
  assert.ok(calls.some((c) => c.url === "/api/v1/site/rss"), "sites use the native /site/rss endpoint");
  assert.ok(!menuRow(window, "Inactive"), "inactive sites filtered out");

  click(window, menuRow(window, "SiteA"));
  click(window, menuRow(window, "SiteB"));
  let ov = test.readOverrides();
  assert.deepEqual(ov.sites, [7, 9], "multi-select accumulates site IDs");
  assert.ok(menuRow(window, "SiteA").classList.contains("mp-sc-menu__item--sel"));
  assert.ok(menuRow(window, "SiteB").classList.contains("mp-sc-menu__item--sel"));

  // Deselect SiteA -> only SiteB remains.
  click(window, menuRow(window, "SiteA"));
  ov = test.readOverrides();
  assert.deepEqual(ov.sites, [9]);
  assert.strictEqual(sitesField.querySelector(".mp-sc-dd__value").textContent, "SiteB", "display uses site name");

  // Downloader is single-select.
  const dlField = fieldByLabel(dialog, "下载器");
  assert.ok(dlField, "downloader field present");
  click(window, dlField.querySelector(".mp-sc-dd__field"));
  click(window, menuRow(window, "qb"));
  ov = test.readOverrides();
  assert.strictEqual(ov.downloader, "qb", "downloader stored as string");
  assert.strictEqual(typeof ov.downloader, "string");
  assert.ok(!window.document.querySelector(".mp-sc-menu"), "single-select closes menu");

  // Selecting another client replaces it.
  click(window, dlField.querySelector(".mp-sc-dd__field"));
  click(window, menuRow(window, "tr"));
  ov = test.readOverrides();
  assert.strictEqual(ov.downloader, "tr");

  console.log("OK testPanelInjectionAndMultiSelect");
}

async function testFailedAsyncManualInput() {
  const failingFetch = function (url) {
    if (url.indexOf("/download/clients") !== -1) {
      return Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({}) });
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ data: [{ name: "SiteA" }] }) });
  };
  const { window, test, prompts } = boot(failingFetch);
  const dialog = makeDialog(window);
  test.tryInject(dialog);
  await tick();

  const dlField = fieldByLabel(dialog, "下载器");
  const valEl = dlField.querySelector(".mp-sc-dd__value");
  assert.strictEqual(valEl.textContent, "登录已过期，点此重试/手填", "401 hint shown");

  click(window, dlField.querySelector(".mp-sc-dd__field"));
  assert.ok(window.document.querySelector(".mp-sc-menu"), "recovery menu open");
  assert.ok(menuRow(window, "手动输入"), "manual input row present");
  click(window, menuRow(window, "手动输入"));
  assert.strictEqual(prompts.length, 1, "manual prompt opened");
  assert.ok(prompts[0].msg.indexOf("下载器") !== -1);
  assert.strictEqual(test.readOverrides().downloader, "ManualDL");
  console.log("OK testFailedAsyncManualInput");
}

async function testSiteFallbackEndpoint() {
  const fallbackFetch = function (url) {
    if (url.indexOf("/site/rss") !== -1) {
      return Promise.resolve({ ok: false, status: 403, json: () => Promise.resolve({}) });
    }
    if (url.indexOf("/download/clients") !== -1) {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ data: [{ name: "qb" }] }) });
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ data: [
      { id: 7, name: "SiteA", is_active: true },
    ] }) });
  };
  const { window, test, calls } = boot(fallbackFetch);
  const dialog = makeDialog(window);
  test.tryInject(dialog);
  await tick();

  const sitesField = fieldByLabel(dialog, "订阅站点");
  click(window, sitesField.querySelector(".mp-sc-dd__field"));
  assert.ok(menuRow(window, "SiteA"), "fallback endpoint supplies site options");
  const urls = calls.map((c) => c.url);
  assert.ok(urls.indexOf("/api/v1/site/rss") !== -1, "primary endpoint tried first");
  assert.ok(urls.indexOf("/api/v1/site/") !== -1, "fallback endpoint tried second");
  console.log("OK testSiteFallbackEndpoint");
}

async function testManualSiteNamesAndIds() {
  const { window, test, prompts, alerts } = boot(okFetch, ["SiteA, 9", "NoSuch"]);
  const dialog = makeDialog(window);
  test.tryInject(dialog);
  await tick();

  const sitesField = fieldByLabel(dialog, "订阅站点");
  click(window, sitesField.querySelector(".mp-sc-dd__field"));
  click(window, menuRow(window, "手动输入…"));
  assert.strictEqual(prompts.length, 1, "site manual prompt opened");
  assert.ok(prompts[0].msg.indexOf("名称或 ID") !== -1);
  assert.deepEqual(test.readOverrides().sites, [7, 9], "names resolved to IDs");

  // Unresolved names must be rejected instead of being sent as site names.
  test.commitValue("sites", [7]);
  click(window, sitesField.querySelector(".mp-sc-dd__field"));
  click(window, menuRow(window, "手动输入…"));
  assert.strictEqual(alerts.length, 1, "unresolved name alerts");
  assert.ok(alerts[0].indexOf("NoSuch") !== -1);
  assert.deepEqual(test.readOverrides().sites, [7], "existing selection kept");
  console.log("OK testManualSiteNamesAndIds");
}

async function testManualSiteUsesCachedListWhenApiFails() {
  const failingFetch = function () {
    return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) });
  };
  const { window, test, prompts } = boot(failingFetch, ["SiteA"]);
  window.localStorage.setItem("mp_sc_site_items", JSON.stringify([{ value: 7, label: "SiteA" }]));
  const dialog = makeDialog(window);
  test.tryInject(dialog);
  await tick();

  const sitesField = fieldByLabel(dialog, "订阅站点");
  assert.ok(sitesField.querySelector(".mp-sc-dd__value--error"), "failure text is marked as an error");
  click(window, sitesField.querySelector(".mp-sc-dd__field"));
  assert.ok(menuRow(window, "手动输入（名称或 ID）"), "failure menu offers manual input");
  click(window, menuRow(window, "手动输入（名称或 ID）"));
  assert.strictEqual(prompts.length, 1);
  assert.deepEqual(test.readOverrides().sites, [7], "cached name resolved to ID");
  console.log("OK testManualSiteUsesCachedListWhenApiFails");
}

async function testNativeStyleScaffolding() {
  const { window, test } = boot(okFetch);
  const dialog = makeDialog(window);
  dialog.classList.add("v-theme--glass");
  test.tryInject(dialog);
  await tick();

  assert.ok(window.document.getElementById("mp-sc-styles"), "inline styles injected");
  window.document.getElementById("mp-sc-styles").remove();
  test.tryInject(dialog);
  assert.ok(window.document.getElementById("mp-sc-styles"), "inline styles self-heal after removal");
  assert.ok(dialog.querySelector(".mp-sc-switch-input"), "boolean fields use switch inputs");
  assert.ok(dialog.querySelector(".mp-sc-sw__track"), "switch track rendered");
  assert.ok(dialog.querySelector(".mp-sc-sw__thumb"), "switch thumb rendered");

  const sitesField = fieldByLabel(dialog, "订阅站点");
  const sitesAnchor = sitesField.querySelector(".mp-sc-dd__field");
  click(window, sitesAnchor);
  const menu = window.document.querySelector(".mp-sc-menu");
  assert.ok(menu, "menu open");
  assert.ok(menu.classList.contains("v-theme--glass"), "teleported menu inherits the Vuetify theme class");
  click(window, menuRow(window, "SiteA"));
  assert.ok(sitesAnchor.classList.contains("mp-sc-dd--filled"), "filled dropdown floats its label");
  console.log("OK testNativeStyleScaffolding");
}

async function testTransportMergeAndOneShot() {
  const { window, test, calls } = boot(okFetch);
  test.commitValue("keyword", "mykey");
  test.commitValue("sites", [7]);
  window.localStorage.setItem("mp_subscribe_oneshot", "1");

  await window.fetch("/api/v1/subscribe", { method: "POST", body: JSON.stringify({ title: "t" }) });
  const subCalls = calls.filter((c) => c.url.indexOf("/subscribe") !== -1);
  assert.strictEqual(subCalls.length, 1);
  const sent = JSON.parse(subCalls[0].init.body);
  assert.strictEqual(sent.keyword, "mykey");
  assert.deepEqual(sent.sites, [7]);
  await tick();
  assert.deepEqual(test.readOverrides(), {}, "one-shot cleared after success");

  // one-shot off keeps preference overrides (per-title values are session-only).
  window.localStorage.setItem("mp_subscribe_oneshot", "0");
  test.commitValue("keyword", "keepme");
  test.commitValue("quality", "4k");
  await window.fetch("/api/v1/subscribe", { method: "POST", body: JSON.stringify({ title: "t2" }) });
  await tick();
  assert.strictEqual(test.readOverrides().quality, "4k", "preferences kept");
  assert.strictEqual(
    test.readOverrides().keyword, undefined, "per-title values are session-only"
  );
  console.log("OK testTransportMergeAndOneShot");
}

async function testEndpointScopeAndPerTitleFields() {
  const { window, test, calls } = boot(okFetch);

  // Any endpoint that merely contains "/subscribe" must be left untouched.
  test.commitValue("keyword", "panel-keyword");
  test.commitValue("filter", "1080p");
  await window.fetch("/api/v1/subscribe/search", {
    method: "POST",
    body: JSON.stringify({ keyword: "native" }),
  });
  const searchCall = calls.filter((c) => c.url.indexOf("/subscribe/search") !== -1)[0];
  assert.deepEqual(
    JSON.parse(searchCall.init.body),
    { keyword: "native" },
    "non-add subscribe endpoint must not be rewritten"
  );

  // Add endpoint: a per-title value typed into the native form wins over a
  // leftover template, while persistent preferences are still merged.
  await window.fetch("/api/v1/subscribe/", {
    method: "POST",
    body: JSON.stringify({ keyword: "typed-title", total_episode: 12 }),
  });
  const addCall = calls.filter((c) => c.url === "/api/v1/subscribe/")[0];
  const sent = JSON.parse(addCall.init.body);
  assert.strictEqual(sent.keyword, "typed-title", "native keyword wins");
  assert.strictEqual(sent.total_episode, 12, "native total_episode wins");
  assert.strictEqual(sent.filter, "1080p", "panel-only field still merged");

  // A per-title field the native form left empty is still filled by the panel.
  test.commitValue("season", 2);
  await window.fetch("/api/v1/subscribe/", {
    method: "POST",
    body: JSON.stringify({ keyword: "typed2" }),
  });
  const sent2 = JSON.parse(calls[calls.length - 1].init.body);
  assert.strictEqual(sent2.season, 2, "empty native season filled from panel");
  assert.strictEqual(sent2.keyword, "typed2");
  console.log("OK testEndpointScopeAndPerTitleFields");
}

async function testDialogDetection() {
  const { window } = boot(okFetch);
  const doc = window.document;
  const testApi = window.__mp_sc_test;

  // 1) Title-based detection: English UI with a non-matching button label.
  const d1 = doc.createElement("div");
  d1.className = "v-dialog";
  const t1 = doc.createElement("div");
  t1.className = "v-card-title";
  t1.textContent = "Add Subscription";
  d1.appendChild(t1);
  const c1 = doc.createElement("div");
  c1.className = "v-card-text";
  c1.appendChild(doc.createElement("input"));
  const ok1 = doc.createElement("button");
  ok1.textContent = "OK";
  c1.appendChild(ok1);
  d1.appendChild(c1);
  doc.body.appendChild(d1);
  testApi.tryInject(doc.body);
  assert.ok(d1.querySelector("[data-mp-subscribe-configurator]"), "title-based detection injects");

  // 2) Edit dialog must stay untouched.
  const d2 = doc.createElement("div");
  d2.className = "v-dialog";
  const t2 = doc.createElement("div");
  t2.className = "v-card-title";
  t2.textContent = "编辑订阅";
  d2.appendChild(t2);
  const c2 = doc.createElement("div");
  c2.className = "v-card-text";
  c2.appendChild(doc.createElement("input"));
  const save = doc.createElement("button");
  save.textContent = "保存";
  c2.appendChild(save);
  d2.appendChild(c2);
  doc.body.appendChild(d2);
  testApi.tryInject(doc.body);
  assert.strictEqual(
    d2.querySelector("[data-mp-subscribe-configurator]"), null, "edit dialog excluded"
  );

  // 3) Half-rendered card (no form yet) is skipped, then injected on retry.
  const d3 = doc.createElement("div");
  d3.className = "v-dialog";
  const t3 = doc.createElement("div");
  t3.className = "v-card-title";
  t3.textContent = "新增订阅";
  d3.appendChild(t3);
  const c3 = doc.createElement("div");
  c3.className = "v-card-text";
  const submit3 = doc.createElement("button");
  submit3.textContent = "提交订阅";
  c3.appendChild(submit3);
  d3.appendChild(c3);
  doc.body.appendChild(d3);
  testApi.tryInject(doc.body);
  assert.strictEqual(
    d3.querySelector("[data-mp-subscribe-configurator]"), null, "half-rendered card skipped"
  );
  c3.insertBefore(doc.createElement("input"), submit3);
  testApi.tryInject(doc.body);
  assert.ok(d3.querySelector("[data-mp-subscribe-configurator]"), "retried after form renders");

  // 4) Multiple .v-card-text: use the one that holds the form.
  const d4 = doc.createElement("div");
  d4.className = "v-dialog";
  const t4 = doc.createElement("div");
  t4.className = "v-card-title";
  t4.textContent = "添加订阅";
  d4.appendChild(t4);
  const intro = doc.createElement("div");
  intro.className = "v-card-text";
  intro.textContent = "说明文字";
  d4.appendChild(intro);
  const formWrap = doc.createElement("div");
  formWrap.className = "v-card-text";
  formWrap.appendChild(doc.createElement("input"));
  const submit4 = doc.createElement("button");
  submit4.textContent = "提交订阅";
  formWrap.appendChild(submit4);
  d4.appendChild(formWrap);
  doc.body.appendChild(d4);
  testApi.tryInject(doc.body);
  const panel4 = d4.querySelector("[data-mp-subscribe-configurator]");
  assert.ok(
    panel4 && panel4.parentElement === formWrap,
    "injected into the card-text that holds the form"
  );
  console.log("OK testDialogDetection");
}

async function testPerTitleValuesAreSessionOnly() {
  const { window, test, calls } = boot(okFetch);
  // Keep the preference template so only the per-title behaviour is tested.
  window.localStorage.setItem("mp_subscribe_oneshot", "0");

  test.commitValue("keyword", "per-title");
  test.commitValue("season", 3);
  test.commitValue("quality", "4k");
  assert.strictEqual(test.readOverrides().keyword, undefined, "keyword not persisted");
  assert.strictEqual(test.readOverrides().season, undefined, "season not persisted");
  assert.strictEqual(test.readOverrides().quality, "4k", "preference persisted");

  await window.fetch("/api/v1/subscribe/", {
    method: "POST",
    body: JSON.stringify({}),
  });
  const sent = JSON.parse(calls[calls.length - 1].init.body);
  assert.strictEqual(sent.keyword, "per-title", "session value still merged");
  assert.strictEqual(sent.season, 3);

  // After a successful add, per-title values must not leak into the next one.
  await window.fetch("/api/v1/subscribe/", {
    method: "POST",
    body: JSON.stringify({}),
  });
  const sent2 = JSON.parse(calls[calls.length - 1].init.body);
  assert.strictEqual(sent2.keyword, undefined, "keyword cleared after submit");
  assert.strictEqual(sent2.season, undefined, "season cleared after submit");
  assert.strictEqual(sent2.quality, "4k", "preferences survive");
  console.log("OK testPerTitleValuesAreSessionOnly");
}

(async function main() {
  await testPureHelpers();
  await testPanelInjectionAndMultiSelect();
  await testSiteFallbackEndpoint();
  await testManualSiteNamesAndIds();
  await testManualSiteUsesCachedListWhenApiFails();
  await testFailedAsyncManualInput();
  await testNativeStyleScaffolding();
  await testTransportMergeAndOneShot();
  await testEndpointScopeAndPerTitleFields();
  await testDialogDetection();
  await testPerTitleValuesAreSessionOnly();
  console.log("ALL SC PATCH TESTS PASSED");
})().catch((err) => {
  console.error("FAILED:", err && err.stack ? err.stack : err);
  process.exit(1);
});

