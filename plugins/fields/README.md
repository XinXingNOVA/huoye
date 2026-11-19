# 自定义字段插件

当前版本：`1.4.1`。1.4.1 块分面改用 `source: blocks`、`blockFacetQuery`、`setHasFilters` 与 `core.kindCounts`（需要 `block-facets-v1` 宿主）；一次批量统计，范围切换清旧值，失败可重试，隐藏时暂停；单击替换、Cmd/Ctrl 多选一次更新。1.4.0 将「模板」从左侧「导航」迁入「筛选」上下文面板（`facets` + `scoped-facets-v1` + `facet-identity-v1`）：浏览态默认统计当前集合／文件夹／视图范围内的模板素材数并支持单击按模板筛选（`⌘/Ctrl` 叠加多模板筛选，右侧 `⊞` 按钮直接打开模板表格视图），「整理」态支持查看与管理全库模板、新建／从标签升级、双击改名、编辑字段与删除。1.3.1 表格协作迁入 `table.tools` v1；需要支持 `ui-extension-points-v1` 的宿主。插件 ID、模板及字段 ID、数据定义和写入命令保持，正式更新选择新包，开发模式可沿用同版本反复构建。

随应用附带的外部包 `fields`。新仓库推荐按需启用；旧仓库按原选择交接一次。

模板以 `template` 管理记录保存在仓库；每份模板生成稳定的 `tpl:<模板身份>` 附加块。侧栏、检查器和表格通过公共 UI 接口呈现，字段创建、改名、类型转换、选项整理与模板删除通过核心命令完成，支持预演及整体撤销。表格是可选协作，未启用表格仍可在检查器编辑字段；停用字段后模板和值只读保留。

```sh
npm run pack
```

包不依赖宿主私有模块或另一个插件的源码，无额外第三方运行依赖。`plugin.json.definitions` 与 `core.ts` 的 `defines` 声明一致；宿主 `packaging/plugins/fields/distribution.json` 仅为应用发行策略，不随分享包授予权限。宿主对旧 ID 和前缀授权，其他开发者使用自己插件的 ID 与前缀。

开发契约、兼容限制及验证命令见[插件开发指南](../../host/docs/README.md)与[公共后端 API](../../host/docs/README.md)。

支持功能分类、关键词与使用入口；只调整目录信息和说明，持久定义不变。已绑定旧版的仓库不自动切换版本；新元信息需要更新后的宿主。

1.1.0 将详情中的每个模板作为独立分区交给宿主管理，支持排序与折叠，添加模板另设入口；数据定义和命令不变。使用新的 `blockSections` 公共贡献，并声明 `uiFeatures: ["block-sections-v1"]`，须先更新宿主。已有仓库在“应用 → 插件包”安装新版，再到“当前仓库”选择 1.1.0，统一应用并重新加载；不自动改换旧绑定。旧 1.0.x 仍按整组模板呈现。

## 独立开发

运行 `npm ci` 安装本工程依赖；设置 `RM_PLUGIN_TOOLCHAIN` 为宿主工程，或在未提交的 `.rm-dev.json` 中指定 `toolchain`。`npm run configure` 生成本机编辑器 SDK 路径；`npm run check` 检查公共 API 边界和类型（也会刷新 SDK 路径），`npm run pack` 输出 `artifacts/fields.rmplugin`，`npm run dev` 监听源码。应用按仓库选择本目录，勾选后应用并重载。插件 ID／数据不因目录位置改变。

宿主集成验证由宿主可选测试套件负责；本工程不复制宿主私有测试框架。

## 表格协作依赖

本插件只声明 `extensions` 中的 `fields.template`，目标为 `table.tools` v1、顺序 10；不再登记旧 `tableTools`。表格停用时只撤下协作，检查器、模板与数据保持。

`@resource-manager/table-contract` 是表格工程公开的纯类型包；其 1.0.0 归档随本工程保存在 `vendor/`，由 `package-lock.json` 校验完整性。来源为 `table/contract`，通过 `npm pack` 生成；不手工修改解包后的类型，也不从表格内部源码导入。它不是新的运行插件或后台依赖，不会把表格实现打入字段包；单独分享本工程也能按锁文件安装。

表格协作至少需要 table 1.2.0，当前建议配合 1.3.0。宿主旧表格接口已退役，仍用旧 1.1.x 包时应先升级插件再升级宿主；已有新版包无需重复安装。其他插件可通过公开契约贡献自己的结构工具。

## 独立编辑模板（1.3.0）

无需启用表格插件：导航中模板名称旁的编辑按钮，或素材详情中模板分区的“编辑模板”，均可打开独立编辑器。新建模板后直接进入编辑器。

- 修改模板名称；新增字段、字段改名、修改类型、管理选项和删除字段。
- 点击字段行展开配置；名称和新选项明确保存，每次操作沿用现有事务命令和撤销。
- 修改类型、删除字段先显示影响范围，确认后才执行；影响所有挂着该模板的素材，包括回收站记录。未保存输入关闭后不保留。
- 原表格增列和字段菜单继续可用，与独立编辑器共用 `field-controls.tsx`，不会维护第二套结构演变规则。

字段 ID、模板 ID、数据格式和 `table.tools` v1 契约保持。表格选列只调整显示，不改变模板结构；右侧详情仍可独立附加模板、填写字段。通过检查和打包；宿主现有隔离 Electron 集成回归覆盖表格停用后的新增、改名、选项管理、删除预演／撤销、新建模板直达、导航入口、窄窗口与原表格快捷编辑。未验证 Windows 实机或任意第三方表格。

## 数据清理（1.3.1）

补充 `data-lifecycle-v1`，不改变模板及字段数据格式。新版成功启用登记后，停用并重载，可在设置的数据维护预览删除 `template` 记录及 `tpl:*` 动态字段和定义；原件、素材与其他插件的数据保留。有混合数据或保留引用的模板由宿主保留并报告，不做跨插件级联删除。

保存视图的字段条件和表格列设置属于使用方，不随模板清理；已删除字段可能显示为不可用，可在对应视图调整。普通停用／卸载继续只读保留模板和值。结构记录只有数据实际清空后才会重置。

## AI 接入

支持 `operation-effects-v1` 声明，需要支持该特性的宿主。先通过 `describe_library` 发现操作；模板是 `template` 管理记录，可用 `search_items`（`scope:all, role:management, has:[template]`）和 `read_item` 查看。

- `fields_create_template`、`fields_rename_template`、`fields_add_field`、`fields_rename_field`、`fields_add_option` 属于 `structure`，需要 admin。创建模板返回 template/kind，创建字段返回稳定 field ID。
- `fields_set_values` 属于 `data`，允许 organize/admin。传 template 和最多 100 条 items，每条为 `{id, expectedSeq, values}`；values 按稳定 field ID 填值，未提供的字段保留，null 清除。无模板块时 expectedSeq=0，否则使用 read_item 返回的块 seq。禁止重复素材，校验类型和已有选项，整批失败回滚；重试复用 requestId。

首批只开放上述结构操作，不通过 MCP 开放删除模板／字段或类型转换。日常 UI 保持原有结构编辑功能。安装新版本后须在目标仓库启用；套件本体不默认附加自定义字段。
