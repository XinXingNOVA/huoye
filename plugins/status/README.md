# 状态

待处理 / 进行中 / 已完成 / 搁置，卡片上显示状态

## 独立开发

运行 `npm ci` 安装本工程依赖；设置 `RM_PLUGIN_TOOLCHAIN` 为宿主工程，或在未提交的 `.rm-dev.json` 中指定 `toolchain`。`npm run configure` 生成本机编辑器 SDK 路径；`npm run check` 检查公共 API 边界和类型（也会刷新 SDK 路径），`npm run pack` 输出 `artifacts/status.rmplugin`，`npm run dev` 监听源码。应用按仓库选择本目录，勾选后应用并重载。插件 ID／数据不因目录位置改变。

宿主集成验证由宿主可选测试套件负责；本工程不复制宿主私有测试框架。
