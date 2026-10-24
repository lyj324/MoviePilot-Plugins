"""Regression tests for the two plugins, without a MoviePilot runtime.

Run: python -m unittest discover -s tests -v

Both plugins import ``app.*`` modules that only exist inside the MoviePilot
container, so this file installs minimal stubs first. That keeps the tests
runnable on a bare CPython install (CI included).
"""
from __future__ import annotations

import asyncio
import importlib.util
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

REPO = Path(__file__).resolve().parents[1]


# ── MoviePilot stubs ────────────────────────────────────────────────────
class _StubPluginBase:
    pass


class _StubTorrentInfo:
    def __init__(self, **kwargs):
        self.__dict__.update(kwargs)


class _StubMediaType:
    MOVIE = "movie"
    TV = "tv"


class _NullLogger:
    def __getattr__(self, _name):
        return lambda *args, **kwargs: None


class _FakeUtils:
    """Stand-in for app.adapters.network.http.AsyncRequestUtils."""

    post_calls = 0
    raise_on_post = None

    def __init__(self, *args, **kwargs):
        pass

    async def post(self, *args, **kwargs):
        type(self).post_calls += 1
        await asyncio.sleep(0.01)
        if type(self).raise_on_post is not None:
            raise type(self).raise_on_post
        response = types.SimpleNamespace()
        response.status_code = 302
        response.cookies = {"jackett": "session"}
        return response

    async def get_res(self, *args, **kwargs):
        return None


def _install_stubs() -> None:
    app = types.ModuleType("app")
    app.__path__ = []

    plugins = types.ModuleType("app.plugins")
    plugins._PluginBase = _StubPluginBase

    domain = types.ModuleType("app.domain")
    domain.__path__ = []
    context = types.ModuleType("app.domain.context")
    context.MediaType = _StubMediaType
    context.TorrentInfo = _StubTorrentInfo

    runtime = types.ModuleType("app.runtime")
    runtime.__path__ = []
    log = types.ModuleType("app.runtime.log")
    log.logger = _NullLogger()

    adapters = types.ModuleType("app.adapters")
    adapters.__path__ = []
    network = types.ModuleType("app.adapters.network")
    network.__path__ = []
    http = types.ModuleType("app.adapters.network.http")
    http.AsyncRequestUtils = _FakeUtils

    app.plugins = plugins
    app.domain = domain
    app.runtime = runtime
    app.adapters = adapters
    domain.context = context
    runtime.log = log
    adapters.network = network
    network.http = http

    for name, module in {
        "app": app,
        "app.plugins": plugins,
        "app.domain": domain,
        "app.domain.context": context,
        "app.runtime": runtime,
        "app.runtime.log": log,
        "app.adapters": adapters,
        "app.adapters.network": network,
        "app.adapters.network.http": http,
    }.items():
        sys.modules[name] = module

    # defusedxml is a real dependency in the container, but not necessarily on
    # a dev box. Fall back to the stdlib parser for parsing-shape tests.
    try:
        import defusedxml  # noqa: F401
    except ImportError:
        import xml.etree.ElementTree as stdlib_et

        defused = types.ModuleType("defusedxml")
        et = types.ModuleType("defusedxml.ElementTree")
        et.fromstring = stdlib_et.fromstring
        et.ParseError = stdlib_et.ParseError
        defused.ElementTree = et
        sys.modules["defusedxml"] = defused
        sys.modules["defusedxml.ElementTree"] = et


def _load(module_name: str, relative: str):
    spec = importlib.util.spec_from_file_location(module_name, REPO / relative)
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


_install_stubs()
jackett_mod = _load("jackett_plugin_under_test", "plugins.v3/jackett/__init__.py")
sc_mod = _load(
    "sc_plugin_under_test", "plugins.v3/subscribeconfigurator/__init__.py"
)

INDEX_HTML = (
    "<!doctype html>\n<html>\n<head>\n"
    '<script type="module" src="/assets/index-abc.js"></script>\n'
    "</head>\n<body><div id=\"app\"></div></body>\n</html>\n"
)


class SubscribeConfiguratorLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.index = self.root / "index.html"
        self.patch_js = self.root / "_subscribe_patch.js"
        self.plugin = sc_mod.SubscribeConfigurator()
        self.plugin.PUBLIC_INDEX = str(self.index)
        self.plugin.PUBLIC_PATCH_JS = str(self.patch_js)
        self.index.write_text(INDEX_HTML, encoding="utf-8")

    def tearDown(self):
        self.tmp.cleanup()

    def _enable(self):
        self.plugin.init_plugin({"enabled": True, "default_start_episode": 0})

    def _disable(self):
        self.plugin.init_plugin({"enabled": False})

    def test_plugin_is_admin_only(self):
        # The plugin rewrites the global /public/index.html.
        self.assertEqual(sc_mod.SubscribeConfigurator.auth_level, 2)

    def test_inject_then_disable_restores_original_bytes(self):
        self._enable()
        injected = self.index.read_text(encoding="utf-8")
        self.assertIn("mp-subscribeconfigurator-patch", injected)
        self.assertTrue(self.patch_js.exists())
        # 0.15.6 stopped writing a backup: restore strips the tag in place, so a
        # copy of index.html would only be a stale file nobody reads.
        self.assertFalse((self.root / "index.html.subscribeconfigurator.bak").exists())

        self._disable()
        self.assertEqual(self.index.read_text(encoding="utf-8"), INDEX_HTML)
        self.assertFalse(self.patch_js.exists())
        self.assertFalse((self.root / "index.html.subscribeconfigurator.bak").exists())

    def test_disable_after_frontend_upgrade_keeps_new_index(self):
        """A newer index.html must never be overwritten with an older snapshot.

        A MoviePilot image upgrade replaces /public/index.html with a new build;
        restoring a pre-injection snapshot would point the SPA at asset hashes
        that no longer exist.
        """
        self._enable()
        upgraded = INDEX_HTML.replace("index-abc.js", "index-upgraded.js")
        self.index.write_text(upgraded, encoding="utf-8")

        self._disable()

        self.assertEqual(self.index.read_text(encoding="utf-8"), upgraded)
        self.assertFalse(self.patch_js.exists())

    def test_disable_with_legacy_backup_cleans_it_up(self):
        # Installs upgraded from <=0.15.5 still have the stale backup file.
        self._enable()
        bak = self.root / "index.html.subscribeconfigurator.bak"
        bak.write_text(INDEX_HTML, encoding="utf-8")

        self._disable()

        content = self.index.read_text(encoding="utf-8")
        self.assertNotIn("_subscribe_patch.js", content)
        self.assertNotIn("mp-subscribeconfigurator-patch", content)
        self.assertFalse(self.patch_js.exists())
        self.assertFalse(bak.exists())

    def test_disable_removes_dead_script_tag(self):
        self._enable()

        self._disable()

        content = self.index.read_text(encoding="utf-8")
        self.assertNotIn("_subscribe_patch.js", content)
        self.assertNotIn("mp-subscribeconfigurator-patch", content)
        self.assertFalse(self.patch_js.exists())

    def test_disable_leaves_untouched_index_alone(self):
        # Stale .bak from an older install, current index.html has no marker.
        (self.root / "index.html.subscribeconfigurator.bak").write_text(
            "<html>old</html>", encoding="utf-8"
        )
        self._disable()

        self.assertEqual(self.index.read_text(encoding="utf-8"), INDEX_HTML)
        self.assertFalse((self.root / "index.html.subscribeconfigurator.bak").exists())

    def test_failed_write_keeps_patch_js(self):
        self._enable()
        with mock.patch.object(
            self.plugin, "_atomic_write", side_effect=OSError("disk full")
        ):
            self._disable()
        # Deleting the JS while the tag is still in index.html would 404.
        self.assertTrue(self.patch_js.exists())
        self.assertIn("_subscribe_patch.js", self.index.read_text(encoding="utf-8"))

    def test_reinject_after_disable_is_idempotent(self):
        self._enable()
        self._disable()
        self._enable()
        content = self.index.read_text(encoding="utf-8")
        self.assertEqual(content.count("_subscribe_patch.js"), 1)
        self.assertEqual(content.count("mp-subscribeconfigurator-patch"), 1)

    def test_bad_default_start_episode_does_not_crash_init(self):
        self.plugin.init_plugin(
            {"enabled": False, "default_start_episode": "not-a-number"}
        )
        self.assertEqual(self.plugin._default_start_episode, 0)

    def test_negative_default_start_episode_is_clamped(self):
        self.plugin.init_plugin({"enabled": False, "default_start_episode": -5})
        self.assertEqual(self.plugin._default_start_episode, 0)

    def test_fingerprint_tracks_patch_js_content(self):
        with mock.patch.object(
            sc_mod.SubscribeConfigurator, "_patch_js_digest",
            staticmethod(lambda: "aaaaaaaaaaaa"),
        ):
            first = self.plugin._config_fingerprint()
        with mock.patch.object(
            sc_mod.SubscribeConfigurator, "_patch_js_digest",
            staticmethod(lambda: "bbbbbbbbbbbb"),
        ):
            second = self.plugin._config_fingerprint()
        self.assertNotEqual(first, second)


class JackettParsingTests(unittest.TestCase):
    def setUp(self):
        self.plugin = jackett_mod.Jackett()
        self.plugin._host = "http://127.0.0.1:9117"
        self.plugin._api_key = "k"
        self.plugin._session_cookies = {}

    def test_safe_url_schemes(self):
        safe = jackett_mod._safe_url
        self.assertEqual(safe("https://x/a.torrent"), "https://x/a.torrent")
        self.assertEqual(safe("magnet:?xt=urn:btih:abc"), "magnet:?xt=urn:btih:abc")
        self.assertEqual(safe("javascript:alert(1)"), "")
        self.assertEqual(safe("file:///etc/passwd"), "")
        self.assertEqual(safe(""), "")

    def test_torznab_drops_non_http_links(self):
        xml = """<?xml version="1.0"?><rss xmlns:torznab="http://torznab.com/schemas/2015/feed">
        <channel>
          <item><title>evil</title><link>javascript:alert(1)</link></item>
          <item><title>ok</title><link>https://x/a.torrent</link>
            <torznab:attr name="seeders" value="3"/></item>
        </channel></rss>"""
        items = jackett_mod._parse_torznab(xml, "1337x")
        self.assertEqual([i.title for i in items], ["ok"])
        self.assertEqual(items[0].enclosure, "https://x/a.torrent")
        self.assertEqual(items[0].seeders, 3)

    def test_stable_site_id_range(self):
        first = jackett_mod._stable_site_id("1337x")
        self.assertEqual(first, jackett_mod._stable_site_id("1337x"))
        self.assertGreaterEqual(first, jackett_mod._SITE_ID_BASE)
        self.assertLess(
            first, jackett_mod._SITE_ID_BASE + jackett_mod._SITE_ID_RANGE
        )

    def test_cached_indexer_ids_ignores_malformed_entries(self):
        self.plugin._indexer_cache = [
            {"id": "1337x"},
            "not-a-dict",
            {"name": "missing-id"},
            {"id": 42},
        ]
        self.assertEqual(self.plugin._cached_indexer_ids(), ["1337x", "42"])

    def test_dedupe_keeps_highest_seeders(self):
        low = jackett_mod.TorrentInfo(
            title="a", enclosure="https://x/a", seeders=1
        )
        high = jackett_mod.TorrentInfo(
            title="a", enclosure="https://x/a", seeders=9
        )
        result = jackett_mod._dedupe_torrents([low, high])
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0].seeders, 9)

    def test_indexer_id_is_url_encoded(self):
        captured = {}

        async def fake_get(url):
            captured["url"] = url
            return ""

        self.plugin._http_get_text = fake_get
        asyncio.run(
            self.plugin._search_single_indexer("my indexer/1", "kw", None, 0)
        )
        self.assertIn("/indexers/my%20indexer%2F1/results/torznab/api", captured["url"])

    def test_login_failure_is_reported(self):
        _FakeUtils.post_calls = 0
        _FakeUtils.raise_on_post = RuntimeError("connect failed apikey=secret")
        try:
            ok = asyncio.run(self.plugin._ensure_authenticated())
        finally:
            _FakeUtils.raise_on_post = None
        self.assertFalse(ok)
        self.assertTrue(self.plugin._last_error.startswith("Jackett 登录失败"))

    def test_concurrent_first_requests_log_in_once(self):
        _FakeUtils.post_calls = 0

        async def fan_out():
            return await asyncio.gather(
                *[self.plugin._ensure_authenticated() for _ in range(4)]
            )

        self.assertEqual(asyncio.run(fan_out()), [True, True, True, True])
        self.assertEqual(_FakeUtils.post_calls, 1)

    def test_indexer_summary_text(self):
        self.plugin._indexers = []
        self.assertEqual(self.plugin._indexer_summary(), "全部（自动获取）")
        self.plugin._indexers = ["1337x", "rarbg"]
        self.assertEqual(self.plugin._indexer_summary(), "已指定 2 个（1337x, rarbg）")
        self.plugin._indexers = ["a", "b", "c", "d", "e", "f", "g"]
        summary = self.plugin._indexer_summary()
        self.assertIn("已指定 7 个", summary)
        self.assertIn("等 7 个", summary)
        self.assertNotIn("g", summary.split("（")[1])

    def test_no_redirect_wrapper_accepts_httpx_keyword(self):
        calls = {}

        class _HttpxStyle:
            async def get_res(self, url, follow_redirects=True, **kwargs):
                calls["kw"] = follow_redirects
                return "body"

        result = asyncio.run(
            jackett_mod._request_no_redirect(_HttpxStyle(), "get_res", "http://x")
        )
        self.assertEqual(result, "body")
        self.assertFalse(calls["kw"])

    def test_no_redirect_wrapper_falls_back_to_requests_keyword(self):
        calls = {}

        class _RequestsStyle:
            # Strict signature on purpose: an unknown keyword must raise, which
            # is exactly what a requests-style wrapper does.
            async def get_res(self, url, allow_redirects=True):
                calls["kw"] = allow_redirects
                return "body"

        result = asyncio.run(
            jackett_mod._request_no_redirect(_RequestsStyle(), "get_res", "http://x")
        )
        self.assertEqual(result, "body")
        self.assertFalse(calls["kw"])

    def test_no_redirect_wrapper_does_not_swallow_other_errors(self):
        class _Broken:
            async def get_res(self, url, follow_redirects=True):
                raise TypeError("unsupported operand type(s) for +: 'NoneType'")

        with self.assertRaises(TypeError):
            asyncio.run(
                jackett_mod._request_no_redirect(_Broken(), "get_res", "http://x")
            )

    def test_deadline_covers_every_indexer(self):
        import math

        concurrency = jackett_mod._SEARCH_CONCURRENCY
        for count in (1, 6, 27, 60):
            rounds = max(1, math.ceil(count / concurrency))
            deadline = min(
                jackett_mod._MAX_SEARCH_DEADLINE,
                max(jackett_mod._SEARCH_DEADLINE, rounds * jackett_mod._REQUEST_TIMEOUT),
            )
            # Enough budget for one full round of timeouts per indexer, unless
            # the documented hard cap kicks in.
            self.assertGreaterEqual(
                deadline,
                min(jackett_mod._MAX_SEARCH_DEADLINE, rounds * jackett_mod._REQUEST_TIMEOUT),
            )


if __name__ == "__main__":
    unittest.main()
