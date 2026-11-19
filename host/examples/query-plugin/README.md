# 业务只读查询示例

纯核心插件，无 UI、数据块和写操作。演示 `demo-query.overview`（素材和文件计数）、`demo-query.file_formats`（扩展名分布、前缀过滤和分页）。

在宿主根目录运行：

```sh
npm run plugin:pack -- examples/query-plugin artifacts/plugins/query-example.rmplugin
```

也可把此目录复制到项目外，再把其绝对路径作为打包器第一个参数。无需在示例中安装 MCP SDK。安装并在当前仓库启用、重载后，通过 `describe_library.queries` 发现。

完整协议、限制和 AI 调用示例见 [插件业务只读查询](../../docs/plugins/插件业务只读查询.md)。本示例依赖支持 `business-queries-v1` 的宿主；没有数据变更，停用后仅撤下两个查询。
