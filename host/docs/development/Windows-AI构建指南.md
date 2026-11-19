# 给 AI 的 Windows 构建指南

目标：在接收者的 Windows x64 电脑上，从完整源码套件构建可试用的资源管理器。请先读源码根目录 README 和插件功能清单。宿主、插件版本及 SHA-256 见 `source-manifest.json`；不需要向维护者索取个人配置、仓库或 API Key。

两套起始方案共附带 12 个插件，新库按所选方案启用。另提供 7 个独立可选包和合集 ZIP。Windows 打包与安装验收在 Windows 本机执行。

## 1. 准备

- 使用 Windows x64 和 x64 Node.js 24+（包含 npm）；需要网络下载锁定依赖、Electron、打包工具与媒体包。若原生依赖缺少适用的预编译包，按实际报错补齐对应编译环境。
- 将完整 `source.zip` 解压到可写目录，保留 `host/`、`plugins/`、清单和说明的相对位置。路径可以含空格；避开正在同步或被其他应用写入的目录。
- 从源码套件根目录打开 PowerShell，确认 `node --version`、`npm --version` 与 `node -p "process.platform + ' ' + process.arch"`。最后一项必须是 `win32 x64`。缺少环境时先向朋友说明，不自动改全局安全设置。
- 使用新解压目录构建，不复制别的系统的 node_modules，不在维护者日常工程或个人仓库里执行测试。初始无需手工运行 configure、逐插件安装或设置 catalog。

## 2. 一条命令

```powershell
node .\host\scripts\release\build-trial.mjs windows
```

也可运行 `host/scripts/release/windows-build.ps1`。Node 入口不需要修改 PowerShell 执行策略。已进入 host 时可用 `npm run trial:windows`。

流程会：核对源码清单与环境 → 安装宿主及有锁文件插件的依赖 → 类型检查和平台回归 → 打包全部插件 → 生成附带 catalog → 构建应用 → 准备校验过的媒体工具 → 生成 Windows 安装程序和 ZIP → 启动打包应用导入新文件并验证重启 → 生成记录及摘要。

插件根目录可以另行配置 `RM_PLUGIN_SOURCES`，用于维护开发；锁定的源码套件只允许使用包内插件路径。构建不会启用仓库开发目录，也不会预授权 MCP。

每次运行输出一个全新目录：

```text
host/artifacts/trials/0.1.0-windows-<运行标识>/
  applications/              # setup.exe、ZIP、win-unpacked 验收目录
  bundled-plugins/           # 实际进入应用的 12 个包及清单
  optional-plugins/          # 7 个独立安装包与插件说明
  Huoye-0.1.0-plugins.zip     # 与独立安装包字节一致的合集
  插件功能清单.md
  plugins.json
  Windows试用说明.md
  Windows-AI构建指南.md
  build-result.json
  SHA256SUMS.txt
  logs/                     # 按阶段编号
```

`build-result.json` 只有在打包应用冒烟通过后才标记 `built-and-smoke-tested`。`manualAcceptance: pending` 表示还需下一节人工验收；`licenseReview: pending` 表示项目授权与完整第三方材料尚待落实。本流程不上传、推送或发布。

## 3. 在朋友机器上验收

自动冒烟使用临时仓库和独立 RM_USER_DATA，覆盖新图片、PDF、音视频导入加工、文字、标签、搜索、改名撤销、公共工具示例包安装和重启。它启动的是 win-unpacked，不能代替安装器验收。

请朋友实际运行 setup.exe 安装到用户目录（或解压 ZIP），再启动应用，做一次：创建测试仓库 → 拖入几份可丢弃文件 → 查看图片／PDF／音视频 → 标签与笔记 → 切换表格／分屏 → 关闭重开。确认附带功能及默认选择符合清单，再安装一个可选包。旧仓库仍沿用已有启停选择，不据此判断新仓库默认项。

记录安装方式、Windows 版本／架构、完成的步骤和异常。试用说明包含数据备份与原件处置边界。不要使用个人日常仓库做删除、恢复和失败注入验证。

## 4. 失败时如何处理

- 环境或源码完整性检查失败发生在安装之前，终端会直接说明；核对是否完整解压、Node 架构正确，是否误改源码。
- 某阶段失败后停止，查看终端给出的 `build-result.json` 和对应 `logs/NN-*.log`，后续步骤不会执行。修复环境后重新运行会使用新输出目录；旧失败输出保留供排查。宿主 out 和 node_modules 是构建中间目录，同一源码目录不要并行构建。
- Electron 下载停在 `Downloading Electron binary...` 时检查网络。可选在当前终端设置 `$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'` 后重试；不改仓库锁文件，不关闭 checksum 校验。
- FFmpeg 下载失败时，可取得 `host/packaging/media-lock.json` 指定的同版 ZIP，在 host 运行 `node scripts/release/prepare-media.mjs --archive "下载文件的路径"`，然后重试。校验不符说明不是本版内容，应停止。
- npm 缓存或网络问题可以修复下载环境；不要以升级依赖、删除锁文件、跳过测试或改平台检查的方式让流程显示成功。确实需要源码修复时反馈最小复现与建议，纳入维护工程后重新出包。
- 反馈提供：源码 host 提交、系统／Node／npm 版本、失败阶段、相关日志末尾与预期行为。日志可能包含本机路径，分享前检查；不上传个人仓库、令牌、模型密钥或整个用户配置目录。

## 5. 其他系统能做什么

macOS/Linux 可运行 `node host/scripts/release/build-trial.mjs prepare`，完成依赖、插件包、类型检查、平台回归和应用编译，结果为 `prepared-not-packaged`；不会产生或声称验证了 Windows 安装包。这一阶段用于维护侧提前发现公共构建问题。
