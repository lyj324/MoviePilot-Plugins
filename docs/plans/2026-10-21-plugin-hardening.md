# 插件加固计划（2026-10-21）

目标：在不改变插件对外行为契约的前提下，修掉两个插件的正确性、并发、状态同步和发布层问题。

执行方式：直接在 `main` 上按批次提交，每批一个小 commit；每个批次都跑验证命令。版本号与 `package.v3.json` 的 `history` 在批次末尾统一更新。

## 批次 1：Jackett 正确性（v1.1.2）

- [ ] 修 `_http_get_text()` 中 `url_path` 未定义导致的 302 重试 `NameError`
- [ ] 302 重试改用 60s 超时，并在重试后再次检查 302
- [ ] 分页参数生效：`page -> offset`，固定 `limit=100`
- [ ] `site` 改为稳定 ID（`crc32` + 保留区间），不再依赖进程随机 `hash()`
- [ ] 跨 indexer 结果去重（按 `enclosure/page_url`，保留 seeders 高者）
- [ ] 异常日志脱敏，避免 httpx 异常字符串带出 `apikey`
- [ ] 索引器列表增加 5 分钟 TTL 缓存
- [ ] 扇出并发限制为 6，整体搜索 90s 截止，保留已完成结果
- [ ] 同步钩子在已有事件循环中调用时不再 `asyncio.run` 崩溃
- [ ] `get_page()` 展示最近一次搜索摘要和最近错误

验证：

```bash
python -m py_compile plugins.v3/jackett/__init__.py
python -c "import json; json.load(open('package.v3.json'))"
```

## 批次 2：SubscribeConfigurator 功能修复（v0.15.0）

- [ ] 把 `default_start_episode` / `auto_apply_defaults` 注入 patch.js，并在配置变化时重写
- [ ] 多选下拉每次点击从 `localStorage` 重新读取，修复连选覆盖；选择后刷新显示
- [ ] `downloader` 恢复为单选，`sites` 保持多选
- [ ] 关闭“启用前端劫持”时立即还原 `index.html` 并删除 patch.js
- [ ] 异步下拉加载失败时提供真正的手填入口（prompt）
- [ ] 覆盖字段加白名单与类型归一化
- [ ] one-shot 默认开启（用户可显式关闭），清空按钮不重置该偏好
- [ ] 修复 `tryInject()` 先删面板后判断 `__mp_sc_patched` 的顺序
- [ ] MutationObserver 变更合并 + 100ms 防抖
- [ ] 异步选项请求加 5 分钟缓存；401 给出明确提示
- [ ] `index.html` / patch.js 改为原子写
- [ ] 版本/配置指纹不一致、patch 文件缺失、marker 丢失时自动重打

验证：

```bash
python -m py_compile plugins.v3/subscribeconfigurator/__init__.py
node --check plugins.v3/subscribeconfigurator/patch/_subscribe_patch.js
```

## 批次 3：发布层收口

- [ ] README 版本与插件列表同步到 Jackett 1.1.2 / 订阅增强 0.15.0
- [ ] 新增 `CHANGELOG.md`，记录每个版本改了什么
- [ ] 补 `icons/subscribeconfigurator.png`，修掉图标 404
- [ ] 新增 CI：Python 编译、JS 语法、JSON 解析
- [ ] `package.v3.json` 写入两个新版本的 `history`

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
