# 看板

当前版本：`1.1.0`。需要支持 `browsing-layout-v1` 的宿主。“显示”面板将尺寸标为“列宽”；保存分列选项、横向位置及各字段／列的素材锚点，列内打开按该列顺序导航。 更新包后沿用原插件 ID、仓库视图与配置。

按一个单选字段分列，拖动换列

## 独立开发

运行 `npm ci` 安装本工程依赖；设置 `RM_PLUGIN_TOOLCHAIN` 为宿主工程，或在未提交的 `.rm-dev.json` 中指定 `toolchain`。`npm run configure` 生成本机编辑器 SDK 路径；`npm run check` 检查公共 API 边界和类型（也会刷新 SDK 路径），`npm run pack` 输出 `artifacts/kanban.rmplugin`，`npm run dev` 监听源码。应用按仓库选择本目录，勾选后应用并重载。插件 ID／数据不因目录位置改变。

宿主集成验证由宿主可选测试套件负责；本工程不复制宿主私有测试框架。
