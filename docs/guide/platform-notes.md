# 平台说明与备份建议

本页整理活页 v0.3.0 在 macOS 与 Windows 上的安装注意项、外部媒体工具依赖，以及完整的数据备份与迁移方法。

---

## 1. macOS（Apple Silicon）

- 在 [GitHub Releases](https://github.com/XinXingNOVA/huoye/releases) 下载 `Huoye-0.3.0-mac-arm64.dmg` 或 `Huoye-0.3.0-mac-arm64.zip`，并对照同页 `SHA256SUMS.txt` 核对校验和。
- **首次打开遇到“无法验证开发者”或“已损坏”提示**：
  当前应用使用 ad-hoc 签名，暂未购买 Apple 开发者公证证书。核对校验和后，将 `活页Huoye.app` 拖入「应用程序」，任选其一放行：
  - **终端一行命令（推荐）**：
    ```bash
    xattr -dr com.apple.quarantine "/Applications/活页Huoye.app"
    ```
  - **系统设置点选**：先双击一次并点「完成」→ 打开「系统设置 → 隐私与安全性」→ 滑到底部点「仍要打开」并确认密码。
- **音视频处理依赖（FFmpeg）**：
  macOS 安装包未内置 FFmpeg。如需使用视频封面提取、转码、音频真波形或无损快剪，建议通过 Homebrew 安装：
  ```bash
  brew install ffmpeg
  ```
- **macOS 专属能力说明**：
  Apple Vision 视觉引擎（`embed-apple` / `vision-apple`）、PDF 手术台（`pdf-forge`）以及当前的两个 `darwin-arm64` 共享运行包（`huoye-cn-clip`、`huoye-whisper`）依赖 macOS 系统框架或 Apple Silicon 架构。

---

## 2. Windows（x64）

- Windows x64 安装包随实机全链路验收发布于 [GitHub Releases](https://github.com/XinXingNOVA/huoye/releases)；也可以按 [Windows 构建指南](../../host/docs/development/Windows-AI构建指南.md) 从公开源码本地构建。
- **首次运行 SmartScreen 提示**：
  因个人开源项目未配置商业代码签名证书，Windows Defender SmartScreen 可能弹出「Windows 已保护你的电脑」，核对 `SHA256SUMS.txt` 后点击 **「更多信息 → 仍要运行」** 即可。
- **扩展插件跨平台说明**：
  `huoye-extensions` 中绝大部分套件与插件均为全平台支持；在 Windows 上，以图搜图与 OCR 可直接选用跨平台引擎 `embed-classic` 与 `vision-tesseract`（若未随包内置 FFmpeg，可将 `ffmpeg.exe` 加入系统 `PATH` 以启用视频转码与快剪）。

---

## 3. 数据备份与迁移建议（非常重要）

**先完全退出活页，再做同一批备份。** 每个仓库都要保留完整的仓库目录（其中 `library.db` 保存素材身份、标签、笔记、字段和视图；`derived.db` 为可重建缓存），再按仓库实际关联的空间补齐对应文件：

| 仓库用到的空间 | 需要一起备份的内容 |
| :--- | :--- |
| **托管空间** | 整个托管空间目录（含原件与历史版本）。随库新建的空间位于仓库目录内；另选位置或跨库共享的空间需单独备份。 |
| **原地目录** | **来源文件夹里的原件**，以及 **活页本机应用数据下的 `file-spaces/` 登记簿目录**（用于维持来源文件与仓库记录的身份映射）。 |

默认本机应用数据路径：
- **macOS**：`~/Library/Application Support/活页Huoye/file-spaces/`（访达按 `⌘⇧G` 粘贴即可打开）
- **Windows**：`%APPDATA%\活页Huoye\file-spaces\`
- 若通过环境变量 `RM_USER_DATA` 指定了自定义数据目录，则备份该目录下的 `file-spaces/`。

恢复时先退出活页，把仓库目录、托管空间、原地来源与 `file-spaces/` 放回对应位置。若原地来源换了磁盘路径，打开仓库后在「文件空间」使用 **「重新定位根目录…」** 并按提示核对即可。

> 本机应用数据目录可能包含 MCP 访问令牌或本地服务配置，请仅保存在私人备份中，不要对外分享。

---

## 4. 遇到问题怎么反馈？

欢迎到 [GitHub Issues](https://github.com/XinXingNOVA/huoye/issues) 提交 Bug 或建议，附上以下信息可以最快定位：
- 活页版本号、操作系统与架构（如 `macOS 15 arm64` / `Windows 11 x64`）；
- 启用的套件或插件列表；
- 简明复现步骤、预期结果与实际表现；
- 附截图或日志前，**请务必遮盖私密素材与 MCP 令牌**，无需上传整个个人仓库。
