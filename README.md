# Visual Bookmarks for Edge

可视化书签扩展，支持编辑、搜索和拖拽书签，兼容 Microsoft Edge 和 Google Chrome（Manifest V3）。

左侧文件夹和右侧书签直接管理 Edge 原生收藏。可以拖动书签换位或移入文件夹。在右上角「⋯」开启「收藏时保存首张缩略图」后，新收藏的网页会保存一张首屏图。要替换某一张，把鼠标移到该书签上，点击「⋯」→「更新此书签缩略图」。

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
