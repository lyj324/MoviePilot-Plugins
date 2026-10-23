"""订阅增强 — 在订阅添加对话框注入 start_episode / filter / quality 等字段。

实现思路（best-effort，非官方 API）：
1. ``init_plugin`` 启动时检查容器内 ``/public/index.html``：
   - 没有 marker 就把 plugin 包内 ``patch/_subscribe_patch.js`` 写入 ``/public/_subscribe_patch.js``
   - 在 ``</head>`` 前注入 ``<script defer src="/_subscribe_patch.js"></script>`` 和 marker 注释
   - 备份原 index.html 到 ``/public/index.html.subscribeconfigurator.bak``
2. ``_subscribe_patch.js`` 在浏览器侧做两件事：
   - 拦截 ``fetch POST /api/v1/subscribe``，把 localStorage 里的字段合并到 body
   - MutationObserver 监听 dialog 出现，在表单底部注入额外输入框
3. ``stop_service`` / 关闭插件时只移除注入的 ``<script>`` 与 marker，再删除
   patch.js（不再整文件回写 .bak，避免把 MoviePilot 升级后的前端写回旧版本）
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import re
from typing import Any, Dict, List, Optional, Tuple

from app.plugins import _PluginBase

logger = logging.getLogger(__name__)


class SubscribeConfigurator(_PluginBase):
    """订阅增强插件入口。"""

    # ── 元数据 ──
    plugin_name = "订阅增强"
    plugin_desc = "在订阅添加对话框注入 start_episode / filter / quality 等字段，添加订阅时即可一次性配置。"
    plugin_version = "0.15.4"
    plugin_author = "lyj324"
    author_url = "https://github.com/lyj324/MoviePilot-Plugins"
    plugin_config_prefix = "subscribeconfigurator_"
    plugin_order = 50  # 后于 Jackett(21)
    # This plugin rewrites the *global* /public/index.html, i.e. it changes the
    # frontend for every logged-in user. It must therefore stay admin-only;
    # auth_level=1 would let ordinary users trigger those file writes.
    auth_level = 2

    # ── 常量 ──
    # Marker prefix. The version/config suffix lives inside the same HTML
    # comment (`<!-- ... v3 (sc=v0.15.0; cfg=...) -->`) so the cleanup regex
    # can remove the whole line; 0.14.0 left the suffix outside the comment.
    PATCH_MARKER = "<!-- mp-subscribeconfigurator-patch v3"
    PATCH_SCRIPT_FILENAME = "_subscribe_patch.js"
    BACKUP_SUFFIX = ".subscribeconfigurator.bak"
    # Regex captures `sc=vX.Y.Z` so we can parse current version from index.html
    _SC_VERSION_RE = re.compile(r"sc=v([\d.]+)")
    # Config fingerprint embedded in the script URL + marker, so changing the
    # plugin form (default episode / auto apply) forces a rewrite of patch.js.
    _CFG_RE = re.compile(r"cfg=([0-9a-f]{8,64})")
    # Removes our injected <script> tag + marker comment (any version/config
    # suffix). Shared by re-injection and restore, so a restore can never leave
    # a dead script tag behind and never has to rewrite the whole file.
    # The pair is matched together (including the newline between them) so a
    # restore returns the exact original bytes instead of leaving a blank line.
    _PATCH_BLOCK_RE = re.compile(
        r'[ \t]*<script defer src="/_subscribe_patch\.js(?:\?[^"]*)?"\s*></script>[ \t]*\r?\n?'
        r'(?:<!--\s*mp-subscribeconfigurator-patch[^>]*-->'
        r'(?:\s*\(sc=v[\d.]+(?:;\s*cfg=[0-9a-f]+)?\))?[ \t]*\r?\n?)?'
        r'|'
        r'[ \t]*<!--\s*mp-subscribeconfigurator-patch[^>]*-->'
        r'(?:\s*\(sc=v[\d.]+(?:;\s*cfg=[0-9a-f]+)?\))?[ \t]*\r?\n?',
        re.MULTILINE,
    )

    # 容器内路径（默认 MP v3 frontend baked 在 /public）
    PUBLIC_DIR = "/public"
    PUBLIC_INDEX = "/public/index.html"
    PUBLIC_PATCH_JS = "/public/_subscribe_patch.js"

    # ── 运行时状态 ──
    _enabled: bool = False
    _default_start_episode: int = 0
    _auto_apply_defaults: bool = False

    # ── 生命周期 ──
    def init_plugin(self, config: Optional[Dict[str, Any]] = None) -> None:
        config = config or {}
        self._enabled = bool(config.get("enabled", True))
        # A non-numeric value must not abort init_plugin: that would take the
        # whole plugin down (and skip the restore branch below).
        try:
            self._default_start_episode = int(config.get("default_start_episode") or 0)
        except (TypeError, ValueError):
            logger.warning(
                "SubscribeConfigurator: default_start_episode 非法（%r），按 0 处理",
                config.get("default_start_episode"),
            )
            self._default_start_episode = 0
        if self._default_start_episode < 0:
            self._default_start_episode = 0
        self._auto_apply_defaults = bool(config.get("auto_apply_defaults", False))

        if not self._enabled:
            logger.info("SubscribeConfigurator: 用户在配置里关闭，还原前端 patch")
            self._restore()
            return

        # 防御性探测
        if not os.path.isfile(self.PUBLIC_INDEX):
            logger.warning(
                "SubscribeConfigurator: %s 不存在；可能容器用 host 挂载覆盖了 /public，"
                "无法在容器侧 patch 前端。请改用浏览器用户脚本方案。",
                self.PUBLIC_INDEX,
            )
            return
        if not os.access(self.PUBLIC_INDEX, os.W_OK):
            logger.warning(
                "SubscribeConfigurator: %s 不可写，跳过 patch（容器安全策略？）",
                self.PUBLIC_INDEX,
            )
            return

        try:
            with open(self.PUBLIC_INDEX, "r", encoding="utf-8") as f:
                content = f.read()
        except Exception as err:
            logger.warning(f"SubscribeConfigurator: 读 index.html 失败：{err}")
            return

        # Version + config fingerprint + file/marker presence all have to
        # match; otherwise a config change or a lost patch.js would be ignored
        # because index.html still carried the old sc=vX.Y.Z marker.
        cfg_fp = self._config_fingerprint()
        m = self._SC_VERSION_RE.search(content)
        current_sc_version = m.group(1) if m else None
        cfg_m = self._CFG_RE.search(content)
        current_cfg = cfg_m.group(1) if cfg_m else None
        patch_exists = os.path.exists(self.PUBLIC_PATCH_JS)
        marker_present = self.PATCH_MARKER in content

        if (
            current_sc_version == self.plugin_version
            and current_cfg == cfg_fp
            and patch_exists
            and marker_present
        ):
            logger.info(
                "SubscribeConfigurator: index.html 已是当前版本/配置 "
                "(sc=v%s, cfg=%s)，跳过",
                self.plugin_version,
                cfg_fp,
            )
            return

        if current_sc_version or current_cfg:
            logger.info(
                "SubscribeConfigurator: 旧版本/旧配置 "
                "(sc=v%s, cfg=%s) -> 当前 (v%s, cfg=%s)，重新 patch",
                current_sc_version,
                current_cfg,
                self.plugin_version,
                cfg_fp,
            )
        else:
            logger.info("SubscribeConfigurator: 首次注入前端 patch")

        # Strip any older subscribeconfigurator marker/script (any version) so
        # we don't accumulate stale blocks if a previous plugin version was
        # partially cleaned up.
        content = self._PATCH_BLOCK_RE.sub("", content)

        try:
            self._write_patch_js()
            self._backup_and_inject(content, cfg_fp)
            logger.info(
                "SubscribeConfigurator: patch 注入完成（%s + %s）。"
                "前端添加订阅对话框将出现「订阅增强」面板。",
                self.PUBLIC_PATCH_JS,
                self.PUBLIC_INDEX,
            )
        except Exception as err:
            logger.error(f"SubscribeConfigurator: patch 失败：{err}")

    def stop_service(self) -> None:
        """plugin 卸载 / 容器关闭时尽量还原。

        注意：MP v3 容器被 SIGTERM 时 supervisord 不一定回调 stop_service，
        所以 init_plugin 的版本/配置指纹检测是真正的"自愈"机制。
        """
        self._restore()

    def _restore(self) -> None:
        """Remove the injected tag/marker in place, then delete the patch JS.

        Deliberately does **not** write the backup back over index.html: the
        ``.bak`` is a snapshot from before an injection, while a MoviePilot
        image upgrade replaces ``/public/index.html`` with a new frontend
        build. Restoring that snapshot after an upgrade would pin the app to
        asset hashes that no longer exist (white screen) and delete the only
        copy of the current index.html.

        If index.html cannot be read, the JS is kept on purpose: deleting it
        while the ``<script>`` tag is still there would make every page load
        hit a 404.
        """
        bak = self.PUBLIC_INDEX + self.BACKUP_SUFFIX
        try:
            content = None
            if os.path.isfile(self.PUBLIC_INDEX):
                with open(self.PUBLIC_INDEX, "r", encoding="utf-8") as f:
                    content = f.read()
        except OSError as err:
            logger.warning(
                "SubscribeConfigurator: 读取 %s 失败，保留 patch.js 以免页面 404：%s",
                self.PUBLIC_INDEX,
                err,
            )
            return

        if content is not None:
            cleaned = self._PATCH_BLOCK_RE.sub("", content)
            if cleaned != content:
                try:
                    self._atomic_write(self.PUBLIC_INDEX, cleaned)
                    logger.info(
                        "SubscribeConfigurator: 已移除 %s 中的注入标签",
                        self.PUBLIC_INDEX,
                    )
                except Exception as err:
                    logger.warning(
                        "SubscribeConfigurator: 清理 %s 失败，保留 patch.js：%s",
                        self.PUBLIC_INDEX,
                        err,
                    )
                    return

        try:
            if os.path.exists(self.PUBLIC_PATCH_JS):
                os.remove(self.PUBLIC_PATCH_JS)
                logger.info("SubscribeConfigurator: 已删除 %s", self.PUBLIC_PATCH_JS)
            if os.path.exists(bak):
                os.remove(bak)
                logger.info("SubscribeConfigurator: 已删除备份 %s", bak)
        except OSError as err:
            logger.warning("SubscribeConfigurator: 清理 patch 文件失败：%s", err)

    @staticmethod
    def _patch_js_digest() -> str:
        """SHA-256 of the bundled patch JS.

        Including it in the fingerprint means a JS-only change (same plugin
        version) still forces a rewrite; without it, init_plugin would see the
        old ``sc=`` marker, decide "already up to date" and silently keep
        serving the previous script.
        """
        here = os.path.dirname(os.path.abspath(__file__))
        path = os.path.join(here, "patch", "_subscribe_patch.js")
        try:
            with open(path, "rb") as f:
                return hashlib.sha256(f.read()).hexdigest()[:12]
        except OSError:
            return "missing"

    def _config_fingerprint(self) -> str:
        payload = {
            "default_start_episode": self._default_start_episode,
            "auto_apply_defaults": self._auto_apply_defaults,
            "patch_js": self._patch_js_digest(),
        }
        raw = json.dumps(
            payload, sort_keys=True, ensure_ascii=False, separators=(",", ":")
        )
        return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:12]

    @staticmethod
    def _atomic_write(path: str, content: str) -> None:
        """Write via a temp file + os.replace so a crash cannot truncate the file."""
        tmp = f"{path}.tmp-{os.getpid()}"
        try:
            with open(tmp, "w", encoding="utf-8") as f:
                f.write(content)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, path)
        finally:
            if os.path.exists(tmp):
                try:
                    os.remove(tmp)
                except OSError:
                    pass

    # ── MP plugin 接口 ──
    def get_state(self) -> bool:
        return bool(getattr(self, "_enabled", False))

    @staticmethod
    def get_command() -> List[Dict[str, Any]]:
        return []

    def get_api(self) -> List[Dict[str, Any]]:
        return []

    def get_form(self) -> Tuple[List[dict], Dict[str, Any]]:
        return (
            [
                {
                    "component": "VForm",
                    "content": [
                        {
                            "component": "VSwitch",
                            "props": {"model": "enabled", "label": "启用前端劫持"},
                        },
                        {
                            "component": "VTextField",
                            "props": {
                                "model": "default_start_episode",
                                "label": "默认开始集数（每次添加订阅自动套用）",
                                "type": "number",
                                "placeholder": "0 或留空 = 不强制套用",
                            },
                        },
                        {
                            "component": "VSwitch",
                            "props": {
                                "model": "auto_apply_defaults",
                                "label": "下次添加订阅自动套用默认配置",
                            },
                        },
                        {
                            "component": "VAlert",
                            "props": {
                                "type": "info",
                                "variant": "tonal",
                                "text": (
                                    "启用后会在容器 /public/index.html 注入 <script> 引用 _subscribe_patch.js，"
                                    "plugin 启动自动幂等 patch；卸载本插件或 stop_service 会自动还原。"
                                    "前端会在订阅添加对话框底部出现「订阅增强」面板，"
                                    "可填开始集数 / 过滤规则 / 包含 / 排除 / 质量 / 分辨率 / 效果。"
                                ),
                            },
                        },
                    ],
                }
            ],
            {
                "enabled": True,
                "default_start_episode": 1,
                "auto_apply_defaults": False,
            },
        )

    def get_page(self) -> List[dict]:
        state = bool(getattr(self, "_enabled", False))
        bak_exists = os.path.exists(self.PUBLIC_INDEX + self.BACKUP_SUFFIX)
        patch_exists = os.path.exists(self.PUBLIC_PATCH_JS)
        index_has_marker = False
        try:
            with open(self.PUBLIC_INDEX, "r", encoding="utf-8") as f:
                index_has_marker = self.PATCH_MARKER in f.read()
        except Exception:
            pass
        return [
            {
                "component": "VAlert",
                "props": {
                    "type": "info" if (bak_exists or index_has_marker) else "warning",
                    "variant": "tonal",
                    "text": (
                        f"插件状态：{'已启用' if state else '未启用'}\n"
                        f"index.html marker：{'已注入' if index_has_marker else '未注入'}\n"
                        f"patch 脚本：{'存在' if patch_exists else '缺失'}\n"
                        f"备份文件：{'存在' if bak_exists else '缺失'}\n"
                        f"默认开始集数：{getattr(self, '_default_start_episode', 0)}\n"
                        f"自动套用默认值：{'是' if getattr(self, '_auto_apply_defaults', False) else '否'}\n\n"
                        "关闭或卸载插件会从 index.html 中移除注入的 <script> 与 marker，"
                        "并删除 patch 脚本，不需要手动还原。\n"
                        f"备份文件（{self.BACKUP_SUFFIX}）只在注入时生成，供对照用，"
                        "不会再被自动回写——避免把 MoviePilot 升级后的前端覆盖成旧版本。"
                    ),
                },
            }
        ]

    # ── 内部 ──
    def _write_patch_js(self) -> None:
        """Copy patch/_subscribe_patch.js to /public and prepend server config.

        The JS reads ``window.__MP_SC_CONFIG__`` so default episode / auto-apply
        are actually honored. The config fingerprint is part of the script URL,
        so changing it in the plugin form busts the browser cache too.
        """
        here = os.path.dirname(os.path.abspath(__file__))
        patch_path = os.path.join(here, "patch", "_subscribe_patch.js")
        with open(patch_path, "r", encoding="utf-8") as f:
            content = f.read()

        cfg = {
            "default_start_episode": self._default_start_episode,
            "auto_apply_defaults": self._auto_apply_defaults,
        }
        prefix = (
            "window.__MP_SC_CONFIG__ = "
            + json.dumps(cfg, ensure_ascii=False, separators=(",", ":"))
            + ";\n"
        )
        self._atomic_write(self.PUBLIC_PATCH_JS, prefix + content)

    def _backup_and_inject(self, content: str, cfg_fp: str) -> None:
        bak = self.PUBLIC_INDEX + self.BACKUP_SUFFIX
        self._atomic_write(bak, content)

        # cache-bust ts + plugin version + config fingerprint in script src so
        # the browser always refetches after a plugin upgrade or config change.
        # init_plugin reads both back from index.html to decide whether to skip.
        import time as _time

        cache_bust = int(_time.time())
        # Strip any inline comment characters from plugin_version to keep
        # the HTML comment safe (plugin_version is "0.9.1" style, but defensive)
        safe_ver = re.sub(r"[^0-9A-Za-z._-]", "", self.plugin_version) or "0"
        safe_cfg = re.sub(r"[^0-9a-f]", "", cfg_fp)[:32] or "0"
        script_tag = (
            f'<script defer src="/{self.PATCH_SCRIPT_FILENAME}'
            f'?v={cache_bust}&sc={safe_ver}&cfg={safe_cfg}"></script>\n'
            f"{self.PATCH_MARKER} (sc=v{safe_ver}; cfg={safe_cfg}) -->"
        )
        if "</head>" in content:
            new_content = content.replace("</head>", f"{script_tag}\n</head>", 1)
        else:
            # 极端：没有 </head>，追加到末尾
            new_content = content + f"\n{script_tag}\n"

        self._atomic_write(self.PUBLIC_INDEX, new_content)