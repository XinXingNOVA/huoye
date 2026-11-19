# 笔记插件

随应用附带的独立包，保留原有 `note.text` 数据定义。界面编辑、导出和 MCP 写操作都由本插件提供。

1.0.3 提供 `set_note` 操作：传入素材 `id` 和 `text`，写入或替换笔记；纯空白文本删除笔记，其他文本原样保存缩进及换行。只修改笔记块，可撤销，不改原文和其他数据。

建议先 `read_item`，限定 `kinds: ["note"]`，把返回字段的 `seq` 作为 `expectedSeq`。没有笔记时传 `null`；省略表示不检查版本。版本不符返回 `NOTE_CHANGED`，重新读取后再决定是否写入。使用 `execute_operation` 调用，超时重试沿用同一 `requestId`，新意图使用新 ID。

在本插件目录运行 `npm run pack`；日常迭代也可使用[插件开发模式](../../host/docs/README.md)。仓库需启用新版笔记，MCP 写入需 `organize` 权限；调用前重新 `describe_library` 获取实际声明。

支持 `ingest-metadata-v1` 导入能力 `note.initial`，输入 `{ text: "说明" }`，只补充缺失／空白笔记，保留不同的旧笔记并返回 `preserved`。文本空白与换行原样保存，不改持久结构；覆盖仍使用 `set_note`。更新宿主并在仓库选择新版，使用见[导入附加内容](../../host/docs/README.md)。

## 独立开发

运行 `npm ci` 安装本工程依赖；设置 `RM_PLUGIN_TOOLCHAIN` 为宿主工程，或在未提交的 `.rm-dev.json` 中指定 `toolchain`。`npm run configure` 生成本机编辑器 SDK 路径；`npm run check` 检查公共 API 边界和类型（也会刷新 SDK 路径），`npm run pack` 输出 `artifacts/note.rmplugin`，`npm run dev` 监听源码。应用按仓库选择本目录，勾选后应用并重载。插件 ID／数据不因目录位置改变。

宿主集成验证由宿主可选测试套件负责；本工程不复制宿主私有测试框架。

## AI 操作权限

本版声明 `operation-effects-v1`，需要支持该特性的宿主。填写笔记属于 `data`，允许 `organize`／`admin`；使用 `expectedSeq` 保护已读取的内容。安装后还须在目标仓库启用新版本；旧包不会因宿主升级自动获得声明。
