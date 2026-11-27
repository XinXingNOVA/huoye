# 本地离线算力与共享运行包

活页把需要较重计算的视觉与语音能力做成**可插拔、全离线、多库共享**的架构：主程序保持轻量，你用到哪项能力，再装对应的引擎或共享运行包；所有推理都在你自己的电脑上完成，数据不出本机。

---

## 一、两层解耦：引擎插件 vs 共享运行包

在活页里，离线算力分为两个清晰的层次：

1. **能力引擎插件（`.hyplugin`，通常只有几十 KB）**：
   负责向宿主声明自己提供的能力契约（如 `vision/image.embed@1`、`vision/text.embed@1`、`vision/image.ocr@1`、`media/audio.transcribe@1`），并把任务交给系统框架或本机程序执行。
2. **共享运行包（`.hyruntime`，包含原生二进制与量化模型权重）**：
   把体积较大的推理引擎和模型独立打包。在应用设置中**导入一次**，就能被本机多个仓库共享，既不撑大主程序，也无需手工安装 Python 或配置命令行环境。

---

## 二、官方提供的两类离线能力

### 1. 视觉检索、识字与抠图

搭配官方扩展仓库 [huoye-extensions](https://github.com/XinXingNOVA/huoye-extensions) 中的 **灵图与灵眸（`visual-search`）** 或 **画室精审（`atelier-studio`）** 套件使用：

| 引擎插件 | 对应能力 | 平台 | 说明 |
| :--- | :--- | :--- | :--- |
| `embed-apple` | 以图搜图 / 视觉去重 | 仅 macOS | 直接调用系统 Apple Vision 神经引擎，无需额外运行包 |
| `embed-classic` | 以图搜图 / 视觉去重 | 全平台 | 纯 TypeScript 跨平台特征，Windows / Linux 开箱可用 |
| `embed-clip` | 中英文自然语言文搜图 / 图文混搜 | 全平台* | 需搭配共享运行包 `huoye-cn-clip-*.hyruntime`（当前提供 macOS Apple Silicon 版） |
| `vision-apple` | 实况文本 OCR / 一键主体抠图 | 仅 macOS | 直接调用系统 Apple Vision，无需额外运行包 |
| `vision-tesseract` | 多语种图片 OCR | 全平台 | 对接本机 Tesseract OCR |

### 2. 离线语音转字幕（Whisper）

搭配 **黑胶放映与听译（`media-studio`）** 套件（或单装 `speech-whisper` + `whisper-studio`）及共享运行包 `huoye-whisper-*.hyruntime` 使用：

- 导入音视频**绝不自动占满 GPU**，需要听写时在「听译字幕工坊」或素材详情中按需触发；
- 转写结果自带逐句时间码，全文自动接入活页全局搜索——输入关键词，点中台词即可跳回原声对应秒数；
- 支持导出 SRT / WebVTT 字幕，或一键沉淀为库内 Markdown 笔记。

---

## 三、安装与切换引擎的三步流程

1. **导入共享运行包（仅使用 Chinese-CLIP 或 Whisper 时需要）**：
   前往 [huoye-extensions Releases](https://github.com/XinXingNOVA/huoye-extensions/releases) 或 [官网扩展馆](https://huoye.org/catalog) 下载 `.hyruntime`，打开活页 **「设置 → 计算引擎 → 共享运行包」** 导入并启用。
2. **安装并启用对应套件或引擎插件**：
   在 **「设置 → 套件与插件包」** 导入对应 `.hysuite` / `.hyplugin`，并在目标仓库的 **「功能与方案」** 中勾选启用。
3. **按仓库选定引擎**：
   进入 **「设置 → 计算引擎 → 本库覆盖」**，为某项能力（如 `vision/image.embed@1` 或 `media/audio.transcribe@1`）指定想用的提供方，保存并重载仓库即可生效。不同仓库可以使用不同引擎，互不干扰。

---

## 四、卸载与空间回收

- 停用或切换算力引擎不会删除已经生成的普通标签与笔记；
- 如果不再需要某个共享运行包，可在 **「设置 → 计算引擎 → 共享运行包」** 中停用并移除，立即释放数百 MB 模型空间。
