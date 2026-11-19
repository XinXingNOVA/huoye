# 独立插件维护

源码、依赖、业务测试和产物归本工程。仅导入公开的 `@resource-manager/plugin-api/…`，不得引用宿主私有源码或测试夹具。宿主位置由 `RM_PLUGIN_TOOLCHAIN` 或本机 `.rm-dev.json` 指定。运行 `npm ci`、`npm run check`、`npm run pack`；已有独立测试时运行 `npm test`。通过开发目录在临时仓库验证真实集成。公共能力缺口交核心维护者，先复现再协商。正式分享改变包内容应升级版本，插件 ID 与已有数据定义保持。
