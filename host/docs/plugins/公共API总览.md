# 公共 API 总览：按架构职责查找

核对日期：2026-11-09。本文按能力的**管理职责**分类，补充原有按后端、UI、服务编排的文档；保留现有名称、导入路径和调用行为。工作台属于应用宿主，但因页面与交互接口较多，单独列出。

## 先区分四件事

- **职责归属**：谁拥有规则与权威状态，如仓库拥有数据块，文件空间拥有原件版本。
- **作用范围**：应用、本机仓库、窗口、页面、素材或文件。按仓库隔离不等于写入仓库数据。
- **保存位置**：仓库数据库、空间数据库与文件、本机配置，或者只在内存。可恢复也不等于业务数据。
- **调用环境**：核心进程、窗口 UI、本机服务或外部 MCP。传输入口不决定职责归属。

`UiHost` 是窗口提供的组合门面，`host.core` 是绑定当前仓库的异步调用门面；两者都连接了多类能力。不能把所有 `host.core.*` 都当作只修改仓库的操作，也不能把所有 UI 调用都当作只改画面。当前没有另设 `host.application`、`host.library` 或 `host.spaces` 命名空间。

本机插件偏好使用 `host.localState`，属于应用宿主；默认按库隔离但不写入仓库。设置、密钥、UI 状态的显式清理也归宿主，和仓库数据清理分开。见[插件本机界面状态](插件本机界面状态.md)与[数据生命周期](插件数据生命周期.md)。

## 职责地图

| 分类 | 管理什么 | 常见作用范围 | 权威状态与保存位置 |
| --- | --- | --- | --- |
| 应用宿主 | 应用配置、包安装、本机程序、服务生命周期、MCP 授权及跨层流程 | 本机应用；部分服务按仓库启动 | 本机用户配置、安装目录和任务记录；跨层结果分别归对应层 |
| 工作台 | 页面、分屏、侧栏、选区、共享草稿、布局预设和界面动作 | 当前窗口／页面；本机偏好可按仓库身份隔离 | 内存、工作区存档、本机偏好；保存正文才进入仓库 |
| 仓库核心 | 素材身份、数据块、定义、查询、命令、收录关系、事务与加工 | 当前仓库；素材／数据块 | `library.db` 原始记录、`derived.db` 派生记录；当前撤销历史限本次运行 |
| 文件空间 | 文件身份、字节、版本、可用性、成员授权与原件处置 | 指定空间／文件／版本；可以有多个关联仓库 | 空间数据库、受管原件与历史版本；各库另存自己的接纳引用 |

选择器、共享编辑会话、预设目录都是宿主托管的不同服务，生命周期与持久化规则不同，不是一个任意共享存储容器。业务语义仍由插件提供。

## 契约的源码位置

按职责组织声明，保留现有组合入口。`CoreApi` 的分类是当前仓库连接内的分工，不把整个应用 API 都塞入仓库连接，也不为四类职责强建四套目录。

| 定义位置 | 内容与依赖方向 |
| --- | --- |
| [api/library.ts](../../src/shared/api/library.ts) | `LibraryApi`：身份、数据、查询、业务操作、插件启用、素材生命周期与加工调度 |
| [api/file-spaces.ts](../../src/shared/api/file-spaces.ts) | `FileSpaceApi`：经当前仓库身份查询空间事实、版本及原件处置；不是独立空间管理员接口 |
| [api/file-workflows.ts](../../src/shared/api/file-workflows.ts) | `FileWorkflowApi`：收录、关联、发布／接纳、独立副本与导出；保留各阶段失败和恢复边界 |
| [ingest-input.ts](../../src/shared/ingest-input.ts)、[item-lifecycle.ts](../../src/shared/item-lifecycle.ts) | 收录输入／字节限制及素材回收结果归独立领域契约；不反向依赖 RPC 组合定义 |
| [rpc.ts](../../src/shared/rpc.ts) → [core.ts](../../src/plugin-api/core.ts) | 前者组合 `CoreApi`、事件与消息，重导出已有名称；后者提供插件使用的异步 `CoreClient`，方法仍平铺 |
| [ui/contracts.ts](../../src/plugin-api/ui/contracts.ts) | `UiHost` 继续组合已有草稿、工作副本、预设等独立服务；各服务契约仍在对应 `ui/` 模块 |
| [local-service.ts](../../src/plugin-api/local-service.ts)、[service.ts](../../src/plugin-api/service.ts) | 外部本机服务与内部应用服务分别定义；运行环境和开放范围保持分离 |

新增 `shared/api` 文件用于维护宿主内部声明，**没有新增外部 SDK 导入别名**。插件继续从已发布入口取得 `CoreClient`、`UiHost` 等类型和宿主实例。`rpc.ts` 的重导出是保留的组合入口，不另存一份接口定义；各领域模块不反向导入它。

## 应用宿主

| 能力与现有入口 | 调用环境／开放范围 | 状态、读写影响与接入说明 |
| --- | --- | --- |
| `LocalServicePlugin.start`、`ctx.signal/onDispose`；UI 的 `host.service/streamService` | 外部包的仓库级 Node 服务；从当前仓库 UI 调用 | 按仓库启停，与面板显隐分开；流式通信不自动保存业务结果，也不跨退出恢复请求。[外部本机服务](外部本机服务.md) |
| `ctx.settings`、`ctx.secrets` | 外部服务内；按插件 ID 隔离 | `application` 跨库共用，`library` 按库路径隔离；两者均在本机配置，不在仓库文件夹，不进入素材撤销。服务即使使用 application 配置，也仍是仓库级实例。密钥不返回 UI。 |
| `host.fileEditing` | 仓库 UI；外部包可用，需声明能力 | 本机工作副本任务、选择编辑器与完成／放弃流程。可写磁盘并调用空间发布及仓库接纳；不是单纯 UI 状态。任务在本机 `userData/file-editing`，编辑器登记在 `local-editors.json`。[公共工作副本](公共工作副本.md) |
| `host.pluginPresets` | 当前仓库 UI；外部包需声明 `plugin-presets-v1` | 用户组合在本机 `userData/plugin-presets.json`，套件原版在 `plugin-suites.json`，跨库复用；候选选择只应用到当前仓库，有变化才重载，配套布局持久接续。不安装包、不改业务设置或 MCP 授权。[插件组合预设](插件组合预设.md) |
| 宿主开始页 `creation` 桥 | 宿主内部应用界面 | 无仓库预演、按方案建库、认领与失败接续；复用插件目录／选择和布局接续。未对外部插件或 MCP 开放新增创建权限。[按方案建库](本地插件套件.md#按方案新建仓库) |
| 包安装、卸载；应用设置和编辑器登记 | 宿主内部应用界面 | 包与静态套件安装属于本机应用；各库启用选择另存。套件打包与安装见[本地插件套件](本地插件套件.md)。外部包仅可经组合服务申请当前仓库启停，未开放安装／卸载其他包、任意注册 IPC 或直接使用 `window.bridge` 的通用接口。[插件开发指南](插件开发指南.md) |
| `ApplicationServiceContext.access`、`ApplicationUiHost.service` | 随应用编译的内置模块，**不是普通外部包 SDK** | 应用授权、建库和跨库路由；MCP 作为适配入口，显式选择目标仓库后复用业务协议。没有给普通插件或远端 AI 自助提权的入口。[服务 API](服务插件%20API.md) |

应用层组合流程，但不自行绕过核心事务改库，也不让界面直接改空间数据库。服务的异步网络请求与仓库同步命令分开；需保存结果时由业务通过核心写入。

## 工作台

以下接口由仓库窗口提供，外部 UI 在宿主挂载上下文内使用。声明贡献与运行时调用是两件事：插件声明页面或按钮，宿主负责实例、位置与生命周期。区域、容器、内容及上下文的完整查找表见[工作台 API 索引](工作区布局.md#工作台-api-索引)；文字标签或图标属于可替换呈现，不改变实例身份。

后续内容与容器解耦的语义约定见[容器与内容契约](../architecture/容器与内容契约.md)，外部容器注册尚未开放。

| 能力与现有入口 | 范围与保存位置 | 读写影响与接入说明 |
| --- | --- | --- |
| `host.open/openData/openTab/showView`；`UiPlugin.tabTypes/toolViews/opens` | 当前窗口、目标标签组；布局与页面存档在本机工作区 | 打开位置不决定数据所有权；默认打开器是本机偏好。页面业务保存由生命周期协调。[工作区布局](工作区布局.md)、[打开方式](打开方式.md)、[页面生命周期](页面生命周期.md) |
| `TabApi.context`、`toolViews.context / placement`；`PageContext` | 当前窗口／来源页面；能力在内存，位置与固定绑定在本机工作区 | 智能候选、拖出固定与按声明跨区停靠；定位不改变业务数据。[工作台 API 索引](工作区布局.md#工作台-api-索引) |
| `host.settings/openSettings`、`host.commands`；`settingsSections/commands/quickAction` | 当前窗口／来源页面；导航、表单退出检查和命令会话在内存 | 设置页面位置不决定配置归属；命令复用业务服务，不自动开放到 MCP。[设置与命令接入](设置与命令接入.md) |
| `host.workbenchPresets`、`host.openWorkbenchPresets`；`workbenchPresets/workbenchPresetUis` | 当前窗口；用户预设按本机仓库 ID 保存于 `localStorage` | 保存／切换布局，不复制素材或草稿。插件原版只读，用户副本可改；界面可替换。[工作台预设 API](工作台预设API.md) |
| `host.selection/revealContent`、`ContentSurface`；`selectionActions/contentLocations` | 窗口内临时选区及具体内容表面 | 选区本身不写仓库；摘录、提问等动作复制引用后自行保存结果。`ContentReference` 可序列化，但不会自动持久化。[公共选区](公共选区通道.md) |
| `host.editing`、`EditingSessions.open` | 窗口内按内容键共享；草稿随本机工作区恢复 | 当前支持字符串工作稿、分组撤销和保存协调；插件提供底稿校验与提交回调。编辑撤销与仓库事务撤销不同，尚无任意结构化编辑模型。[共享编辑会话](共享编辑会话.md) |
| `host.contextMenu/showDialog/notify`；`actions/creates/blockSections` 等贡献 | 当前窗口／交互场景 | 宿主安排呈现；回调若调用命令就会写库。`host.trash/purge/export` 等是带交互的业务入口，不能归为纯画面修改。[公共 UI API](公共UI%20API.md) |
| `UiPlugin.layouts`、`LayoutProps`、`ResourceCollection`、页面输入与角标 | 集合／页面；临时显示、本机默认、仓库保存视图分别管理 | 布局消费结果、选择和公共动作；不会因换排列就改素材。保存查询视图规则则写仓库。[浏览布局](浏览布局.md)、[公共集合与页面输入](公共集合与页面输入.md) |

正在使用的工作区存档为本机 `userData/workspaces/<libraryId>.json`；预设目录与之分开。按库保存只是隔离偏好，不代表随仓库复制、同步或导出。

`UiPlugin.extensionPoints/extensions` 与 `host.extensions` 属于工作台的静态 UI 协作目录：业务插件可提供自己的契约，其他插件提交载荷。目录不保存页面状态或写库；调用业务动作是否写入由该动作决定。公开模块 `ui/extensions` 提供类型与组件错误边界，见[插件自定义 UI 扩展点](插件自定义UI扩展点.md)。

## 仓库核心

UI 通过 `host.core` 异步调用；核心插件通过宿主给出的 `CommandContext`、`QueryContext`、加工或收录上下文调用。不能把 UI 的异步 RPC 当作同步命令里的数据库句柄。

| 能力与现有入口 | 作用范围／读写影响 | 规则与接入说明 |
| --- | --- | --- |
| `blocks`、`query` 类型；`CorePlugin.blocks/defines`、`host.core.kinds` | 本库定义及快照；动态定义由对应来源生成 | 插件声明语义，仓库保存可读结构；停用保留已有数据。[公共后端 API](公共后端%20API.md) |
| `get/query/facet/kindCounts/snippets`；`describeLibrary/searchPage/readItem/readContent` | 本库只读；使用记录、索引和内容读取协议 | 前一组适合 UI／业务基础读取，后一组提供外部读取形状。没有把空间全部文件自动当作本库素材。 |
| `CorePlugin.queries`、`executeQuery` | 插件业务级只读；按目标库启用集合发现 | 用业务语义封装通用读取，提供 schema、分页和有界上下文；不允许写入。[业务只读查询](插件业务只读查询.md) |
| `create/put/patch/remove`、`run/preview`；`commands/operations`、`executeOperation` | 当前仓库原始记录；同步命令一次事务／撤销 | 普通编辑不能改派生块或任意替换文件引用。operations 显式选择对外动作，并增加输入校验与持久请求回执，不复制命令实现。[公共后端 API](公共后端%20API.md) |
| `listHistory/readHistory`、`undo/redo`、`historyChanged` | 当前仓库核心会话；历史原始记录在 `library.db` | 有界保留与读取、请求关联和顺序撤销保护；无永久审计或任意历史回滚。MCP 仅开放读取。[操作历史](操作历史.md) |
| `databaseStorageInfo/compactDatabase` | 当前仓库 `library.db`；本机 UI 显式维护 | 查询逻辑页占用，手动回收空闲页；不删除数据、回执、任务或当前撤销，不开放 MCP。能力 `database-maintenance-v1`。[历史保留与整理](操作历史.md#自动保留与手动整理2026-11-06) |
| `trash/restore/purge`、`previewItemLifecycle/applyItemLifecycle` | 本库素材身份、数据块及依附关系 | 回收素材不删除空间原件；彻底删除不可撤销。空间原件处置另走自己的协议。[事务内协作](事务内引用检查与回收.md)、[仓库与文件空间](../architecture/文件空间.md) |
| `setPluginSettings` 等本库装配选择 | 本库插件启用／版本绑定；重载后生效 | 区别于应用安装包；停用不清数据。开发源码目录与本机包目录由宿主管理。 |
| `recognizers/ingestMetadata/afterIngest`；`systems`、`demand/regenerate`；`exporters/exportSections` | 收录初始块、派生结果、导出文件 | 各阶段有专门上下文；加工和导出可能读写文件，不能视为通用数据事务。收录元数据在本次事务内协作。[导入附加内容](导入附加内容.md)、[公共后端 API](公共后端%20API.md) |

MCP 只发布已授权目标库的通用读取、业务查询及显式操作，不能因为 UI 能调用某个 `CoreClient` 方法，就认定远端也能调用。调用目录以当前应用工具清单和目标库描述为准。

## 文件空间及仓库关系

文件空间能力目前部分经 `host.core` 的仓库上下文提供，部分仅在宿主独立空间管理界面提供。下列归属描述不新增权限或外部 SDK 入口。

| 现有入口 | 管理对象／读写影响 | 开放范围与边界 |
| --- | --- | --- |
| `listFileSpaces/listSpaceFiles/fileStorageInfo` | 空间事实与本库收录关系的只读组合 | 外部 UI 可经 `host.core` 使用。未收录、已回收、待接纳分别表达；本库已接纳版本和空间当前版本分别返回。[工作台接口](../development/文件空间工作台接口.md) |
| `host.url(reference)`；核心上下文 `ctx.abs(...)` | 经宿主解析文件引用 | 使用各上下文允许的引用，不能自行拼空间路径或将读取权解释为编辑权。固定版本预览不会创建素材，解除关联后不保证继续可读。 |
| `spaceFileHistory`、`restoreSpaceVersion` | 指定空间文件的版本记录；恢复操作会发布版本 | 经 `host.core` 调用，写入检查空间授权及基线。恢复历史版本不是仓库 undo。[公共文件编辑](公共文件编辑.md) |
| `prepareFileEdit/commitFileEdit`、`makeFileIndependent` | 空间发布／复制和本库引用接续 | 公共文件协议，输入输出类型见 SDK `files`；异步流程，有预演、请求 ID 与恢复规则。原件发布和本库接纳可能分别成功。 |
| `previewFileUpdate/acceptFileUpdate`、`adoptSpaceFiles` | 本库接纳新版／收录已有空间文件 | 写仓库关系与引用，不等于发布原件；接纳不要求空间的发布授权。 |
| `linkFileSpace/unlinkFileSpace/forgetFileSpace`、`setDefaultFileSpace`、导入策略 | 本库关联、空间成员关系及默认写入目标 | 这是仓库与空间之间的关系管理，解除关联不等于删除空间或所有素材。按对应预演及恢复规则调用。[仓库与文件空间](../architecture/文件空间.md) |
| `previewSpaceMutation/mutateSpaceFiles` | 指定空间原件及登记的处置 | 经当前仓库身份校验空间授权；区别于素材回收。系统废纸篓、空间记录管理和组合删除另按各阶段执行，不承诺整体可撤销。 |
| 独立空间创建／模式／成员授权、磁盘检查 | 空间本身及本机磁盘 | 当前使用宿主内部 `window.bridge.spaces`；不是外部插件入口。已有 MCP 文件动作是应用授权后的受控适配，不因此获得任意 bridge 访问。 |

本领域的详细规则见[仓库与文件空间](../architecture/文件空间.md)、[公共文件编辑](公共文件编辑.md)、[受控文件编辑](../development/受控文件编辑.md)。空间文件不是仓库素材，两者可以一对多关联，不按路径或文件名合并身份。

## 跨层流程如何组合

| 用户动作 | 应用层组合的步骤 | 不应混同的结果 |
| --- | --- | --- |
| 拖入文件并收录 | 输入与预检 → 保存到目标空间 → 仓库收录、元数据和视图准入；UI 组合 `previewViewImport/importToView` 或 `importToLibrary`，外部文件输入使用 `importFiles` | 文件已存空间，不一定已入库；入库不一定符合视图。未匹配默认需用户选择，失败区分已存候选与仓库回滚。 |
| 完成外部编辑 | 本机工作副本 → 检查与稳定快照 → 空间发布 → 本库接纳 → 清理副本 | 外部程序保存不是发布完成；空间发布成功也不代表本库接纳成功。重试接续原阶段。 |
| 删除与清理 | 预演明确目标 → 素材回收／空间回收／系统废纸篓／记录清理中的明确步骤 | 这几种动作影响不同记录与字节；单个事务或一次撤销不覆盖整个跨层流程。 |

UI 与 MCP 可以提供不同入口，但应复用同一层的业务协议。跨层任务的检查、回执与恢复不应复制到每个插件按钮里。

## 扩展声明、复用组件与 SDK 入口

扩展声明说明“插件提供什么”，运行接口说明“插件能请求宿主做什么”。它们不另成一个数据归属层：`CorePlugin` 贡献仓库语义，`UiPlugin` 贡献画面与交互，`LocalServicePlugin` 贡献本机异步行为；同一插件可以组合三者。

外部工程使用 `@resource-manager/plugin-api/` 前缀；以下是现有入口索引，不是建议新增的目录结构：

| 入口后缀 | 用途与注意事项 |
| --- | --- |
| `core`、`core/contracts`、`blocks`、`query`、`operations`、`queries`、`ingest` | 仓库契约、调用类型、命令／查询／收录声明；运行实例由上下文提供 |
| `files` | 文件编辑、接纳及版本历史类型；运行方法仍在现有 `host.core` |
| `local-service` | 外部本机服务、设置、密钥与流式调用契约 |
| `ui/contracts`、`ui/editing`、`ui/file-editing`、`ui/workbench-presets` | 组合门面、扩展声明与各宿主服务契约 |
| `ui/data`、`ui/entities`、`ui/media`、`ui/collection`、`ui/fields`、`ui/widgets` | 数据订阅、卡片、集合与字段控件复用；字段控件可发起写库，不是全部只读 |
| `content-selection`、`ui/selection`、`ui/navigation`、`ui/hooks`、`ui/search`、`ui/playback` | 内容引用、选区、导航、按键、搜索和播放记录；播放事件监听通过回调交给媒体业务保存，不拥有独立数据块 |
| `format`、`urls`、`pdf-text`、`ui/layout` | 格式化、网址、PDF 文本及布局计算等复用工具；按各模块环境使用 |
| `core/process`、`core/images` | 核心加工的进程工具和图像能力类型；进程工具不能在浏览器 UI 运行，图像能力由加工上下文提供 |

入口白名单以 [sdkSources](../../scripts/plugins/sdk.ts) 为准，UI 运行时共享导出也在该文件登记；manifest 的 feature 声明和能力限制见各专题。**目录中存在文件不代表外部包可导入**：`service.ts`、`ui/application.ts` 是内部服务／应用 UI 契约，`ui/internal/` 是宿主实现注入，均不在普通外部 SDK 白名单。

## 后续新增接口的记录方式

每项公共能力写清：**归属层、作用范围、状态保存位置、读写影响、调用环境与开放范围**。写接口另说明校验、失败／重试和撤销边界；可订阅服务说明取消与清理；可替换 UI 说明缺插件时的行为。优先补到对应专题并在这里索引，不重复维护第二份完整方法签名。

职责分类与声明拆分不新增通用权限框架、持久服务容器或调用命名空间。后续按使用场景渐进调整，不能仅因文档分类要求所有插件迁移。

## 插件数据维护（仓库级）

`CorePlugin.dataLifecycle` 声明独立记录清理范围和保留影响；`host.core.listPluginData / previewPluginDataCleanup / cleanupPluginData / retryPluginDataCleanup` 负责盘点、预览、事务清理及缓存重试。停用仍保留数据，维护不改变应用安装包或文件空间原件；本批不开放 MCP 自动清理。见[插件数据生命周期](插件数据生命周期.md)。
