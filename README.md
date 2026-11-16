# Visual Bookmarks for Edge

可视化书签扩展，支持编辑、搜索和拖拽书签，兼容 Microsoft Edge 和 Google Chrome（Manifest V3）。

当前正式版已接入 `feature/ui-polish-10-grid` 的横向书签和文件夹 Dock 界面，直接管理浏览器原生收藏夹。

## 下载与安装

**[下载最新安装包](https://github.com/mike56-ui/visual-bookmarks-chrome/releases/latest)**，选择 Assets 中的 `visual-bookmarks-edge.zip`。

1. 解压到固定文件夹。
2. 打开 `edge://extensions`，开启「开发人员模式」。
3. 点击「加载解压缩的扩展」，选择包含 `manifest.json` 的文件夹。

新版可覆盖到同一目录后点击「重新加载」，更新前请备份数据。开发者模式安装暂不支持商店自动更新。

本分支尚未上架自己的 Edge 商店条目。后续完成首次上架后，商店安装的用户才能收到商店更新。

## 自动发布

推送或合并到 `master` 后，GitHub Actions 自动构建、校验并生成带 ZIP 安装包和 SHA-256 校验值的 Release。也支持在 Actions 中手动运行。

完整的本地构建、版本规则及商店上架步骤见 [发布说明](docs/RELEASING.md)。

## 项目来源

本项目基于 [k-ivan/visual-bookmarks-chrome](https://github.com/k-ivan/visual-bookmarks-chrome)。原作者的商店条目与本分支分别维护，本分支的更改不会更新到原作者的商店条目。
