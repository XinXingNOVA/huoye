# 活页 Huoye v0.2.0

> 中文说明在上方 · English release notes below.

---

## 更新亮点（简体中文）

**v0.2.0** 是活页发布后的首个大型底座升级版本，重点围绕 **「视觉定制自由」「零复制原地目录」与「全仓中英双语」** 三条主线完成了系统级补齐：

### 1. 公共 UI Kit 与 `.hytheme` 主题体系（v1–v6）
- **公共组件与图标**：推出 `@resource-manager/plugin-api/ui/kit`（`ui-kit-v1`）与 32 个公共语义图标，统一深浅配色、界面密度（含十万级虚拟表格行高联动）与控件圆角；
- **4 套实景昼夜内置主题 & 套件推荐**：全新内置 **活页 · 标准**（新装默认）、**银盐画册**（视觉素材库推荐）、**青瓷书房**（轻竹影页边 + 衬线阅读）与 **紧凑资料台**（通用资料库推荐），全部原生带实景预览与昼夜双分支；另保留「经典主题」折叠区平滑兼容 v0.1 旧配置与外部主题基准；
- **一库一风 & 小窗同步**：开始页沿用应用默认外观，每个仓库可独立设定外观并自动同步至独立内容小窗与设置窗；
- **昼夜双分支主题（v6）**：支持在一份 `.hytheme` 包内同时定义浅色/深色两套配色、壁纸、阅读排版与 SVG 图标，按库选择「跟随系统 / 固定浅色 / 固定深色」；
- **壁纸、贴纸与毛玻璃**：可用本机图片或库内图片设置壁纸，调节平铺宽度、九宫格锚点和四角贴纸。逐卡模糊默认关闭。在 Apple M5 的 5 万与 10 万项密集图库测试中，仅工作台启用毛玻璃时，两档呈现间隔的 P95 均约为 16.7 ms，均未观察到未就绪图块。
- **统一阅读排版 & 三层外观入口**：Text、PDF 与 EPUB（1.3.0）统一支持主题版心与纸墨并保留用户手动偏好；新增插件外观归集（`category: 'appearance'`），PDF 默认纸面直接归入「本库外观 → 插件外观」。

### 2. 原地文件空间全闭环（零复制直连本地文件夹）
- **开始页直达**：新增 **「从本地文件夹开始…」**，直接为电脑上已有的照片、PDF、电子书或资料文件夹建库；同时将「打开本地仓库」更名为更清晰的「打开已有仓库」，误选普通文件夹时可直接引导转为原地建库；
- **零侵入登记与身份接续**：登记簿独立保存于本机应用数据区，不向用户目录写入任何隐藏文件；同卷改名或跨目录移动自动接续素材身份，支持根目录重定位与断盘离线保护；
- **流式阅读与接纳新版**：`lib://` 支持原地文件的流式读取和 HTTP `Range`。外部编辑后，双击素材即可核对并接纳新版，标签和笔记保留。如果旧原件已被覆盖，仍可核对其大小和内容摘要。需要取回旧版本时，应在编辑前先转为托管副本。
- **双向生命周期与 MCP**：支持从空间反查本库引用、经完整核对并二次复核后安全回收已确认缺失的主文件记录；应用设置新增本机原地登记簿盘点、缺失追踪清理与两阶段安全忘记；公开 MCP 同步支持原地目录核对、按后缀收录与缺失盘点。

### 3. 全仓中英双语热切换
- **免重启即时切换**：在 **「设置 → 界面语言 / Language」** 支持「跟随系统 / 简体中文 / English」，切换即时同步原生菜单、开始页、所有仓库主窗与独立小窗；
- **发行插件与套件词典**：`ui-locale-v1` 与包内 `locales` 让两套起始套件和 19 个发行插件（随附 12 个、可选 7 个）随界面语言切换。用户创建的标签、笔记和视图保留原文。

### macOS 下载件

- [Huoye-0.2.0-mac-arm64.dmg](https://github.com/XinXingNOVA/huoye/releases/download/v0.2.0/Huoye-0.2.0-mac-arm64.dmg) 和 [Huoye-0.2.0-mac-arm64.zip](https://github.com/XinXingNOVA/huoye/releases/download/v0.2.0/Huoye-0.2.0-mac-arm64.zip) 提供同一份 Apple Silicon 应用。可打开 DMG 安装，也可解压 ZIP。应用带有 12 个插件，支持按两套内置方案建库或从空白仓库开始。
- [SHA256SUMS.txt](https://github.com/XinXingNOVA/huoye/releases/download/v0.2.0/SHA256SUMS.txt) 列出 macOS 安装包、可选插件合集及源码快照的 SHA-256。
- 可下载 7 个可选插件的合集 [Huoye-0.2.0-plugins.zip](https://github.com/XinXingNOVA/huoye/releases/download/v0.2.0/Huoye-0.2.0-plugins.zip) 和源码快照 [Huoye-0.2.0-source.zip](https://github.com/XinXingNOVA/huoye/releases/download/v0.2.0/Huoye-0.2.0-source.zip)。源码目录 `host/examples/themes/` 随附 2 套精选昼夜 `.hytheme` 主题包：**[cyanotype.hytheme](https://raw.githubusercontent.com/XinXingNOVA/huoye/v0.2.0/host/examples/themes/cyanotype.hytheme)（蓝晒）** 与 **[ginkgo.hytheme](https://raw.githubusercontent.com/XinXingNOVA/huoye/v0.2.0/host/examples/themes/ginkgo.hytheme)（银杏·秋光）**。

### 从 v0.1.0 升级说明
- 仓库数据库与 v4 托管文件空间格式完全兼容，直接覆盖安装并打开原有仓库即可；
- 如果装过首版可选插件，下载新版合集后，可在「设置 → 套件与插件包」找到对应插件并点 **「更新…」**。更新保留仓库数据与原来的启停选择。
- macOS 首次打开如遇未公证拦截，核对校验和后执行：`xattr -dr com.apple.quarantine "/Applications/活页Huoye.app"`。

---

## Highlights (English)

**Huoye v0.2.0** delivers three major foundational upgrades across visual customization, zero-copy file management, and bilingual localization:

### 1. Shared UI Kit & Declarative `.hytheme` Ecosystem (v1–v6)
- **Shared `UI Kit` & 32 SVG Icons**: Introduces `@resource-manager/plugin-api/ui/kit` (`ui-kit-v1`), unified density/radius tokens (including synchronized virtual table row height), and sanitized geometric SVG icon overrides.
- **4 Featured Day/Night Themes & Starter Recommendations**: Ships with **Huoye Standard** (new-install default), **Silver Gelatin** (recommended for Visual Library), **Celadon Study** (bamboo-shadow reading margins), and **Compact Desk** (recommended for Reference Library)—all featuring real previews and paired light/dark modes, with 7 classic themes tucked cleanly under *Classic themes* for backward compatibility.
- **Per-Library Styling & Detached Window Sync**: Give each library its own theme, wallpaper, and layout density—automatically inherited by detached content windows and settings windows.
- **Day/Night Paired Themes (v6)**: A single `.hytheme` package can ship complete `light` and `dark` variants (colors, wallpapers, reader typography, and icons) with per-library **Follow System / Light / Dark** control.
- **Wallpapers, stickers, and glass**. Use a local or library image, tile a texture, pick a wallpaper anchor, or adjust a corner sticker. Per-card blur is off by default. On an Apple M5 with dense 50,000- and 100,000-item grids, workbench-only blur produced a P95 frame interval of about 16.7 ms at both sizes. Neither run reported frames with unready tiles.
- **Unified Reading & Intent-Driven Appearance Settings**: Text, PDF, and EPUB readers share `reader-page` typography while respecting manual overrides; plugins can contribute visual settings via `category: 'appearance'` (demonstrated by PDF default paper mode).

### 2. Zero-Copy In-Place Folder File Spaces
- **Start from a Folder**: Launch directly from an existing folder of photos, PDFs, or ebooks without duplicating files or writing hidden metadata into your folder (local catalogs live under Huoye's app data).
- **Identity Continuity & Offline Protection**: Automatically tracks same-volume renames and cross-folder moves, supports root directory relocation, handles offline drives gracefully, and streams originals via `lib://` with HTTP `Range` support.
- **Accepting file updates**. Open an externally edited item to check and accept its new version. Tags and notes stay with the item. If the old file has been overwritten, its recorded size and hash are still available. To retain older file contents, create a managed copy before editing. The File Space view and public MCP tools can also check sources and identify missing items.

### 3. Hot-Swappable Bilingual UI (English / 简体中文)
- **Instant Switching Without Restart**: Switch between **Follow System / 简体中文 / English** under **Settings → Language / 界面语言**—updating native menus, Launcher, library windows, and detached windows in place.
- **Plugin and suite dictionaries**. Both starter suites and all 19 release plugins (12 bundled and 7 optional) use package-owned dictionaries to support English and Simplified Chinese. User-created tags, notes, and views keep their original wording.

### Release Assets
- [Huoye-0.2.0-mac-arm64.dmg](https://github.com/XinXingNOVA/huoye/releases/download/v0.2.0/Huoye-0.2.0-mac-arm64.dmg) and [Huoye-0.2.0-mac-arm64.zip](https://github.com/XinXingNOVA/huoye/releases/download/v0.2.0/Huoye-0.2.0-mac-arm64.zip) contain the same Apple Silicon app. Open the DMG to install or extract the ZIP. The app includes 12 plugins and offers Visual Library, Reference Library, and Blank Library at startup.
- Download the seven-plugin bundle [Huoye-0.2.0-plugins.zip](https://github.com/XinXingNOVA/huoye/releases/download/v0.2.0/Huoye-0.2.0-plugins.zip) or the source snapshot [Huoye-0.2.0-source.zip](https://github.com/XinXingNOVA/huoye/releases/download/v0.2.0/Huoye-0.2.0-source.zip). Two curated day/night `.hytheme` packages are included under `host/examples/themes/` in the source tree: **[cyanotype.hytheme](https://raw.githubusercontent.com/XinXingNOVA/huoye/v0.2.0/host/examples/themes/cyanotype.hytheme) (Cyanotype)** and **[ginkgo.hytheme](https://raw.githubusercontent.com/XinXingNOVA/huoye/v0.2.0/host/examples/themes/ginkgo.hytheme) (Ginkgo)**.
- [SHA256SUMS.txt](https://github.com/XinXingNOVA/huoye/releases/download/v0.2.0/SHA256SUMS.txt) lists digests for the macOS downloads, optional plugins and source snapshot.
