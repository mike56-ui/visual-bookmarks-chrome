# 发布与安装

## GitHub 自动发布

推送或合并代码到 `master` 后，GitHub Actions 自动安装锁定依赖、构建生产版、验证必要文件、打包 ZIP 并发布 Release。也可以在 Actions → Build and release Edge extension → Run workflow 手动触发。

下载地址：https://github.com/mike56-ui/visual-bookmarks-chrome/releases/latest

安装包固定名为 `visual-bookmarks-edge.zip`，ZIP 根目录包含 `manifest.json`。安装步骤见 [安装说明](release-notes.md)。

版本号为 `7.7.1.<GitHub Actions run_number>`。CI 只对构建产物注入版本，不会提交版本文件或触发循环。重新运行同一次 workflow 保持相同版本，并保留已发布的原始包。版本每段不超过 65535，超过时构建将失败；届时需要提高前三段基础版本并调整构建编号方案。修改基础版本后必须保持版本号严格递增。

工作流需要仓库允许 GitHub Actions，以及 `GITHUB_TOKEN` 的 `contents: write` 权限，不需要额外的 GitHub Token。若 fork 默认禁用了 Actions，请在仓库 Actions 页面启用。

本地打包需要 Node.js 22 和 Python 3：

```sh
npm ci
npm run release
```

结果位于 `dist/visual-bookmarks-edge.zip`。构建目录为 `extension_chrome/`，同时兼容 Edge。

## 首次上架 Edge 商店（尚未接入）

本仓库是原作者项目的分支，原 README 中的商店条目属于原项目，不能用它更新本分支。

1. 在 [Microsoft Partner Center](https://partner.microsoft.com/dashboard/microsoftedge/overview) 注册或登录 Edge 扩展开发者账号。
2. 创建自己的扩展产品，上传上述 ZIP，填写真实的开发者资料、描述、截图、隐私政策等必要资料。
3. 提交审核，审核通过后保存自己的商店链接。
4. 从自己的商店条目安装插件。开发者模式安装不会自动迁移成商店版；迁移前备份数据。

后续可用 Publish API 自动上传新版并提交审核，需要在 Partner Center 开启 Publish API，然后将 `EDGE_PRODUCT_ID`、`EDGE_CLIENT_ID`、`EDGE_API_KEY` 配置为仓库 Actions Secrets（不要提交到代码或聊天）。当前工作流仅发布 GitHub Release，尚不调用商店 API。

API Key 有有效期，需要在到期前更新。自动提交成功代表已送审，不代表微软审核通过或立即向用户推送。

官方参考：[首次发布](https://learn.microsoft.com/en-us/microsoft-edge/extensions/publish/publish-extension)、[自动更新 API](https://learn.microsoft.com/en-us/microsoft-edge/extensions/update/api/using-addons-api)。
