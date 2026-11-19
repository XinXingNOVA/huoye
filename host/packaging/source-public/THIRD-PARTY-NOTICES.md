# 第三方组件与许可说明

活页Huoye 自有源码与本版官方插件采用 [Apache-2.0](LICENSE)。第三方代码、字体和原生库保留各自的版权与许可证，项目许可不覆盖这些组件。品牌图形与截图不视为第三方素材的再授权。

## 本批 macOS 产物

安装包在 `活页Huoye.app/Contents/Resources/licenses/` 中附带 `LICENSE`、本说明、依赖清单及许可原文。构建命令按已安装的锁定依赖生成这些文件；Electron 的 `LICENSES.chromium.html`、PDF.js 的字体 / CMap / WASM 许可一并保留。

| 组件 | 许可与来源 |
| --- | --- |
| Electron / Chromium | Electron MIT；Chromium 及其第三方代码见随包 `LICENSES.chromium.html` |
| React、React DOM、MCP SDK、better-sqlite3、markdown-it、KaTeX、turndown、ulid、zod、fflate | 各包附带的许可原文，主要为 MIT |
| sharp | Apache-2.0；预编译 libvips 与其依赖另按各自许可提供 |
| @img/sharp-libvips-darwin-arm64 | 当前锁定 1.3.4（libvips 8.18.7），分发包声明 LGPL-3.0-or-later；组成库及许可见其随包 README |
| @napi-rs/canvas | MIT；原生绘图使用 Skia，保留上游原生依赖声明 |
| pdfjs-dist | Apache-2.0；字体、CMap、JPEG2000 / JBIG2 等另附各自许可 |
| EPUB 的 @xmldom/xmldom、parse5、entities | 以可选插件合集中的许可原文为准 |

## 原生组件源码与替换

- sharp / libvips 的精确库版本见随包依赖清单和 `versions.json`。对应构建配方、版本与源码下载入口由 [sharp-libvips v1.3.4](https://github.com/lovell/sharp-libvips/tree/v1.3.4) 提供，其中 [构建脚本](https://github.com/lovell/sharp-libvips/blob/v1.3.4/build/posix.sh) 列出组件来源；[许可列表](https://github.com/lovell/sharp-libvips/blob/v1.3.4/THIRD-PARTY-NOTICES.md) 对应本构建。
- libvips 以独立动态库随 `@img/sharp-libvips-darwin-arm64` 安装，未封入 ASAR。可以使用兼容 ABI 的自编译库替换；不限制为调试这些库的修改而进行逆向工程。修改应用包后需自行处理本机签名。
- canvas 原生模块的源码与构建说明见 [@napi-rs/canvas](https://github.com/Brooooooklyn/canvas/tree/v1.0.9)，其中 Skia 固定为 `a9c42c9fce77cd748805df0ec67ef5718800b1e9`。其他依赖的精确版本与上游位置见随包清单及各工程的 `package-lock.json`。

## macOS 外部媒体工具与 Windows 状态

本批 macOS 安装包不携带 FFmpeg；音视频加工使用用户本机已有的 `ffmpeg` / `ffprobe`。这些外部程序的分发及许可遵循其各自来源。

Windows 发行暂缓。构建配置保留 FFmpeg 8.1.2 的锁定下载信息，但本批不分发该二进制，也不把二进制 ZIP 当作对应源码。恢复 Windows 发行前须核对 GPL-3.0-or-later 文本、精确来源、构建配置及包含相关依赖的对应源码获取方式，并完成目标系统验收。
