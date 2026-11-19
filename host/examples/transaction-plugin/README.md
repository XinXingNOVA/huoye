# 容器事务示例

这是公共接口的最小验证包，不是完整 Collection 功能，没有专用视图，也不随应用安装。

从项目根运行：

```sh
npm run plugin:pack -- examples/transaction-plugin artifacts/plugins/transaction-example.rmplugin
```

更新宿主后手动安装并在测试仓库启用。AI 先 `describe_library`，再通过 `execute_operation`：

1. `demo_container_create`，`args: { "title": "测试容器" }`，取得 `result.id`。
2. `import_files`，`args: { "files": [{ "path": "/绝对路径/文件.txt", "metadata": { "demo-container.join": { "group": "上一步的ID" } } }] }`。
3. `demo_container_trash`，`args: { "id": "容器ID" }`，验证容器回收但关联成员保留；应用内撤销可恢复。

每次写入传目标 `libraryId` 和新的 `requestId`，超时重试沿用原 ID 与参数。只读权限不能执行这些写操作。可以通过 `search_items` 的 ref 字段条件查成员，或通用数据详情查看关系。

新公共能力及生命周期见[事务内引用检查与回收](../../docs/plugins/事务内引用检查与回收.md)。本例不实现排序、未分组解释、封面或导出；正式业务不能把示例当作完整组管理器。
