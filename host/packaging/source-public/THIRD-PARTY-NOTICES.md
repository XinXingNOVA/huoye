# 第三方组件与许可说明

活页Huoye 自有源码与本版官方插件采用 [Apache-2.0](LICENSE)。第三方代码、字体和原生库保留各自的版权与许可证，项目许可不覆盖这些组件。品牌图形与截图不视为第三方素材的再授权。

## 本批 macOS 产物

安装包在 `活页Huoye.app/Contents/Resources/licenses/` 中附带 `LICENSE`、本说明、依赖清单及许可原文。构建命令按已安装的锁定依赖生成这些文件；Electron 的 `LICENSES.chromium.html`、PDF.js 的字体 / CMap / WASM 许可一并保留。

| 组件 | 许可与来源 |
| --- | --- |
| Electron / Chromium | Electron MIT；Chromium 及其第三方代码见随包 `LICENSES.chromium.html` |
| React、React DOM、MCP SDK、better-sqlite3、markdown-it、KaTeX、turndown、ulid、zod、fflate、主题 SVG 解析用的 @xmldom/xmldom | 各包附带的许可原文，主要为 MIT |
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

## 内置主题预览中的图像

- [Hinge on blue dumpster](https://commons.wikimedia.org/wiki/File:Hinge_on_blue_dumpster.jpg) · CC0.
- [Man posting an advertisement for La publicité en France par Emile Mermet](https://commons.wikimedia.org/wiki/File:Man_posting_an_advertisement_for_La_publicit%C3%A9_en_France_par_Emile_Mermet.jpg) · 公有领域.
- [Ethel Franklin Betts, Save the Survivors, 1918 Cornell CUL PJM 2029 01](https://commons.wikimedia.org/wiki/File:Ethel_Franklin_Betts,_Save_the_Survivors,_1918_Cornell_CUL_PJM_2029_01.jpg) · 公有领域.

「活页 · 标准」与「银盐画册」的预览包含以下照片的缩小展示。含这些照片的预览图按 [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/) 提供。

- Daniel Schwen · [Great Sand Dunes NP 1](https://commons.wikimedia.org/wiki/File:Great_Sand_Dunes_NP_1.jpg)
- Norbert Nagel · [07-17-2012 - Emborio - Emporio - Santorini - Greece - 11](https://commons.wikimedia.org/wiki/File:07-17-2012_-_Emborio_-_Emporio_-_Santorini_-_Greece_-_11.jpg)
- Berrucomons · [2909 vallon moy res](https://commons.wikimedia.org/wiki/File:2909_vallon_moy_res.jpg)

## 两款外部主题的预览图

蓝晒、银杏·秋光的工作台预览中包含以下照片的缩小展示，以及上文所列的两幅公有领域海报。含这些照片的合成预览按 [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) 提供。

- Godot13 · [Czech-2013-Prague-Astronomical clock face.jpg](https://commons.wikimedia.org/wiki/File:Czech-2013-Prague-Astronomical_clock_face.jpg) · [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/)
- Dietmar Rabich · [Amboy (California, USA) -- 2012 -- 4.jpg](https://commons.wikimedia.org/wiki/File:Amboy_%28California,_USA%29_--_2012_--_4.jpg) · [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/)
- Berrucomons · [2909 vallon moy res.jpg](https://commons.wikimedia.org/wiki/File:2909_vallon_moy_res.jpg) · [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/)
- Kreuzschnabel · [2013 Rainbow over Washfold.jpg](https://commons.wikimedia.org/wiki/File:2013_Rainbow_over_Washfold.jpg) · [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/)
- Kreuzschnabel · [2014 Track on Fremington Edge.jpg](https://commons.wikimedia.org/wiki/File:2014_Track_on_Fremington_Edge.jpg) · [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/)
- Kreuzschnabel · [2015 Ribblehead Viaduct 1.jpg](https://commons.wikimedia.org/wiki/File:2015_Ribblehead_Viaduct_1.jpg) · [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/)
- Kreuzschnabel · [2015 Swaledale from Kisdon Hill.jpg](https://commons.wikimedia.org/wiki/File:2015_Swaledale_from_Kisdon_Hill.jpg) · [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/)
- Alvesgaspar · [Flower poster.jpg](https://commons.wikimedia.org/wiki/File:Flower_poster.jpg) · [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/)
