# Changelog

## 2026-10-21

### Jackett 1.1.2

修复：

- 302 重登录分支引用未定义的 `url_path`，导致 cookie 过期后抛 `NameError`、无法自愈；重试也改为 60s 超时，并检查重试后是否仍 302。
- `page` 参数此前被忽略；现在映射为 Torznab `offset = page * 100`，`limit=100`，分页能拿到新结果。
- 合成站点 ID 由进程随机 `hash()` 改为 `crc32` + 保留区间，重启后保持稳定，避免影响站点级去重/下载器绑定。
- 跨索引器结果按 `enclosure/page_url` 去重，保留 seeders 更高的一条。
- 异常日志统一脱敏 `apikey`；同步钩子在已有事件循环中调用时不再 `asyncio.run` 崩溃。
- 索引器列表增加 5 分钟 TTL 缓存；扇出并发限制 6，整体 90s 截止，超时保留已完成结果。
- 插件页展示最近一次搜索摘要和最近错误。

验证：`py_compile` + 本地 smoke harness（site ID 稳定性、日志脱敏、去重、Torznab 解析、`offset=200`、并发 ≤6、同步钩子安全）。

提交：`1e5aabf`

### 订阅增强 0.15.1

修复：

- 「订阅站点」下拉改用 MP 原生订阅对话框同款 `GET /site/rss`，普通用户也能加载；按 `/site/rss` → `/site/` → `/site` 依次降级，兼容旧版 MP。
- 站点选项值改为数字站点 ID。`Subscribe.sites` 是 `List[int]`，0.15.0 提交站点名称会被后端 422 拒绝。
- 选中站点后显示站点名称而不是原始 ID。
- 加载失败时提供「重试加载 / 手动输入」两个动作；手填支持站点名称或 ID，名称会用已加载或上次缓存的站点列表解析，无法识别时明确提示，不会把名称当 ID 提交。
- 站点列表成功加载后缓存到 localStorage，API 暂时不可用时手填仍能按名称解析。

验证：Node `--check`；jsdom harness（`/site/rss` 主端点、`/site/` 降级、非激活站点过滤、多选存 ID、显示名称、名称/ID 手填、未识别名称拒绝、缓存列表手填、POST 合并为整数数组、401 重试菜单）；Python harness 全部通过。

提交：`f279c62`

### 订阅增强 0.15.0

修复：

- `default_start_episode` / `auto_apply_defaults` 此前是死配置（JS 只读 localStorage，没人写入）。现在由 Python 注入 `window.__MP_SC_CONFIG__`，并把配置指纹写入脚本 URL 与 marker；配置变化会重写 patch.js 并刷新缓存。
- 站点多选每次点击复用旧快照，选 A 再选 B 只保留 B；改为每次从 localStorage 读-改-写，并即时刷新菜单选中态。
- 下载器恢复单选（后端 schema 是字符串），站点保持多选。
- 关闭「启用前端劫持」时立即从备份还原 `index.html` 并删除 patch.js，不再等 `stop_service`。
- 异步选项加载失败时提供真正的手填 `prompt`；401 明确提示登录已过期。
- 覆盖字段增加白名单和类型归一化；显式 `start_episode=0` 可以覆盖服务端默认值。
- 一次性模式默认开启；「清空全部」不再重置用户的一次性偏好。
- 重复扫描不再先删面板再判断 patched 标记，避免面板闪没；旧版本面板会被替换。
- MutationObserver 合并变更并 100ms 防抖；站点/下载器选项缓存 5 分钟。
- `index.html` / patch.js 改为原子写；版本、配置指纹、patch 文件、marker 任一不一致都会自动重打，并清理 0.14.0 遗留在注释外的版本后缀。

验证：`py_compile`；Node `--check`；本地 Python harness（注入/幂等/配置变更/缺文件自愈/禁用还原/原子写/旧 marker 升级）；jsdom harness（面板注入、重复扫描、旧面板替换、多选累加/取消、下载器单选、401 手填、一次性清理、字段白名单）。

提交：`828f5e7`

### 仓库

- README 版本同步到 Jackett 1.1.2 / 订阅增强 0.15.0。
- 补齐 `icons/subscribeconfigurator.png`，修复图标 404。
- 新增 GitHub Actions CI：Python 编译、JS 语法、JSON 解析。
