# 来源插件

随应用附带的独立包，保存来源 URL、页面标题与站点，提供详情、网站筛选和接入补全。保持既有 `source` 数据定义，停用不删除记录。

支持 `ingest-metadata-v1` 导入能力 `source.initial`，输入 `{ url: "https://example.com", title: "原文" }`（标题可省略）。新建、已有和恢复的素材都只在缺少网址时补充来源；已有来源保留，不覆盖网址或标题，返回 `unchanged` 或 `preserved`。网址只接受 HTTP/HTTPS，不抓取网页。

旧 `input.source` 提示仍只为新建素材记录来源；显式 `metadata['source.initial']` 存在时优先交给新处理器。显式输入错误会在复制前拒绝，不静默退回旧提示。

在本插件目录执行 `npm run pack`。更新宿主后，在当前仓库选择新版并应用重载；自动化先 `describe_library` 获取契约。调用、事务与撤销规则见[导入附加内容](../../host/docs/README.md)。

## 独立开发

运行 `npm ci` 安装本工程依赖；设置 `RM_PLUGIN_TOOLCHAIN` 为宿主工程，或在未提交的 `.rm-dev.json` 中指定 `toolchain`。`npm run configure` 生成本机编辑器 SDK 路径；`npm run check` 检查公共 API 边界和类型（也会刷新 SDK 路径），`npm run pack` 输出 `artifacts/source.rmplugin`，`npm run dev` 监听源码。应用按仓库选择本目录，勾选后应用并重载。插件 ID／数据不因目录位置改变。

宿主集成验证由宿主可选测试套件负责；本工程不复制宿主私有测试框架。
