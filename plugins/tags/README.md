# 标签基础 2.0.1

共享素材标签、详情打标、导入 `tags.add/tags.set` 和 MCP `update_tags`。素材上的 `tags.values` 格式与原值保持；不再提供分组界面和分组命令。

更新时同时安装 `tags` 2.0.0 和 `tag-groups` 1.0.0，统一勾选后应用重载；需要层级时再启用 `tag-tree` 1.0.0。两个业务插件都依赖本基础插件。宿主须支持 `facet-identity-v1`；层级另需 `query-subtree-v1`。

公开数据／操作契约、旧分组接续和限制见 [CONTRACT.md](CONTRACT.md)。原 `tagGroups` 仅为接续保留，不由基础继续编辑。全库标签改名、独立显示名、跨父级同名身份暂未实现。

`npm ci`；设置 `RM_PLUGIN_TOOLCHAIN` 或本机 `.rm-dev.json`；`npm run check` / `npm run pack`。输出 `artifacts/tags.rmplugin`。依赖编入包，用户无需 npm。许可证随包。

## 数据清理（2.0.1）

声明 `data-lifecycle-v1`。新版成功启用登记后，停用并重载，可在设置的数据维护中预览清理 `tags` 属性和本插件拥有的旧 `tagGroups` 管理记录。原文件、素材身份、其他数据块保留；分组与父子关系属于独立插件，保存视图的条件也不会代删。只有 tags 的独立空壳或有混合数据／保留引用的记录，宿主会保守保留并说明，不能承诺一律清零。日常停用与卸载仍保留数据。

## AI 操作权限

本版声明 `operation-effects-v1`，需要支持该特性的宿主。打标属于 `data`，允许 `organize`／`admin` 连接执行。安装后还须在目标仓库启用新版本；旧包不会因宿主升级自动获得声明。
