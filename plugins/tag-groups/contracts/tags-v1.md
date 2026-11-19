# 标签共享契约 v1

标签基础由 `tags` 2.0.0 提供。业务插件声明 `requires: ["tags"]`，不重复登记 `tags`，不复制基础的写入业务。第一次接入需同时更新基础和业务包；现有依赖检查只校验插件 ID，没有版本范围协商，因此不要把新分组包与 tags 1.x 混用。

## 数据与身份

- `tags.values: string[]` 是素材上明确打出的标签。沿用已有字符串键，大小写敏感；不改旧值、不自动补母标签。
- 第一版标签名称同时是全库唯一键：不同父级不能有两个同名但不同身份的标签。不存在全局改名／合并标签入口；以后引入独立身份与显示名时，须统一迁移素材标签、关系和已保存条件，不能只改某个界面。
- 关系中的空标签是对应插件的目录节点，不会凭空给素材打标。基础词表只统计实际使用值；详情打标继续查询全库，也允许输入尚未使用的文字键。
- `tag-groups.groups` 是分组插件的管理记录，包含稳定分组 ID、名称和 `tags` 列表；`tag-tree.node` 是层级插件的管理记录，包含 `tag` 和可选 `parent`。各自登记，各自维护，互不解释对方的数据。
- 两者只组织同一批标签，不管理或删除素材本身。分组成员关系不参与层级查询；父子移动不修改分组。

## 共享操作与查询

`host.core.run('tags', 'update', { ids, add?, remove? })` 批量打标，最多 100 项，同批成功／失败，可撤销。MCP 对应 `update_tags`，使用 requestId 幂等。导入继续使用 `tags.add` / `tags.set`，规则不变。

`executeQuery({query:'tags.list_tags', args:{prefix?}, limit?, cursor?})` 返回 `tag/materialCount`，不再夹带分组信息。精确筛选仍是 `{op:'eq',kind:'tags',field:'values',value:tag}`；公共 `facet` 可按当前查询范围统计。

分组的命令和查询属于 `tag-groups`：`createGroup/renameGroup/deleteGroup/moveTag/importLegacy`；MCP 操作名沿用 `create_group/rename_group/delete_group/move_tag`，查询改为 `tag-groups.list_groups/list_tags`。

层级属于 `tag-tree`：`setParent({tag,parent:null|string})`、`remove({tag})`；MCP 为 `tag_tree_set_parent/tag_tree_remove`。删除节点提升直接子节点一级，素材标签不变。`tag-tree.list_nodes` 每批 50 项，返回 `nodes/nextCursor`；其游标是目录底层搜索游标，放在 `args.cursor` 继续读取。`tag-tree.branch({tag,scope?})` 返回去重计数和可直接交给搜索／保存视图的动态 Query。

## 刷新与界面

观察公共 `changed/listChanged` 事件，重新读取权威数据；不把其他插件的 DOM、内部状态或文件目录当接口。同字段的独立分面声明不同 `FacetDef.id`，筛选仍作用于共同的 `tags.values`。普通单选替换本字段临时条件；⌘/Ctrl 多选叠加条件。保存视图的基础条件不被清除。

分组与层级可以同时显示，也可按仓库只启用一种；停用关系插件保留数据。层级定义停用时，已保存的分支查询明确报关系不可用，不扩大查询、不假装变成精确标签查询。

## 旧分组接续（COMPAT，独立于新协议）

基础暂保留原 `tagGroups` 定义和旧备份。tag-groups 1.0.1 起不再自动读取回退：没有独立分组记录时，界面提供“导入旧分组”，MCP 可调用 `import_legacy_groups`（参数 `{}`，需要 requestId）。该操作复制最早一份备份，保持组 ID 与素材标签，可整体撤销；存在任何独立分组记录时拒绝覆盖。撤销后回到空目录，不自动显示备份。

清除 tag-groups 数据后重新启用不会复活旧组，用户仍可主动重新导入。备份属于 tags，只有基础插件的显式数据清理才有权处理；关系插件不能代删。现有独立分组无需迁移，普通停用和卸载继续保留数据。
