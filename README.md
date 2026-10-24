# MoviePilot-Plugins

MoviePilot v3 第三方插件集合。

## 插件

- **Jackett**（1.1.3）—— 接入 Jackett / Torznab 索引器；基于 MP 官方 jackett 插件补上 v3 dispatcher 必需的 `get_module()` 注册。支持分页（`page → offset`）、跨索引器去重、稳定的合成站点 ID、25s 单索引器超时、8 路并发、按索引器数量计算的搜索预算（上限 150s）、5 分钟索引器列表缓存，以及可选的「指定索引器」多选。登录串行化，transport 失败会写入最近错误；索引器 id 做 URL 编码，`<link>` 仅接受 http/https/magnet。
  - 目录：`plugins.v3/jackett/`
- **订阅增强**（0.15.5）—— 在订阅添加对话框注入 `start_episode` / `filter` / `include` / `exclude` / `quality` / `resolution` / `effect` 等字段，添加订阅时即可一次性配置。支持服务端默认开始集数 / 自动套用、站点多选、下载器单选、异步选项失败手填和一次性覆盖。站点下拉改用原生 `GET /site/rss`，提交数字站点 ID，加载失败可重试或按名称/ID 手填。界面按 MP 原生 Vuetify 表单对齐：56px outlined 字段、16px 输入文字、浮动标签、Vuetify 风格 switch/tab/text button。面板注入到原生滚动容器 `.v-card-text`；窄屏（≤699px）默认折叠，展开后由原生对话框滚动，修复手机端无法上下滚动的问题。对话框识别以标题为主（兼容中英文），编辑订阅不会误注入；关键词/总集数/指定季只存内存，不会跨订阅残留。仅管理员可用（会改写全局前端），关闭/卸载时只移除注入标签，不会把 MoviePilot 升级后的前端还原成旧版本。
  - 目录：`plugins.v3/subscribeconfigurator/`

版本变更记录见 [CHANGELOG.md](CHANGELOG.md)，插件仓库元数据见 [package.v3.json](package.v3.json)。

## 安装

1. MP 后台 → 插件 → **插件仓库** → 添加本仓库 URL → 保存 → 同步
2. 在仓库列表里挑要装的插件 → 安装
3. 已安装 → 找到插件 → 填配置 → 保存

## 开发

```bash
python -m py_compile plugins.v3/jackett/__init__.py
python -m py_compile plugins.v3/subscribeconfigurator/__init__.py
node --check plugins.v3/subscribeconfigurator/patch/_subscribe_patch.js
python -m unittest discover -s tests -v
python -c "import json; json.load(open('package.v3.json', encoding='utf-8'))"
```

## 许可

MIT
