# 插件加固计划（2026-10-21）

目标：在不改变插件对外行为契约的前提下，修掉两个插件的正确性、并发、状态同步和发布层问题。

执行方式：直接在 `main` 上按批次提交，每批一个小 commit；每个批次都跑验证命令。版本号与 `package.v3.json` 的 `history` 在批次末尾统一更新。

## 批次 1：Jackett 正确性（v1.1.2）

- [x] 修 `_http_get_text()` 中 `url_path` 未定义导致的 302 重试 `NameError`
- [x] 302 重试改用 60s 超时，并在重试后再次检查 302
- [x] 分页参数生效：`page -> offset`，固定 `limit=100`
- [x] `site` 改为稳定 ID（`crc32` + 保留区间），不再依赖进程随机 `hash()`
- [x] 跨 indexer 结果去重（按 `enclosure/page_url`，保留 seeders 高者）
- [x] 异常日志脱敏，避免 httpx 异常字符串带出 `apikey`
- [x] 索引器列表增加 5 分钟 TTL 缓存
- [x] 扇出并发限制为 6，整体搜索 90s 截止，保留已完成结果
- [x] 同步钩子在已有事件循环中调用时不再 `asyncio.run` 崩溃
- [x] `get_page()` 展示最近一次搜索摘要和最近错误

验证：

```bash
python -m py_compile plugins.v3/jackett/__init__.py
python -c "import json; json.load(open('package.v3.json'))"
```

## 批次 2：SubscribeConfigurator 功能修复（v0.15.0）

- [x] 把 `default_start_episode` / `auto_apply_defaults` 注入 patch.js，并在配置变化时重写
- [x] 多选下拉每次点击从 `localStorage` 重新读取，修复连选覆盖；选择后刷新显示
- [x] `downloader` 恢复为单选，`sites` 保持多选
- [x] 关闭“启用前端劫持”时立即还原 `index.html` 并删除 patch.js
- [x] 异步下拉加载失败时提供真正的手填入口（prompt）
- [x] 覆盖字段加白名单与类型归一化
- [x] one-shot 默认开启（用户可显式关闭），清空按钮不重置该偏好
- [x] 修复 `tryInject()` 先删面板后判断 `__mp_sc_patched` 的顺序
- [x] MutationObserver 变更合并 + 100ms 防抖
- [x] 异步选项请求加 5 分钟缓存；401 给出明确提示
- [x] `index.html` / patch.js 改为原子写
- [x] 版本/配置指纹不一致、patch 文件缺失、marker 丢失时自动重打

验证：

```bash
python -m py_compile plugins.v3/subscribeconfigurator/__init__.py
node --check plugins.v3/subscribeconfigurator/patch/_subscribe_patch.js
```

## 批次 3：发布层收口

- [x] README 版本与插件列表同步到 Jackett 1.1.2 / 订阅增强 0.15.0
- [x] 新增 `CHANGELOG.md`，记录每个版本改了什么
- [x] 补 `icons/subscribeconfigurator.png`，修掉图标 404
- [x] 新增 CI：Python 编译、JS 语法、JSON 解析
- [x] `package.v3.json` 写入两个新版本的 `history`

验证：

```bash
python -m py_compile plugins.v3/jackett/__init__.py plugins.v3/subscribeconfigurator/__init__.py
node --check plugins.v3/subscribeconfigurator/patch/_subscribe_patch.js
python -c "import json; d=json.load(open('package.v3.json')); print({k: v['version'] for k, v in d.items()})"
```

## 回滚

每个批次一个 commit，出问题直接 `git revert <commit>`。版本号回退时同步回退 `package.v3.json` 的 `version` 和 `history`。

## 记录规则

- 每个批次至少一个 commit，commit message 写清“问题 -> 修法 -> 验证”；
- README / CHANGELOG / `package.v3.json.history` 三处版本信息保持一致；
- 不把密钥、内网地址、NAS 凭证写入仓库。

## 完成记录

- Jackett 1.1.2：`1e5aabf`
- 订阅增强 0.15.0：`828f5e7`
- 发布层收口（README / CHANGELOG / 图标 / CI / 本计划勾选）：本批次提交

验证结果：

- `python -m py_compile` 两个插件均通过；
- `node --check` 前端 patch 通过；
- `package.v3.json` 解析通过，版本为 Jackett 1.1.2 / SubscribeConfigurator 0.15.0；
- Jackett 本地 smoke harness 7 项通过（site ID 稳定性、日志脱敏、去重、Torznab 解析、分页 offset、并发上限、同步钩子安全）；
- 订阅增强 Python harness 6 项通过（注入/幂等、配置变更重写、patch.js 缺失自愈、禁用还原、无临时文件、0.14.0 marker 升级清理）；
- 订阅增强 jsdom harness 4 组通过（纯函数/白名单、面板注入与重复扫描、多选累加/取消、下载器单选、401 手填、一次性清理、传输层合并）。

## 追加修复：订阅站点下拉（0.15.1）

问题：`GET /site` 需要管理权限，普通用户会看到「加载失败」；即使加载成功，0.15.0 提交的是站点名称，而 `Subscribe.sites` 是 `List[int]`，后端会 422。

修法：

- 主端点改为原生订阅对话框使用的 `GET /site/rss`，并保留 `/site/`、`/site` 降级；
- 选项值改为数字站点 ID，显示仍用站点名称；
- 失败态提供「重试加载 / 手动输入」；手填支持名称或 ID，名称用已加载或缓存的站点列表解析；
- 成功加载后缓存站点列表，API 暂时不可用时仍可手填名称。

验证：`node --check`；jsdom 新增 3 组用例（主端点/降级、名称/ID 手填与未识别拒绝、API 全失败时用缓存列表手填）及原有 4 组全部通过；Python harness 6 项全部通过。

## 追加修复：表单风格对齐原生 Vuetify（0.15.2）

问题：注入面板的视觉和 MP 原生订阅对话框仍不一致，用户怀疑 CSS 没加载。

结论：CSS 不是外部文件，也没有加载失败；样式由 patch 在 `buildPanel()` 时内联写入 `<style id="mp-sc-styles">`。差异来自自绘控件：40px 字段、14px 文字、标签始终浮在边框上、布尔项用原生方框 checkbox；另外 teleport 到 `body` 的菜单可能丢失 `v-theme--*` 主题类。

修法：

- 字段改为原生默认 56px outlined 高度，`box-sizing:border-box`，输入文字 16px；
- 标签改为浮动标签：空值时在框内，聚焦/有值时浮到边框并缩为 12px；带前置图标的字段标签对齐到图标右侧；
- 布尔项改为 Vuetify 风格 switch（track + thumb），保留原生 checkbox 的一次性开关；
- tab 改为 48px 高、16px 内边距，清空按钮改为 text button，面板边框减弱；
- 菜单打开时复制当前 `v-theme--*` 类，保证 CSS 变量在 `body` 下仍可解析；
- `injectStyles()` 每次检查 DOM，不再依赖一次性布尔标记。

验证：`node --check`；jsdom 全部 8 组通过（新增主题类继承、switch 结构、填充态标签、style 自愈）；浏览器预览实测字段 56px、浮动标签 12px、switch track 36×14；Python harness 6 项全部通过。

提交：`f38d792`

