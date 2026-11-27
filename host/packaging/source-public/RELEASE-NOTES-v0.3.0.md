# 活页 Huoye v0.3.0

> 中文说明在上方 · English release notes below.

---

## 更新亮点（简体中文）

**v0.3.0** 让活页从「可定制的本地素材底座」正式迈向「**原件与视角分开、形态与算力皆可插拔**」的完整工作台生态，并同步上线官方网站 **[huoye.org](https://huoye.org)** 与官方扩展仓库 **[huoye-extensions](https://github.com/XinXingNOVA/huoye-extensions)**：

### 1. 本地离线算力总线与 `.hyruntime` 共享运行包
- **版本化能力契约（Capability Bus）**：图像特征向量、自然语言文搜图、实况 OCR、前景抠图、离线语音转写等能力统一通过契约接口解耦，每个仓库可在 **「设置 → 计算引擎」** 自由选择或热切换底层引擎（如 Apple Vision / Chinese-CLIP / 跨平台经典特征 / Tesseract / Whisper），互不锁死。
- **`.hyruntime` 共享运行包**：将体积较大的原生推理程序与量化模型权重独立打包分发，导入一次即可被多个仓库共享；不装则主程序保持轻量，全程离线、零 Python 环境依赖。

### 2. 官方扩展生态独立发布：`huoye-extensions`（v0.1.0）
- 独立建立官方扩展仓库 **[XinXingNOVA/huoye-extensions](https://github.com/XinXingNOVA/huoye-extensions)** 与官网 **[扩展馆](https://huoye.org/catalog)**，与主程序版本解耦、支持按项直链下载与 SHA-256 校验：
  - **8 套整合场景套件（`.hysuite`）**：画室精审、灵图与灵眸、设计工坊、青瓷书房、黑胶放映与听译、办公与档案工坊、效率魔方、仓库洞察；
  - **2 个离线共享运行包（`.hyruntime`）**：Chinese-CLIP 中文语义视觉（Apple Silicon）、Whisper 离线语音听译（Apple Silicon）；
  - **1 套独立主题包（`.hytheme`）**：博丽缘侧（另有 4 套内置主题及主仓附带的「蓝晒」「银杏·秋光」2 套示例主题）；
  - **38 个单装插件（`.hyplugin`）**：按需单装或自由组合，批处理类工坊同步支持「导入当前仓库」与「直接导出到本地（不入库）」双去向。

### 3. 平台覆盖与桌面体验打磨
- **Windows x64 支持推进**：完善跨平台路径、程序探测与构建/打包链路（具体安装包发布状态以本版 Release 附件及 [平台说明](docs/guide/platform-notes.md) 为准）。
- **macOS 原生全屏细节修复**：主窗口、侧栏收起态、独立内容小窗与独立设置窗口在进入 macOS 原生全屏时自动收回红绿灯左侧留白，且各窗口全屏状态彼此隔离。
- **官网与文档体系刷新**：上线活页本式双语官网 **[huoye.org](https://huoye.org)**；重写 `README`、新增 [本地离线算力与共享运行包](docs/guide/compute-and-runtimes.md) 指南，并将开发者文档聚焦于更稳定顺手的「克隆主仓 + `llms.txt` + 外部独立工程校验打包」闭环。

### 升级与安装说明
- 仓库数据库（`library.db` / `derived.db`）、v4 托管空间与原地目录登记簿均向下兼容，直接覆盖安装主程序即可打开已有仓库。
- 主程序内置的 12 个基础插件与 7 个基础可选插件保持各自原有语义化版本递增；官方扩展仓 `huoye-extensions` 作为独立生态线以 `v0.1.0` 起步。
- macOS 首次打开如遇未公证拦截，核对 `SHA256SUMS.txt` 后执行：`xattr -dr com.apple.quarantine "/Applications/活页Huoye.app"`。

---

## Highlights (English)

**Huoye v0.3.0** expands Huoye into a complete pluggable workspace ecosystem — introducing the offline compute capability bus and `.hyruntime` shared runtimes alongside the launch of **[huoye.org](https://huoye.org/en/)** and the official **[huoye-extensions](https://github.com/XinXingNOVA/huoye-extensions)** repository:

### 1. Offline Compute Capability Bus & Shared `.hyruntime` Packs
- **Versioned Capability Contracts**: Image embeddings, bilingual text-to-image search, Live Text OCR, subject cutout, and speech transcription are decoupled behind versioned contracts. Choose or hot-swap engines per library under **Settings → Compute Engines**.
- **Shared `.hyruntime` Archives**: Heavy native inference binaries and quantized models ship separately from lightweight `.hyplugin` packages. Import once and share across libraries — zero Python setup, fully offline.

### 2. Official Extensions Repository: `huoye-extensions` (`v0.1.0`)
- Launched **[XinXingNOVA/huoye-extensions](https://github.com/XinXingNOVA/huoye-extensions)** and the bilingual **[Web Catalog](https://huoye.org/en/catalog)** with direct downloads and `SHA256SUMS.txt`:
  - **8 Curated Suites (`.hysuite`)**: Atelier Studio, Visual Search & Vision, Design Studio, Celadon Study, Screening & Transcript Studio, Documents & Archives Studio, Forge Studio, and Vault Insight.
  - **2 Offline Shared Runtimes (`.hyruntime`)**: Chinese-CLIP ViT-B/16 and Whisper Local Speech (macOS Apple Silicon).
  - **1 Standalone Theme (`.hytheme`)**: Hakurei Shrine (complementing 4 built-in themes plus Cyanotype and Ginkgo Autumn examples in the core repo).
  - **38 Standalone Plugins (`.hyplugin`)**: Mix and match individually, with dual output modes (save to library or export directly to disk) across batch processing tools.

### 3. Desktop Polish & Documentation Refresh
- **macOS Fullscreen Chrome Fix**: Removes reserved traffic-light insets cleanly when entering macOS native fullscreen across the main window, collapsed sidebar, detached content windows, and settings windows — tracked independently per window.
- **Windows x64 Verification & Refresh**: Updated cross-platform packaging and platform notes (see Release assets and [Platform Notes](docs/guide/platform-notes.md)).
- **Website & Docs**: Launched [huoye.org](https://huoye.org/en/), updated `README`, `llms.txt`, and developer guides to highlight the reliable standalone external-plugin workflow.
