# 原生依赖许可来源

- `sharp-libvips-1.3.4-NOTICES.md`：从 [sharp-libvips v1.3.4](https://github.com/lovell/sharp-libvips/blob/v1.3.4/THIRD-PARTY-NOTICES.md) 原样保留。各组成库及确切版本由安装包内对应 `versions.json` 记录。
- `GPL-3.0.txt` / `LGPL-3.0.txt`：GNU GPLv3 / LGPLv3 正文，从 [GCC COPYING3](https://github.com/gcc-mirror/gcc/blob/master/COPYING3) 与 [COPYING3.LIB](https://github.com/gcc-mirror/gcc/blob/master/COPYING3.LIB) 保留。
- `canvas-1.0.9-skia-LICENSE`：canvas v1.0.9 所固定的 [Skia a9c42c9](https://github.com/google/skia/tree/a9c42c9fce77cd748805df0ec67ef5718800b1e9) 的版权与 BSD 许可。canvas 的版本、Rust 锁文件及构建配方见 [canvas v1.0.9](https://github.com/Brooooooklyn/canvas/tree/v1.0.9)。

以上第三方材料不改授为项目的 Apache-2.0。构建时由 `licenses:prepare` 连同实际 npm 依赖的许可文件、PDF 字体 / WASM 许可与 Chromium 许可汇总到安装包的 `licenses/`。
