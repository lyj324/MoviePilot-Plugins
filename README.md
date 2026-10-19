# MoviePilot-Plugins

MoviePilot v3 第三方插件集合。

## 插件

- **Jackett** (1.1.0) —— Jackett / Torznab 索引器接入；基于 MP 官方 jackett 插件补上 v3 dispatcher 必需的 `get_module()` 注册方法
- **订阅增强** (0.1.0) —— 在订阅添加对话框注入 `start_episode` / `filter` / `include` / `exclude` / `quality` / `resolution` / `effect` 等字段，添加订阅时即可一次性配置

## 安装

1. MP 后台 → 插件 → **插件仓库** → 添加本仓库 URL → 保存 → 同步
2. 在仓库列表里挑要装的插件 → 安装
3. 已安装 → 找到插件 → 填配置 → 保存

## 许可

MIT