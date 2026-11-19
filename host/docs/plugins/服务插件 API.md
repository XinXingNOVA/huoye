# 服务插件 API：生命周期、设置与外部接入

职责与外部开放范围见[公共 API 总览](公共API总览.md)。本文的应用级服务／UI 契约供随应用编译的内部模块使用；外部包使用 `local-service` 入口，不直接导入 `service.ts` 或 `ui/application.ts`。

核对日期：2026-11-18。本文主要说明随应用编译的可信内置服务。业务接口见[公共后端 API](公共后端%20API.md)，界面接口见[公共 UI API](公共UI%20API.md)，登记见[插件开发指南](插件开发指南.md)。本地 `.rmplugin` 已支持仓库级 service，使用精简的 `LocalServiceContext`，接口、流式调用与本机存储见[外部本机服务](外部本机服务.md)；不支持分发 executables 或应用级插件，也没有不可信代码隔离。

## 1. 作用域与运行位置

| 声明 | 生命周期与位置 | 契约 |
| --- | --- | --- |
| 省略 `scope` 或 `scope: "library"`，`core` | 每个仓库的 utilityProcess | `CorePlugin` |
| 仓库级 `ui` | 仓库窗口，按该库实际启用集合装配 | `UiPlugin` / `UiHost` |
| 仓库级 `service` | 主进程，每库独立实例；随仓库关闭、重载而停止 | `ServicePlugin` / `ServiceContext` |
| `scope: "application"`，`service` | 主进程，应用启动时运行、退出时清理；无仓库也可用 | `ApplicationServicePlugin` / `ApplicationServiceContext` |
| 应用级 `ui` | 应用设置，仓库管理窗口也可展示 | `ApplicationUiPlugin` / `ApplicationUiHost` |

MCP 是应用服务的首个案例。协议、本机通道、stdio、设置和样式归 `src/plugins/mcp/`；生命周期、授权、建库与路由归宿主。核心仍是每库唯一写入者，具体业务插件只声明 `operations`，不依赖 MCP。

## 2. 目录声明与构建

```json
{
  "id": "mcp",
  "scope": "application",
  "title": "AI 接入 · MCP",
  "description": "应用级本机接入",
  "entries": { "service": "./application-service.ts", "ui": "./ui.tsx" },
  "executables": { "mcp": "./stdio.ts" }
}
```

入口均在自己的目录内，以 `./` 开头，命名导出 `plugin`；service 必须是 `.ts`，UI 可用 `.tsx`。`executables` 需要 service，键是唯一输出名，不能用 `index`、`core`；独立入口直接执行，不需要导出 plugin。

生成器分别输出仓库与应用的 service / UI 清单，独立入口仍统一构建。`manifest.ts` 的 `PLUGINS` 只包含仓库插件，`APPLICATION_PLUGINS` 包含应用插件，`ALL_PLUGINS` 用于保留 ID 等全局检查。应用插件不能声明 core / blocks，也不能跨作用域声明依赖。新增符合既有契约的内置应用服务无需手工改中央名单；生成产物一起提交。

应用服务均随应用启动，具体能力是否开放由自己的设置控制。首版没有通用的应用插件启停列表；MCP 的开关是连接总开关，关闭后拒绝新请求，不销毁设置页。

## 3. 生命周期

公共契约在 [plugin-api/service.ts](../../src/plugin-api/service.ts)，两种作用域共用泛型 `ServiceRuntime`：

- `start(ctx)` 可异步；模块顶层不打开连接、不注册 IPC、不启动计时器。
- 每取得资源立即 `ctx.onDispose(fn)`。启动失败、重载或退出时，先撤销 `signal`，再逆序释放资源并等待已派发调用收尾。
- 清理可重复触发但只执行一次；失效后才取得的资源立即释放。
- `ctx.executable(name)` 只返回该插件自己声明的程序、参数和环境。
- 启动失败保留设置入口的错误反馈，不阻止其他服务和仓库使用。

仓库服务仍按 `info().assembly` 启动，与本次核心进程生命周期绑定；不再持有旧 MCP 的每库凭据和核心调用白名单。应用服务跨仓库窗口存在；单次仓库调用捕获具体核心，重载期间拒绝访问，恢复后新请求可继续。

正常退出等待清理；强杀不保证异步清理。没有对永不返回的插件代码建立隔离、自动重启或持久后台任务。

## 4. 设置与 UI

设置分为 **应用** 与 **当前仓库**，切换保留仓库启停草稿：

| 设置 | 位置与生效方式 |
| --- | --- |
| 插件包安装、更新、卸载 | 应用 → 插件包；立即改变本机包目录，不自动改各库版本或启用选择 |
| MCP 总开关、各库访问权、新建位置、连接配置 | 应用 → AI 接入；立即保存到本机 |
| 内置插件选择、外部包版本和启用 | 当前仓库；统一“应用并重新加载”，一次事务和一次重载 |
| 业务插件设置 | 当前仓库的 `UiPlugin.settingsSections` |

应用 UI 契约在 [plugin-api/ui/application.ts](../../src/plugin-api/ui/application.ts)。`ApplicationUiPlugin.settingsSections` 提供稳定 ID、顺序和组件；组件收到 `ApplicationUiHost`，仅提供 `service()`、`pickDirectory()`，不携带 CoreClient 或当前仓库。宿主从真实顶层窗口校验本地设置调用，远端协议没有设置和提权入口。

仓库 UI 继续使用 `UiHost.service()` 访问该库服务。仓库分区的 `scope: 'local' | 'library'` 只说明**存储位置**，不改变插件生命周期；不要与 `plugin.json` 的作用域混用。两种 UI 都使用公共 API，不能导入 renderer 内部或直接操作 bridge。

## 5. 应用授权、建库和路由

应用接入在 [main/application-access.ts](../../src/main/application-access.ts)，Electron 适配在 [main/application-services.ts](../../src/main/application-services.ts)。服务拿不到数据库、Electron 对象或任意 CoreApi。

`ApplicationServiceContext.access` 提供：

- `settings(change?)`：本地设置入口，校验开关、仓库权限和新建策略；不经远端暴露。
- `authorize(credentials)`：只接受应用凭据；配置中的 `libraryId: "application"` 表示认证身份，工具参数中的 `libraryId` 才是本次目标仓库。
- `list()`：只返回已授权的仓库和打开状态。已有仓库先在应用里打开一次，才能登记并授权；不会扫描任意磁盘目录。
- `status({libraryId, sections?})`：只读汇总现有会话，不隐式开库；按需读取装配、工作台就绪、加工队列与当前诊断。
- `workbench(libraryId, {action, input})`：当前 UI 会话的只读现场（read）或展示请求（present）；前者允许 read，后者要求 organize/admin，复用工作区控制器与即时授权检查。
- `processing(libraryId, {ids, kinds, waitMs?, expectedRevisions?})`：按本批素材观察加工记录，短暂等待时逐次核对权限及核心会话；不触发加工或重试。
- `importFiles(libraryId, {files, requestId, spaceId?, collect?, waitMs?, processingKinds?})`：先经原核心导入取得回执，再按需附加当前加工观察；观察参数不进入持久签名。MCP 的 import_to_library 使用这个应用入口。
- `catalog({libraryId?, offset?, limit?, snapshot?})`：应用能力目录，零仓库可查；指定目标必须已授权，不要求打开仓库。只读静态声明及安装登记，不执行插件代码。
- `open(libraryId, background = true)`：只打开已授权目标，默认不抢焦点；传 false 明确显示。文件夹缺失不能在旧位置悄悄新建；核心初始化先检查预期 ID，再加载业务插件。复制出重复 ID 且同时授权时拒绝猜测目标，用户需关闭多余授权。
- `previewCreation({name, preset?, plugins?, background?})` / `create({...参数, requestId, previewRevision?})`：复用启动页的预演和首次装配，仅在本地选择的父目录内新建。名称不能是路径或系统保留名，不覆盖或接管已有目录。新库按本地策略获得 read、organize 或 admin 权限；客户端不能通过参数选权限。选择方案或明确插件组合要求 admin 创建策略及预演凭据。
- `creationStatus(requestId)` / `resumeCreation(requestId)` / `cancelCreation(requestId)`：读取、继续或取消本应用接入的创建任务。恢复保持首次仓库身份、包摘要、配置和后台选项；取消保留已产生的数据，不是回滚或删除仓库。
- `manage(action, input)`：按固定 Schema 路由安装请求、本库插件调整、本库工作台配置和获准空间关联；仓库管理动作要求 admin，并在后续阶段重新检查。`localManagement(input)` 仅供本地设置授予／撤回确切包许可、处理待审批请求和选择可关联空间，不经 MCP 暴露。
- `call(libraryId, method, ...args)`：每次校验目标和权限，仅转交 ExternalApi 白名单中的查询、业务操作、导入及文件操作。数据写入需要 organize 或 admin，结构操作要求 admin；原件发布／回收另需空间授权，管理仓库不会放宽包安装或原件权限。
- `publishEndpoint()` / `configFile`：本机连接配置；stdio 每次读取当前地址。

创建任务和回执保存在本机 `library-creations`，与业务写入的仓库回执分开。同参并发共用一次创建；完成或取消后重试只返回原回执，不重复建库，也不隐式重新打开。同 requestId 改参数返回 `REQUEST_CONFLICT`。任务先落盘，再认领目录、事务初始化插件选择、启动核心和接续工作台；确认后不重新解释更新过的方案。旧 `application-state.json.requests` 保持可读，旧成功回执继续返回；旧失败请求没有安全接续计划，仍返回 `CREATE_INCOMPLETE`，需要在应用中检查原目录。创建仓库本身不进素材撤销历史。

每个后续创建阶段重新核对总开关、原创建策略及本库授权；撤权或降权不被重试覆盖。取消正在运行的任务后，当前已派发阶段可能完成，在下一检查点停止；查询 running=false 后再核对最终阶段。取消会撤下尚未应用的方案安排，已提交配置、布局和文件保持。已完成任务的取消不撤销成果。后台运行使用隐藏 Electron 窗口，应用仍须运行；主窗、恢复的小窗和重载不抢焦点，显式显示后按普通窗口处理，正常退出重开保留各库的后台状态。

授权分为 `off / read / organize / admin`。旧配置原样接续；更改新建策略不升级已有库。选择“新仓库由 AI 托管”才会按新建策略授予 admin，已有库需在本地设置明确选择“管理仓库”。

授权仅在本机，默认关闭。移动／复制路径不会继承授权；应用状态文件损坏会明确报错，不静默重置 token 或请求回执。收回权限拒绝后续调用，已派发写入可能已提交；不自动回滚。正常关库仍取消未提交收录。

## 6. 统一应用级 MCP

应用仅监听一个本机 socket（Windows 为命名管道），无远程 HTTP。日常、自主开发和开发验收各有固定的工具集合，开关业务插件不会改变工具名。离线或配置不可用时也能发现日常工具。仓库工具必须带 `libraryId`，宿主逐次校验授权。见[日常工具](../../src/plugins/mcp/tools.ts)和[开发验收工具](../../src/plugins/mcp/development-tools.ts)。

`describe_library` 发布该库启用插件的 `queries` 输入/输出 schema 与 `operations` 名称、effect 和输入 schema。只返回本次权限可执行的操作，`blockedOperations` 提供名称、标题和阻止原因；只读时 queries 保留、operations 为空。`data` 需要 organize/admin，`structure` 需要 admin。未声明 effect 的旧插件仍可在应用中使用，但通过 MCP 执行返回 `OPERATION_UNCLASSIFIED`；插件补分类及兼容标记后再启用，不能靠操作名称推测权限。业务读取走 `execute_query({libraryId, query, args, limit?, cursor?})`，见[接入说明](插件业务只读查询.md)。AI 使用 `execute_operation({libraryId, operation, requestId, args})` 调用，不把不同库的同名操作混成一个全局 schema。插件启停不改变这些固定工具；要重新读取目标库的声明。

`list_ecosystem_catalog` 在零仓库时也可使用。`entries` 区分 builtin/bundled/installed 插件、suite 和 preset，返回版本、摘要、依赖、公开说明、静态问题和包使用授权；不会返回插件安装目录、其他仓库绑定、完整布局或凭据。`runtime: "not-checked"` 表示未验证业务／界面装配，依赖和安装内容校验通过不等于运行成功。随附来源依据当前发行清单验证过的包摘要；查询不安装或授信，已卸载的随附包仍显示为 not-installed。

`creation` 给出用户授权的新建父目录和默认权限，null 表示未授权。`supported` 说明当前宿主接入了哪些建库和管理接口。`target.permissions` 表示指定库的授权。其中 `workbenchSession`、`workbenchPresentation`、`workbenchConfiguration` 分别对应读取现场、临时推画面、保存布局；原 `workbench` 字段仍表示保存布局。`reviewRead` 对应验收单 list/get，`reviewManage` 对应 create/confirm/withdraw。可执行的插件操作查 `describe_library`，当前核心、插件和工作台状态查 `get_library_status`。目录默认每页 30 项、最多 100 项；后续页携带 snapshot，目录或授权变化返回 `CATALOG_CHANGED`，从首页重读。目录不搜索在线市场或开发目录。

建库工具使用方式：

1. `preview_library_creation({name, preset: {id, revision, versions?, layout?}, background?})`，或以 `plugins: [{id, hash?}]` 替代 preset，两者互斥。显式空数组只保留必需模块；依赖自动补齐，多版本不明时返回问题。明确 hash 必须已安装且匹配插件 ID，不自动替换。默认创建沿用发行组合。
2. 解决 issues 后，将相同参数、返回的 `revision` 作为 `previewRevision` 和新 `requestId` 提交给 `create_library`。方案、目录或创建授权变化返回 `PREVIEW_CHANGED`；已持久确认的任务不受之后目录变化影响。随附确切摘要、本机明确授予 AI 跨库许可或目标位置已授信的包才能使用；“已安装”不代表允许新库执行，未授权包返回 `PACKAGE_APPROVAL_REQUIRED`。建库本身不安装或授信，缺包先走安装工具。
3. 用 `get_library_creation({requestId})` 核对；pending 且 running=false 可用 `resume_library_creation` 继续原计划，或 `cancel_library_creation` 保留数据并停止接续。create/resume 等待本轮装配尝试，客户端超时不会删除任务，先查状态或复用原请求。
4. `open_library({libraryId, background?})` 默认隐藏打开；`show_library({libraryId})` 显式显示并聚焦。已经显示的窗口不会被一次后台 open 隐藏。重复显示复用原窗口。

创建回执的 `state` 为 pending/completed/cancelled，`phase` 是最后记录的 planned/claimed/initialized/assembled 检查点，并非每项副作用的事务进度。`running` 表示本次接续是否仍在执行；`error` 保留上次失败原因，继续尝试时清除。`runtime.core` 为 stopped/running；`runtime.workbench` 为 closed/loading/layout-pending/ready，另有 visible。completed 代表创建装配已确认，工作台加载和方案存档可能稍后完成；交付前应查到 ready。它不证明所有插件界面与业务都正常，也不表示素材加工已完成。旧回执没有这些新运行细节。

包安装与本库能力调整（1C）：

- `request_package_installation({requestId, paths})` 固定本地插件／套件文件快照并返回静态预览和 approvalRequired；不执行包。后续源文件替换不改变这次请求。`get_package_installation` 查回执，`install_packages` 按原快照继续；失败可原 ID 重试，成功项不重复安装。待处理快照最多 20 个请求、合计 256 MiB；完成或取消释放快照字节，保留终态回执。
- 开始页「AI 托管」可按已登记套件批准清单中确切匹配的已安装包。其他陌生摘要在「设置 → AI 接入 · MCP → 插件包授信」批准。批准的是具体包版本及其跨托管仓库使用许可。随宿主升级验证的新发行包自动获准用于新库。手工安装或替换的版本需要按其摘要授权。设置提供按套件批量许可、许可当前全部已安装版本和逐包撤回；每次提交固定当前所列摘要，未来安装或更新的版本不自动继承。设置可以撤回跨库许可，已经授予某库的许可和正在运行的代码保持；需要停止该库后续 AI 操作时另行收回仓库管理权限。安装不自动启用，依赖逐项检查；不安装网络内容，不通过此入口更新既有套件、卸载或跨库替换。
- `preview_library_plugins({libraryId, preset?|plugins?, mode?})` 在已打开的 admin 库预演，mode 默认 add，也可 replace；返回 current、selection、revision 和问题。明确 hash 必须已安装且匹配 ID。`configure_library_plugins({libraryId, selection, revision, requestId})` 复用应用内页面保存、配置提交与重载；停用保留数据，后台意图保持。此入口只调整插件，不应用方案配套布局，已有待接续布局会阻止提交。
- `get_library_configuration({libraryId, requestId})` 返回 pending/completed/cancelled、saved、running、error、runtimeProblems 和 layoutPending。saved 表示已核对配置符合请求，不保证所有插件运行；runtimeProblems 是当前核心／服务检查结果，不替代插件界面验收。失败用原参数重试，配置已提交但重载失败时重新加载原选择。基线或之后的人工配置改变则拒绝覆盖；完成回执不再次应用配置。`cancel_library_configuration` 只截断后续调整，已提交配置与数据保留，本地设置也可取消失败任务。
- `list_allowed_file_spaces` 只列出用户明确选择的空间身份和名称；`link_library_file_space({libraryId, spaceId})` 要求 admin，核心在准备结构和登记成员之前核对空间身份。沿用原独享／共享成员规则，不切换模式、不改原件权限、不自动收录，也不改变默认保存空间。取消关联许可只阻止未来关联调用，不解除既有绑定。

工作台配置与保存视图（2026-11-17）：

- `execute_operation(save_view)` 复用内置 view 命令，属于 `structure`；新建返回视图身份，更新要求已读取的 `expectedSeq`。视图的规则保存在库内，支持既有撤销和幂等回执。
- `preview_workbench({libraryId, layout?})` 读取已打开 admin 仓库的当前布局、revision、可用工具和预设；带 layout 时逐项报告内容／呈现问题。布局沿用 `WorkbenchLayout`。本库配置允许 collection 页 `target:{viewId}` 引用现有保存视图；普通可分享预设仍只捕获可重建入口，不复制本库视图身份。
- `configure_workbench({libraryId, requestId, revision, layout})` 校验当前布局后经现有工作区控制器调整，保留已有页面、草稿、独立窗口和业务数据，不自动亮窗。页面呈现只采用已启用布局支持的参数；失效视图或工具会拒绝提交。后续交付用 `show_library`。
- `get_workbench_configuration({libraryId, requestId})` 查询本机回执。pending 可原参数重试，completed 重试只返回原回执，不覆盖后来的人工作业。请求固定参数，工作台变化拒绝旧 revision；重启不自动执行未完成请求。落盘回执与工作区同次保存，提交响应丢失可核对恢复。三个工具目前均要求目标库已打开且 admin；不提供任意草稿写入或自动保存命名预设。

管理请求保存在应用接入的本机目录，空间许可和包许可不写进素材库。只有未完成的固定创建、安装、方案和插件调整任务阻止旧包更新；完成／取消回执仅用于核对。安装与配置不宣称跨包、跨进程原子回滚。应用退出先停下后续管理阶段再保存窗口；强制中断后通过原 requestId 和实际配置核对接续。

2026-10-31 起只保留应用协议。旧单库认证、每个业务操作单独成为 MCP 工具的映射及仓库级 MCP 服务实现已退役。仓库服务不再提供旧 `ctx.access`；外部插件的 `LocalServiceContext`、设置／密钥、持续调用和生命周期不变。

已有 `application-state.json` 中的总开关、各库授权、空间权限、新建位置、应用 token 和请求回执继续沿用。读取时忽略旧 `configured`／`legacyToken` 字段，下次保存移除它们；不会重置应用状态或改变仓库数据库。新登记的路径一律默认关闭，不再读取旧单库配置来授予权限。旧单库 JSON 不再读取、更新或自动删除。

仍使用旧连接的客户端需要在「设置 → 应用 → AI 接入 · MCP」复制通用配置，替换旧条目并重连；确认各目标仓库的访问权限。新 stdio 桥接读到旧配置会返回 `CONFIG_RETIRED`，不会把旧 token 升级成可跨库的应用凭据。已使用 `application.json` 的客户端无需重配，只需在升级应用后重启桥接进程加载新代码。业务写入改为 `execute_operation({libraryId, operation, requestId, args})`，查询使用 `execute_query`；原请求 ID 与业务回执保持。

### 批量读取与字段盘点

两个工具沿用目标仓库的 `read` 权限。可在 `describe_library` 的 `kinds` 查实际字段和索引，在 `limits.inventory` 查当前上限。

- 已有一批素材 ID 时，调用 `read_items({ libraryId, ids, kinds: ['tags','rating'] })`。每次最多 1000 个 ID、16 种块。按输入顺序逐项返回，重复 ID 保留位置。`state` 区分在库、回收站和不存在。已登记但未挂载的块在 `blocks` 中没有对应键，未知块类型会报错。存在的块返回原始字段值 `data`、写入序号 `seq` 和结构版本 `ver`。
- 单块超过 8 KiB 时返回 `omitted: true` 和字节数，可用 `read_item` 取字段目录，再用 `read_content` 携带 `expectedSeq` 分段读取。一页最多 256 KiB；用原 ID 列表、原 kinds 和 `offset: nextOffset` 继续。各页读取当时的值。接手已有库时，可先按 `search_items` 的游标取得身份。
- 盘点字段时，调用 `facet({ libraryId, kind: 'rating', field: 'value', query: { role: 'material' } })`。默认范围与 `search_items` 一致。返回匹配身份总数 `matchedItems`、至少一个索引值的身份数 `withValue`、缺值身份数 `missingItems`。同一素材重复出现同一个标签时，该标签只计一次；多标签素材可分别计入多个桶。空列表计入缺值，布尔 false 和数值 0 都是有效值。
- `values` 按计数降序，同数按原始值升序。日期使用毫秒，引用使用目标 ID。超过 2 KiB 的文本值保留各自的桶，返回 `value: null`、预览、字节数和样例素材 `sampleId`。默认每页 50 个桶，最多 100 个。用原条件和 `cursor: nextCursor` 翻页，仓库发生写入或重载后从首页重新统计。覆盖数始终针对完整查询范围。

### 仓库运行状态与本批加工（2026-11-17）

两个工具均允许 read / organize / admin，off 拒绝。它们读取实时状态，不写回执、不启动加工、不打开关闭的库，也不需要开发验收权限。

`get_library_status({libraryId, sections?})` 总是返回 core：running / closed / offline / reloading / closing。sections 默认空，按需选择 plugins、workbench、processing、errors。插件摘要来自本次实际装配及服务启动结果；加工摘要的 running / queued / pendingChecks / scanningSystems / demanded 是全库瞬时计数，不能作为本批成功条件。errors 仅为当前装配与服务问题，并非最近日志或素材失败列表。核心不可用时省略其详情，不拿旧会话充数。workbench.state 在页面初始化时为 loading。页面已就绪且仍有待接续的方案布局时为 layout-pending。等待 ready 后可继续预演插件配置，后台建库可全程保持 visible=false。具体列表的呈现进度、焦点与选择项见 get_workbench_session。

`get_processing_status({libraryId, ids, kinds, waitMs?, expectedRevisions?})` 最多 100 个素材、16 种数据块；kinds 必填，从 describe_library 的定义中选择。waitMs 默认 0，最多 10000 毫秒；达到等待预算后返回当前快照，仍有 pending 时 timedOut=true，可再次查询。只观察指定产出及其上游，复用调度器输入键、插件版本、派生记录与权威产出者，不等待无关身份的扫描。

每项素材返回 revision、state 与 kinds。state=settled 只表示所选产出没有待等待项，必须继续检查各 kind：

| kind.state | 含义 |
| --- | --- |
| ready | 当前输入的权威加工成功且有输出；普通不可重建块表示记录存在 |
| empty | 当前加工成功但没有输出；普通不可重建块表示记录不存在 |
| skipped | 不满足识别条件或当前记录为跳过 |
| pending | 当前输入待加工、运行中或等待上游；phase 给出原因 |
| failed | 当前输入加工失败，附 system / plugin / reason |
| blocked | 缺处理能力、插件不可用、需要按需触发、上游失败或依赖循环 |

seq 是现存输出版本，旧输出在 pending / failed 时也可能存在；ready 不替代预览读取时对缓存文件的检查。素材不存在或在回收站时分别返回 missing / trashed。只读查询不会触发按需加工或重试，受阻时需应用中的既有入口处理。

revision 包含核心会话、素材原始记录以及直接依附目标的原始记录版本，正常派生产出不会使它变化；标签等人工编辑也会使凭据变化。等待自动固定首个版本，可额外传 expectedRevisions={素材ID:revision}；变化返回 changed，重开／重载中的会话替换拒绝继续观察。授权在每次轮询及返回前复核。版本与状态都是观察时点的信息，后续写入仍须走各业务的并发检查。

```json
{
  "libraryId": "已授权的仓库ID",
  "ids": ["导入返回的素材ID"],
  "kinds": ["still", "palette", "image-filter.geometry"],
  "waitMs": 2000
}
```

### 素材预览与导入快等（2026-11-17）

`read_preview({libraryId, ids, mode?, maxSide?, expectedRevisions?})` 复用仓库只读授权，可在现有 AI 接入设置中选择 read / organize / admin，off 拒绝。输入只接受素材身份，不接受文件路径、URL 或窗口目标。读取前后检查授权与当前核心；不打开仓库、不触发加工、不写缓存。工作副本、整窗截图和开发验收许可不属于此接口。

- `mode=single` 为默认值，只能指定一项；优先取新鲜 still 代表图，读取不到时尝试新鲜 thumb 缩略图。`mode=grid` 最多 12 项，优先缩略图，生成一张有编号的拼版；按请求顺序固定 #1…#12，失败项保留格子，重复 ID 也保留各自位置。
- maxSide 默认 1280，范围 256–1600，约束整张输出的最长边。拼版保持比例、居中留边；单图不放大。只取首帧，按 EXIF 转正、转 sRGB、透明背景合成浅灰、输出 JPEG 并去除源文件元信息。更细节的检查可用单图及较大的 maxSide；它仍是预览，不返回无限尺寸原件。
- `items` 返回 index、id、revision、state，以及成功图的 source.kind / seq。普通文件素材还返回本库已接纳的 original.contentVersion 及可用性；原件离线时允许读取本库当前缓存，并明确标记原件状态，不悄悄切到空间最新版。纯文本等无图素材返回 unsupported。
- pending、failed、blocked 分别表示加工未完成、失败、能力受阻；missing / trashed / changed / unavailable 分别表示素材缺失、回收、版本变化、预览文件不可读／过大／无法解码。全批无可读图时不返回图像；部分失败时仍返回其他格子的图。未知或停用的加工能力不会把旧数据冒充为新预览。
- expectedRevisions 复用加工状态的原始记录版本，读取期间还检查选中图块的 seq、路径与加工新鲜度；期间变化的单项返回 changed，拼版发布前发现成功项变化则整次返回 PREVIEW_CHANGED。重试时重新核对当前素材。
- 每份输入文件最多 32 MiB、解码最多 64 M 像素，最终 JPEG 最多 2 MiB，每库只处理一批，整体读取预算 10 秒。超限／不可解码可尝试另一份新鲜预览；并发返回 PREVIEW_BUSY，超时返回 PREVIEW_TIMEOUT。库关闭则取消读取。

核心 `readPreview` 返回内联 JPEG 与元信息。MCP 将 JPEG 转成原生 `ImageContent`，JSON text / structuredContent 只保留编号映射与尺寸，不重复携带 base64；普通业务查询里形似 image 的对象仍按普通数据返回。

```json
{"libraryId":"仓库ID","ids":["素材A","素材B"],"mode":"grid","maxSide":1280}
```

`import_to_library` 增加可选 waitMs=0–2000 与 processingKinds（最多 16 种，默认 thumb）。两者均不传时维持原响应；传 waitMs=0 或仅传 processingKinds 时做一次即时观察。收录提交后通过共用加工服务查询，返回独立的 `processingObservation`：observed 带 items / waitedMs / timedOut；not-collected 表示仅保存文件；empty 表示本次没有收录项；unavailable 表示观察未能完成，但导入回执已经成功取得。

原 `processing: "not_waited"` 仍如实描述持久导入阶段；当前观察不写回永久回执。相同 requestId 和导入参数可调整等待预算／产出种类续查，不会重复导入；收录参数变化仍冲突。观察期间撤权会拒绝返回，库关闭或观察超时则保留成功导入结果和观察错误；恢复连接后沿原 requestId 核对回执。单项加工失败只影响对应状态，不把整批导入改成失败。大批量使用独立 get_processing_status。

```json
{"libraryId":"仓库ID","files":[{"path":"/本机来源/example.png"}],"requestId":"import-example-001","waitMs":2000,"processingKinds":["thumb","palette","image-filter.geometry"]}
```

这个入口读取已有预览。按需加工重试、PDF 翻页、扫描件 OCR 和视频选帧均超出其范围。

## 7. 检查与验证

目录生成与边界检查覆盖作用域、依赖、入口、浏览器误引用、辅助文件与类型引用。Node 服务不能直接依赖 Electron、SQLite、React 或宿主私有实现；这些是维护边界，不是不可信代码沙箱。

- `tests/integration/application-access.test.ts`：默认关闭、两库隔离、只读和撤权、重复身份、路径校验、并发创建与重启回执、创建中断、状态保留、旧凭据拒绝和真实本机通道。
- `tests/integration/ecosystem-catalog.test.ts`：静态目录不执行代码或改授权、套件发现、依赖与安装问题，以及操作分类兼容门槛。
- `tests/integration/services.test.ts`：共用生命周期、初始化失败清理、并发停止、等待调用，以及实例隔离和停止信号。
- `tests/integration/plugin-catalog.test.ts`：作用域清单、目录发现与依赖边界。
- 构建基础应用后 `node tests/electron/application-mcp-check.mjs`：离线固定工具发现、旧配置拒绝、逐次读取配置，随后用临时 `RM_USER_DATA` 跑 `appmcp / appmcpresume`。零仓库目录、真实设置选择 admin、SDK stdio、拒绝客户端提权和永久清除，并发新建、两库授权隔离、文字与 PNG／TXT 导入加工、搜索读取、撤销／重试、插件重载、关库重开及应用重启回执。不依赖业务插件包。
- `node tests/electron/application-creation-check.mjs`：隔离环境验证预演与精确包授权、首次装配、隐藏主窗／附属窗口、显式显示、后台重载、取消保留、插件失败与强制进程中断后按原配置恢复、新文件加工、正常退出后的前后台状态与布局恢复。原启动页流程继续由 `library-creation-check.mjs` 回归。
- `node tests/electron/application-management-check.mjs`：真实设置控件人工批准、套件安装／后台创建、停用保留内容、插件启动失败后继续／取消、旧预演拒绝、终态释放更新引用、双库隔离、获准空间关联与重启后全新 TXT 加工。原手动插件组合由 `plugin-presets-check.mjs` 回归。
- `mcpcreate / mcpcreateresume` 保留素材创建、部分失败、并发重试与持久回执的专项场景；无意义的 `mcp / mcpresume` 旧别名已移除。

截图流程选择目录／文件可由测试直接设置或代办，MCP 走真实 stdio 与本机应用通道；插件重载由宿主接口触发。只在临时库和独立用户目录运行。macOS 的实际验证不等于已验证 Windows 的命名管道或安装包分发。

仓库生命周期补充：ExternalApi 开放 `previewItemLifecycle / applyItemLifecycle / previewUnlinkFileSpace`。应用授权检查前两者的读／写权限；apply 的 trash/restore 允许 organize/admin，工具有明确预览凭据和持久回执；purge 已从 MCP 写工具的 Schema 中移除，直接请求也返回 `IRREVERSIBLE_DENIED`，即使 admin 也不能执行。应用内永久清除保持原入口。空间原件操作经 `externalFileAction` 的受控动作执行，仓库权限不自动授权空间处置。当前固定工具以 `src/plugins/mcp/tools.ts` 为准，契约见[生命周期接口](../architecture/文件空间.md)。


### 跨会话整理任务

1. 首次整理前调用 `library_task({libraryId, action:'create', taskId, title, inputs})`，一次登记最多 1000 个明确文件的绝对路径。客户端生成稳定的 `taskId`，同一标识和同一清单可重放。不同路径可以对应同一份内容。
2. 将同一个 `taskId` 传给 `import_to_library`。宿主按路径登记尝试，逐项结果与导入回执一起提交。已提交的逐项失败修复后用新请求号重试该项。整个请求中断且结果未明时，用原参数和原请求号重试。成功重放不会重复计次。
3. 接手者用 `library_task({libraryId, action:'list'})` 发现任务，再用 `action:'get', taskId` 读取。`section:'inputs'` 按原顺序返回每项最新尝试及素材身份。状态包括 `unattempted`（未提交）、`running`、`interrupted`（核心会话结束时未获终态）、`failed`（附错误）、`stored`（仅保存）以及收录的 `created/existing/restored`。`section:'attempts'` 保留每次尝试及其请求号，attemptNo 按同一任务内的输入路径计数。加工失败另用 `get_processing_status` 或 `read_item` 核对。
4. 通过 `execute_operation` 编辑可验收的业务附加块时也传入 `taskId`。命令、回执和验收差异在同一事务提交。`section:'writes'` 列出原请求号和验收状态。发现 `draft` 后，先用 `library_task({libraryId, action:'diff', taskId, requestId})` 分页查看原差异及后来被修改的现值，再将原请求号送给 `review_batch` 的 `create`，即可跨重载补单，无需重做写入。已送审的记录带有验收单 ID。主动丢弃的草稿显示 `discarded`，其他原因导致差异失效时显示 `unavailable`。同一验收单可合并同一任务的多项草稿；多个草稿改了同一个字段或同一列表成员时分别送审。
5. 输入的最新结果均为已保存或已收录、未送审草稿已处理后，调用 `action:'complete'`。已送审的批次可在任务结束后独立确认或撤回。决定停止剩余工作时用 `action:'abandon'`，放弃后仍可查看失败记录、补送已有草稿。正在导入时两种操作都会返回 `TASK_BUSY`。同一结束动作可重放，已结束的清单只读。

读取需要本库 read，登记、写入和结束需要 organize 或 admin。list/get 支持 `offset/limit`，每页最多 100 行。清单和尝试记录保存在本库，显式纳入任务的写入才捕获差异。较早会话中未登记的操作沿用原历史规则。源文件在登记后仍可能变化，接手时用实际素材 ID 和文件哈希核对。

仓库设置 → 数据维护 → AI 整理任务可查看明细、单独丢弃一份或一项任务的全部未送审草稿，或清理一项已结束任务的全部记录。清理前显示范围和数量。素材与正式验收单保留。清理整项后释放其路径、错误、差异及任务回执内容，保留任务标识摘要与已使用的请求号用于防重。迟到重试返回 `TASK_CLEANED`。撤销素材改动通过验收单或会话撤销处理。若中断导入留下跨空间的准备记录，清理时需要连接相应文件空间；离线会保留任务供重试。清理释放的数据库页可以复用，需要回收磁盘空间时可使用同页的「整理数据库」。

每库默认最多保留 128 项任务、64 份未送审草稿；每项任务最多 4096 条逐文件导入尝试、1024 条业务写入记录。`library_task(list)` 的 `capacity` 返回当前任务数、草稿数和四项上限。达到相应上限会返回 `TASK_LIMIT`，整批拒绝新增。原回执重放、送审、结束和清理仍可执行。在本库的数据维护页面可调整四项上限，调低后保留已有明细。上限统计任务明细，长期防重占位单独保留。 数据维护页分别显示本库的任务标记数、请求标记数和估算占用。估算计入标识长度及 SQLite 存储开销，达到 64 MiB 时在页面内提醒。

### 素材批次验收

整理完一组素材后，Agent 用 `review_batch` 把实际写请求归入一张验收单。宿主读取块历史中的改前、改后快照，使用当前块与字段定义生成差异。声明 `effect: 'data'` 的同步命令，只要独立编辑有历史的持久附加块即可参与，包括外部插件定义的新块、笔记、组成员关系和动态字段。身份、结构、依附关系、原件、无历史写入和依据集合顺序回写排名的操作均不能生成通用差异。一笔命令混有这些写入时，带 `taskId` 执行会整体回滚，普通命令执行后的补单会返回 `REVIEW_UNSUPPORTED`。插件可用 `reviewable: false` 排除其他具有跨项业务约束的命令。

标量与 JSON 显示字段前后值。无重复的非空字符串列表在保留成员相对顺序不变时按增删展示，其余列表保留整个有序值。引用保留原始 ID，页面同时返回可解析的 `referenceTitles`，每页最多查 200 个引用目标。

1. 对未关联整理任务的写入，在该写入所在的核心会话中调用 `review_batch({libraryId, action:'create', title, requestIds})`。相同请求集合返回原单。成功但没有写入的请求列在 `unchangedRequests`，近期空回执按会话保留最近 1000 笔。未知请求、撤销历史缺失、与其他批次重叠、有其他操作穿插在同一块的所选写入之间时均返回明确错误。
2. 用 `get_workbench_session` 取得现场，把返回的 `expected` 原样传给 `present_workbench`，指定 `target: {action:'open_review', batchId: batch.id}`。用户可以在验收卡片看到缩略图与每个标签、星级、字段的变化，点素材名称可在检查器中修正。关闭页面后可从「操作历史 → 批次验收单」再次进入。
3. 卡片上的「撤回此项」只处理该素材。MCP 对应 `review_batch({libraryId, action:'withdraw', batchId, ids:[id]})`，一次可指定 1～100 个 ID，未知 ID 会拒绝整个请求。决定保存在素材行的 `withdrawnBy/withdrawnAt` 中。仍有待处理项时单据保持 `pending`，可继续确认或撤回剩余项。全部逐项撤回后自动结单。获得用户委托时，外部客户端可用 `review_batch({libraryId, action:'confirm'|'withdraw', batchId})` 代办，回执的 `decidedBy` 区分应用内操作与外部调用。撤回在一个事务内完成，保护后来修改的列表成员、字段以及当前不可用的素材和模板。即使改后又改回同值，验收单也保留这次接手。如模板结构版本已变化，对应模板值保持现状。同一决定可重试，另一种决定返回 `REVIEW_DECIDED`。
4. 用 `action:'list'` 查本库的单据，用 `action:'get', batchId` 查按素材分页的差异。两者都支持 `offset/limit`，每页最多 50 项。`read` 可查阅，建单和决定需要 `organize` 或 `admin`。已建单和决定随仓库保存，断开客户端或重开仓库后仍可查阅。回执描述当时的决定，之后的普通编辑或撤销仍以素材当前值为准。

每单最多 100 个请求、2000 处净变化、512 KiB 源历史值。同库最多 64 张待处理单，另保留最近决定的 64 张。永久清除相关素材或清理所属插件的持久数据会一并移除相关单据及其差异。

### L2 工作台会话（2026-11-17）

这两个工具读写当前 UI 会话，不增加核心数据库入口。设置 → AI 接入 · MCP 的既有仓库权限同时控制它们。整窗截图和开发加载不属于日常权限。

- `get_workbench_session({libraryId, tabId?, offset?, limit?})`：不隐式开库或激活窗口。默认读取最后的操作页，可显式读取某个可见分屏；原生焦点以 `windows.focused` 为准，`null` 表示本库没有原生焦点，`settings` 不能当成素材页。内容窗口 ID 是 `content:<groupId>`。返回活动页、分页标签目录、分组及目标页。非可见页为 inactive；集合挂载中为 loading；定制页未接入为 unsupported，不把冻结存档当现场。
- 集合的 `query` 是当前生效查询，包含基础规则、临时筛选、搜索及动态身份范围。`selectedIds` 按结果顺序返回；最多 1000 项并附总数与截断标记。`renderedIds` 是布局已挂载的身份（包括虚拟列表的预渲染范围），最多 100 项；不等于当前结果全集。超过 16000 字符的查询整体省略并标 `queryTruncated`，不截掉条件冒充完整查询。标签目录默认 30、最多 50 项，分组摘要最多 50 项。
- `queryVersion` 在查询启动或列表失效时前进，`resultVersion` 在结果提交后前进，`renderedVersion` 来自布局 DOM 提交回报。`state=ready` 要求三者一致；其余为 querying / error / rendering / unsupported。ready 不保证封面图片解码、后台加工或屏幕像素完成；加工另查 get_processing_status。旧布局仍可用，但 renderedVersion=null，不虚报完成。
- `present_workbench({libraryId, requestId, expected, target})` 要求 organize/admin。`expected` 原样取自最近一次读取；在执行前再次检查窗口版本、会话、页面、筛选及选区，切换本库窗口、标签页或显隐会使凭据失效。切到外部 AI 客户端时 windows.focused 反映实际失焦，目标窗口、页面和选区稳定时仍可用原 expected 推送。单纯后台结果刷新只推进查询版本，不冒充用户切换上下文；执行定位时仍核对最新结果与渲染状态。`CONTEXT_CHANGED` 后重新读取，`SESSION_CHANGED` 表示页面重载。动作只在指定可见页上执行，不改用户数据。
- `target: {action:'reveal', ids}`：最多 100 项，只接受当前已就绪结果内的身份，滚到第一项并高亮全部目标。没有命中的项报 ITEM_NOT_IN_VIEW，布局未接入报 LAYOUT_UNSUPPORTED。高亮独立于用户选区，可点「清除高亮」，更换查询时自动清除，不进存档或撤销历史。
- `target: {action:'open', title, query}`：在目标组另开瀑布流结果页；`{action:'open_view', viewId}` 另开本库保存视图，复用其规则和布局。保留原页面、选区和草稿；不修改保存视图、默认布局或永久编排。参数查询沿用公共查询输入约束。
- 返回 `state=accepted` 和 `tabId` 仅说明工作区接纳。随后读取该 tabId，等待 collection.state=ready；定位还应匹配回执的 revealToken 与 collection.reveal.token，且 reveal.state=rendered。后者记录目标曾进入视口并提交，不代表用户之后没有滚走。会话内保留最近 50 次成功请求；原 ID/原参数重试返回旧回执，**不会再次激活页面**。重载清空回执，旧 sessionId 无效；不要在长期任务中把它当持久业务幂等记录。

首批内置瀑布流实现完整定位／渲染回执。外部布局按[浏览布局](浏览布局.md)的 workbench-session-v1 契约接入；公共 CollectionSurface 自动提供查询和选择现场。要把标签、评分和字段值的修改交给用户核对，可打开已建立的[素材批次验收单](#素材批次验收)。


### 开发／验收模式与仓库生命周期（2026-11-18）

在「允许 AI 新建仓库」给 admin 创建策略勾选「允许 AI 自主开发插件」，此后创建的库可自行创建、构建和应用插件工程。普通 admin 和旧创建任务按原授权接续。仅开启自主开发时，在日常工具外发布下表前四项。编写源码使用客户端自己的工程文件编辑能力。安装版初次需在本机指定开发工具工程，源码版默认使用本宿主。新库固定授权时的工具工程，静态包的跨库许可另行管理。

在「应用设置 → AI 接入 · MCP → 开发与验收」开启手动开发验收模式，可发现全部六项工具。客户端切换后刷新工具列表或重连。离线或连接配置不可用时仍可发现日常接口，实际调用保留配置诊断。仅隐藏工具不作为权限保证：应用端逐次核对应用开关、目标库 admin 及所需的自主开发或手动验收许可。窗口截图另需该库截图许可。

要接手已有的手工维护工程，在目标仓库插件设置添加源码目录与开发工具工程，然后在「开发与验收」中找到该库，通过「开发验收许可」批准具体源码。许可绑定规范化目录、插件 ID 和工具工程；远端只能提交 sourceId，不能自行添加路径、授信、传命令或更换工具工程。仅有 admin 时仍需明确开启相应开发许可。这里信任的是会持续修改的源码目录，并非一个固定哈希；构建本身可以执行受信代码，不是沙箱。

| 工具 | 行为 |
| --- | --- |
| create_development_project | 需要目标库自主开发许可。传 pluginId、title、requestId，返回 source、sourceId 和 toolchain。每库最多 32 个自主工程，目录登记沿用 32 项上限。工程与本机身份绑定，已有正式插件或其他来源 ID 冲突时报 PLUGIN_ID_CONFLICT。相同请求保留已有源码，改参报 REQUEST_CONFLICT |
| get_development_status | 返回获准来源、build.state、availableHash、appliedHash、配置 revision、会话 session 和现有运行状态；可按 requestId 查询回执。关闭的库也能查，不开库、不启动监听 |
| prepare_development_build | 对最多 32 个获准 sourceId 启动既有构建／监听；失败可 retry=true。轮询到 build.state=ready 后再决定应用 |
| apply_development_build | 提交 selection=[{sourceId,hash}]、revision、session、requestId；先保存页面再应用快照并重载。selection 是本次获准范围的完整选择，省略已启用来源会退出它的开发覆盖，范围外覆盖和正式绑定保留 |
| control_library | action=close/reload，绑定 session 和 requestId。复用正常页面收尾、核心与服务生命周期；不提供强制关闭、杀进程或退出应用 |
| capture_workbench_window | 明确传 main 或 content:组ID；session 来自开发状态，windowId 来自工作台会话 windows.windows，windowRevision 使用 windows.revision。只截本库可见、未最小化的内容窗口，拒绝设置窗口；返回原生 MCP JPEG，maxSide 默认 1280、范围 256–1600，字节最多 2 MiB |

应用与生命周期操作返回持久回执，state=pending/completed/failed/interrupted，另有 running、saved、error。pending 继续查询；saved=true 只说明开发选择落盘，不代表装配和界面可用。completed 是历史事实，之后仍查 runtime、业务数据和页面。相同 requestId 与参数只返回原回执，不重开、重载或关闭新会话；改参返回 REQUEST_CONFLICT。进程中断后的 pending 显示 interrupted，不自动重放；失败或中断应先核对当前事实，用新 requestId、session、revision 明确发起下一次操作。

UI 与 MCP 共用本库插件配置互斥。页面拒绝离开时保留现场；应用前检查来源、版本与许可，截图回传前再检查许可和窗口版本。关闭手动开发验收模式立即停止手工来源、窗口截图及生命周期调用；已另行授权的自主工程仍可构建与应用。关闭应用 MCP 可暂停全部外部调用。撤销许可保留已有源码和快照；不卸载已经运行的插件，也不取消已派发的生命周期收尾。它不是数据回滚。整窗截图只证明该时刻的像素，素材加工与列表渲染仍用各自状态确认。

正常流程是：首次本机授权 → MCP 构建／应用 → describe_library → 导入与业务 operations／queries → 等待加工、read_preview → L2 展示 → 验收截图 → 正常关闭／重开并读回。进程强杀、断电注入与重新启动整个应用仍由外层测试程序负责；批次 diff、签收与整批撤回不属于此接口。
