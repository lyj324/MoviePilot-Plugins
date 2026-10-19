"""订阅增强 — 在订阅添加对话框注入 start_episode / filter / quality 等字段。

实现思路（best-effort，非官方 API）：
1. ``init_plugin`` 启动时检查容器内 ``/public/index.html``：
   - 没有 marker 就把 plugin 包内 ``patch/_subscribe_patch.js`` 写入 ``/public/_subscribe_patch.js``
   - 在 ``</head>`` 前注入 ``<script defer src="/_subscribe_patch.js"></script>`` 和 marker 注释
   - 备份原 index.html 到 ``/public/index.html.subscribeconfigurator.bak``
2. ``_subscribe_patch.js`` 在浏览器侧做两件事：
   - 拦截 ``fetch POST /api/v1/subscribe``，把 localStorage 里的字段合并到 body
   - MutationObserver 监听 dialog 出现，在表单底部注入额外输入框
3. ``stop_service`` 时从 .bak 还原 index.html 并删除 patch.js
"""
from __future__ import annotations

import logging
import os
from typing import Any, Dict, List, Optional, Tuple

from app.plugins import _PluginBase

logger = logging.getLogger(__name__)


class SubscribeConfigurator(_PluginBase):
    """订阅增强插件入口。"""

    # ── 元数据 ──
    plugin_name = "订阅增强"
    plugin_desc = "在订阅添加对话框注入 start_episode / filter / quality 等字段，添加订阅时即可一次性配置。"
    plugin_version = "0.3.0"
    plugin_author = "lyj324"
    author_url = "https://github.com/lyj324/MoviePilot-Plugins"
    plugin_config_prefix = "subscribeconfigurator_"
    plugin_order = 50  # 后于 Jackett(21)
    auth_level = 1

    # ── 常量 ──
    PATCH_MARKER = "<!-- mp-subscribeconfigurator-patch v3 -->"
    PATCH_SCRIPT_FILENAME = "_subscribe_patch.js"
    BACKUP_SUFFIX = ".subscribeconfigurator.bak"

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
        self._default_start_episode = int(config.get("default_start_episode") or 0)
        self._auto_apply_defaults = bool(config.get("auto_apply_defaults", False))

        if not self._enabled:
            logger.info("SubscribeConfigurator: 用户在配置里关闭，跳过 patch")
            return

        # 防御性探测
        if not os.path.isfile(self.PUBLIC_INDEX):
            logger.warn(
                "SubscribeConfigurator: %s 不存在；可能容器用 host 挂载覆盖了 /public，"
                "无法在容器侧 patch 前端。请改用浏览器用户脚本方案。",
                self.PUBLIC_INDEX,
            )
            return
        if not os.access(self.PUBLIC_INDEX, os.W_OK):
            logger.warn(
                "SubscribeConfigurator: %s 不可写，跳过 patch（容器安全策略？）",
                self.PUBLIC_INDEX,
            )
            return

        try:
            with open(self.PUBLIC_INDEX, "r", encoding="utf-8") as f:
                content = f.read()
        except Exception as err:
            logger.warn(f"SubscribeConfigurator: 读 index.html 失败：{err}")
            return

        if self.PATCH_MARKER in content:
            logger.info("SubscribeConfigurator: 已 patch（marker 存在），跳过")
            return

        try:
            self._write_patch_js()
            self._backup_and_inject(content)
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
        所以 init_plugin 的幂等检测是真正的"自愈"机制。
        """
        try:
            bak = self.PUBLIC_INDEX + self.BACKUP_SUFFIX
            if os.path.exists(bak):
                with open(bak, "r", encoding="utf-8") as f:
                    original = f.read()
                with open(self.PUBLIC_INDEX, "w", encoding="utf-8") as f:
                    f.write(original)
                os.remove(bak)
                logger.info("SubscribeConfigurator: 已还原 %s", self.PUBLIC_INDEX)
            if os.path.exists(self.PUBLIC_PATCH_JS):
                os.remove(self.PUBLIC_PATCH_JS)
                logger.info("SubscribeConfigurator: 已删除 %s", self.PUBLIC_PATCH_JS)
        except Exception as err:
            logger.warn(f"SubscribeConfigurator: 还原失败：{err}")

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
                        "如需手动还原：\n"
                        f"  cp {self.PUBLIC_INDEX}{self.BACKUP_SUFFIX} {self.PUBLIC_INDEX}\n"
                        f"  rm {self.PUBLIC_PATCH_JS}"
                    ),
                },
            }
        ]

    # ── 内部 ──
    def _write_patch_js(self) -> None:
        """从 plugin 包内 patch/_subscribe_patch.js 复制到 /public/_subscribe_patch.js"""
        content: Optional[str] = None
        try:
            from importlib.resources import files

            resource = files("plugins.subscribeconfigurator.patch").joinpath(
                "_subscribe_patch.js"
            )
            content = resource.read_text(encoding="utf-8")
        except Exception:
            pass

        if content is None:
            here = os.path.dirname(os.path.abspath(__file__))
            patch_path = os.path.join(here, "patch", "_subscribe_patch.js")
            with open(patch_path, "r", encoding="utf-8") as f:
                content = f.read()

        with open(self.PUBLIC_PATCH_JS, "w", encoding="utf-8") as f:
            f.write(content)

    def _backup_and_inject(self, content: str) -> None:
        bak = self.PUBLIC_INDEX + self.BACKUP_SUFFIX
        with open(bak, "w", encoding="utf-8") as f:
            f.write(content)

        # cache-bust query 强制浏览器每次重新拿 patch.js（nginx 给 /public/*.js 设了 30d 缓存）
        import time as _time
        cache_bust = int(_time.time())
        script_tag = (
            f'<script defer src="/{self.PATCH_SCRIPT_FILENAME}?v={cache_bust}"></script>\n'
            f"{self.PATCH_MARKER}"
        )
        if "</head>" in content:
            new_content = content.replace("</head>", f"{script_tag}\n</head>", 1)
        else:
            # 极端：没有 </head>，追加到末尾
            new_content = content + f"\n{script_tag}\n"

        with open(self.PUBLIC_INDEX, "w", encoding="utf-8") as f:
            f.write(new_content)