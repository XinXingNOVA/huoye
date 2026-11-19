# 插件示例

示例用于复制、学习和验证，不加入应用默认功能或发行清单。

- [file-editor](file-editor/README.md)：纯 UI 外部插件，使用公共文件编辑协议准备／确认原件新版或独立副本。
- [reviewmemo](reviewmemo/plugin.json)：内部目录声明示例，复制到 `src/plugins/` 后由生成器发现。
- [local-plugin](local-plugin/plugin.json)：可信外部包，包含数据块、命令、UI、样式和资源。
- [query-plugin](query-plugin/README.md)：纯业务只读查询包，包含 MCP 接入示例。
- [transaction-plugin](transaction-plugin/README.md)：导入时检查引用目标、命令内移入回收站的最小容器示例。

```sh
npm run plugin:pack -- examples/local-plugin artifacts/plugins/local-example.rmplugin
npm run plugin:pack -- examples/query-plugin artifacts/plugins/query-example.rmplugin
```

实际开发可复制到项目外再使用公共打包器；真实 Electron 验收使用示例副本，不能让会修改源码的验证流程指向正在维护的插件。具体命令见[外部包指南](../docs/plugins/插件开发指南.md)和[业务查询](../docs/plugins/插件业务只读查询.md)。
