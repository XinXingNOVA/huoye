# 公共后端 API：数据、命令与对外能力

架构分类见[公共 API 总览](公共API总览.md)。本文重点是仓库核心与插件声明；`CoreClient` 同时承接部分文件空间及跨层流程，方法挂在 `host.core` 下不代表只影响仓库。

核对日期：2026-10-18；入口说明于 2026-11-06 校正。面向可信插件；配合[插件开发指南](插件开发指南.md)和[公共 UI API](公共UI%20API.md)使用。外部包已开放静态数据定义、核心命令、加工、导出、operations 与 queries，使用 `@resource-manager/plugin-api/…` 导入；现支持显式声明的受控动态附加字段定义，另支持不改原值的有限结构接续，暂不支持任意迁移函数，详见[本地插件使用与开发](插件开发指南.md)。仓库级本机服务也已开放，见[外部本机服务](外部本机服务.md)；应用级服务仍仅随宿主编译。当前 `apiVersion: 1` 精确匹配，没有独立发布的 npm SDK、长期 API 冻结或不可信代码隔离。

## 1. 公共入口与责任

| 入口 | 提供什么 |
| --- | --- |
| [core/contracts.ts](../../src/plugin-api/core/contracts.ts) | `CorePlugin`、识别器、加工、命令上下文、导出器和导出片段契约；`inputSpec` 纯函数 |
| [queries.ts](../../src/plugin-api/queries.ts) | `QueryDefinition`、独立只读 `QueryContext` 与 `queryPageSchema`；完整接入见[插件业务只读查询](插件业务只读查询.md) |
| [ingest.ts](../../src/plugin-api/ingest.ts) | `IngestMetadataDefinition`、当前素材上下文与处理结果；完整接入见[导入附加内容](导入附加内容.md) |
| [core/process.ts](../../src/plugin-api/core/process.ts) | `run(program, args, { signal, onLine? })`：通过参数数组启动外部程序，取消时终止子进程，失败带 stderr 尾部；无 `onLine` 时返回 stdout Buffer |
| [operations.ts](../../src/plugin-api/operations.ts) | `OperationDefinition`、操作请求／回执类型、`parseInput` 与 JSON Schema 转换 |
| [urls.ts](../../src/plugin-api/urls.ts) | `siteOf(url)` 纯函数：HTTP(S) 网址提取网站名，去掉 www，非法值返回 `undefined`；不依赖来源包 |
| [core.ts](../../src/plugin-api/core.ts) | 界面调用核心的异步 `CoreClient` 类型；不是运行实例，也不是权限令牌 |
| [shared/blocks.ts](../../src/shared/blocks.ts)、[query.ts](../../src/shared/query.ts) | 数据定义、字段和值、查询的公共语义 |

核心插件通过参数得到 `IngestContext`、`JobContext`、`CommandContext` 或 `ExportContext`，不导入 `Host`、`Store`、数据库、窗口或 MCP 实现。`src/core/plugin.ts` 只保留宿主内部兼容转发，插件不得依赖这个旧路径。

加工观察（2026-11-17）：界面插件可调用 `host.core.processingStatus({ids, kinds})` 读取最多 100 项、16 种数据块的当前状态，`processingSummary()` 取得全库调度计数；需声明 `uiFeatures: ["processing-status-v1"]`。类型从 `plugin-api/core.ts` 导出。它们只读，不触发重算或按需加工；状态及版本语义见[服务插件 API](服务插件%20API.md#仓库运行状态与本批加工2026-11-17)。有界等待与跨库授权由应用服务负责，核心接口只提供一次快照。

素材预览（2026-11-17）：界面插件声明 `uiFeatures: ["read-preview-v1"]` 后可调用 `host.core.readPreview({ids, mode?, maxSide?, expectedRevisions?})`，返回有界 JPEG 及编号／版本映射；类型 `ReadPreviewInput`、`PreviewResult`、`PreviewItem` 从 `plugin-api/core.ts` 导出。复用 still / thumb 及文件读取协议，不接受外部路径，不修改派生缓存。参数、版本与失败语义见[服务插件 API](服务插件%20API.md#素材预览与导入快等2026-11-17)。MCP 原生图像转换留在协议层，核心不依赖 MCP。

音频与视频共用 `core/process.ts`；程序依赖仍由插件声明，通过 `ctx.program(name)` 取得路径。它是可信核心插件的执行工具，不提供沙箱、任务调度或持久化；长任务用 `onLine` 接收进度，避免把进度输出全存入内存。输出到临时文件的命名、成功替换与失败清理由加工自身负责。

跨平台约定（2026-10-14）：写入数据块的文件路径统一为使用 `/` 的库内相对路径；拼接用 `path.posix.join`，实际访问交给 `ctx.abs`。`ctx.cacheDir` 也返回这种路径。宿主读取兼容已有的反斜杠记录，不批量改写用户数据。外部程序优先从发布包目录查找，再找 PATH；Windows 自动匹配 `.exe`。插件继续声明程序名称，用 `ctx.program` 取得绝对路径，再用参数数组执行，不自行寻找 Homebrew、调用 shell 或硬编码安装位置。公共进程工具在 Windows 隐藏控制台窗口。

素材身份、字段值、定义快照与已接纳文件引用属于仓库；原件的身份、定位和物理管理归文件存储层。插件定义含义并提供行为，核心负责校验、事务、事件、历史、调度及停用后的通用访问。原有数据和插件 ID 不变；批注旧版本仅推进结构版本元信息，详见末节。

## 2. 普通命令与对外操作

`commands` 是同步业务行为。界面可以调用 `host.core.run(pluginId, command, args)`；命令读取最新记录，表达增删或修改的意图，由核心执行一次事务和撤销。简单字段编辑仍可用通用 `patch`，不要求每个输入框都新造命令。

`operations` 显式选择可以对外调用的同步命令或收录输入映射，并给出稳定名称、说明和输入 schema。它不复制业务实现，不授予连接权限。未声明的命令不进入工具列表。

```ts
import type { CorePlugin } from '../../plugin-api/core/contracts'
import { parseInput } from '../../plugin-api/operations'
import { z } from 'zod'

const input = z.object({ id: z.string(), text: z.string().min(1) }).strict()
export const plugin: CorePlugin = {
  id: 'example', version: 1,
  // 此例略去自己的 blocks 声明。
  commands: {
    update(ctx, args) {
      const { id, text } = parseInput(input, args)
      ctx.put(id, 'example', { text })
      return { label: '更新记录', result: { id } }
    }
  },
  operations: [{ effect: 'data', name: 'update_example', title: '更新记录', description: '修改记录正文', command: 'update', input }]
}
```

2026-11-17：每个对外写操作声明 `effect: 'data' | 'structure'`。给已有素材填值、标记、收录用 data；创建／修改分类词表、模板或规则等结构用 structure；一个操作兼有两种影响时按 structure 声明，或拆成语义独立的操作。外部包同时声明 `coreFeatures: ["operation-effects-v1"]`，旧宿主会拒绝未知契约。可信插件负责如实分类，这不是 Node 代码沙箱。

独立的持久附加块可由宿主按字段生成验收差异并按素材撤回。若一个命令必须一起维护多个素材的业务约束（例如互换配额），在该 operation 上声明 `reviewable: false`，包的 `coreFeatures` 加入 `operation-review-v1`。该命令仍按原权限执行并保留会话整体撤销。

应用 MCP 只允许 organize/admin 执行 data，admin 执行 structure；未声明分类的旧包仍能加载和供 UI 使用，但不再通过 MCP 执行。`describe_library.blockedOperations` 说明迁移原因。调用方不能传 effect 覆盖分类；原件与应用包权限另行校验。宿主通用仓库回收工具仅开放 trash/restore，admin 也不允许永久清除。

对外输入在核心再次按 schema 校验；命令自身也要校验业务规则，使界面与外部调用具有相同语义。操作名唯一且不得占用保留名称，输入须为对象且不得声明框架使用的 `requestId`。

2026-10-30 起，普通编辑与命令上下文共用以下写入约束（`run`、`preview` 和 operation 一致）：

- `put` 的身份必须已经存在，也可以是本命令刚用 `createEntity()` 创建的；拒绝写出无身份的数据块。
- `put/remove` 不可修改可重建块；派生结果由加工系统产出。普通持久业务块仍可按公开数据契约协作，不增加一刀切的插件私有写入限制。
- 已有 `file` 块只允许改变仓库显示名称，`path/hash/size/ext/mime` 必须保持。原件离线或已回收不妨碍改显示名。不能用命令换文件引用、挂新文件块或移除文件块；收录、新版本与独立副本继续使用文件协议。
- 管理块只能由所属插件命令写入，删除走 `deleteRecord`；普通 UI 编辑仍按管理块自身规则校验。动态来源删除后，可以继续移除素材上失去定义的旧值，保证删除与撤销完整。
- 校验失败时，未被业务捕获的异常使当前命令的所有写入、历史和 operation 回执一起回滚。核心检查不替代插件对“是否允许修改回收站素材”等业务规则的判断。

显式 `CoreClient.create({ file: … })` 保留原有的合法版本引用校验，只创建新的仓库身份，不替换其他素材或发布原件；新文件通常应使用收录。导入、版本接纳、加工和历史重放有各自的内部写入路径，不受普通编辑限制。接口形状及包 API 版本不变；此前依赖上述漏洞的插件需要改用对应公开能力，已有数据不会被批量改写或清理。

[Operations](../../src/core/operations.ts) 负责操作发现、校验、执行和持久回执。数据修改与回执同事务，失败一起回滚；超时重试复用 `requestId`，新意图使用新 ID。同一 ID 用于不同参数会拒绝。撤销后重试仍返回原回执，不重新执行；回执说明原操作，不能代表当前数据。外部操作的历史前缀为“外部 ·”，不把协议或调用者预设为 AI。

### 收录操作（2026-10-14）

`OperationDefinition` 现在有互斥的两种形式：`command` 指向本插件同步命令；`ingest(args)` 同步把已校验参数映射为 `IngestInput[]`，交给宿主的既有识别器管线。后者不是任意异步命令，不能自己持有数据库事务。MCP 自动发现这两类操作，无需增加业务分支。

```ts
operations: [{
  name: 'import_files', title: '收录本地文件', description: '收录明确指定的文件',
  input, // 应限制路径类型、长度和批次大小，参考 file/core.ts
  ingest: args => (args.paths as string[]).map(path => ({ type: 'file', path }))
}]
```

`Ingesting` 在每库串行准备收录：识别器得到的是暂存上下文，`createEntity / put` 在提交前不可见，`importFile` 只接受本次新建身份。完成后一次事务提交新身份、初始块、来源钩子、恢复状态、历史与操作回执；UI 收录也使用这条管线。`afterIngest` 仍是同步钩子，不得异步复制文件。准备过程中查重依据变化时返回 `INGEST_CHANGED`，没有提交，原请求 ID 可重试。新建素材的撤销只移入回收站，初始内容及原文件索引保留。

返回 `IngestResult`：`items[{ index, id, outcome }]`、`errors[{ index, message }]`、`processing: 'not_waited'`。逐项读取／复制错误不会阻止其他项准备；成功项在一笔事务里落库，提交阶段失败则仓库修改全笔回滚、不留成功回执。已独立保存到空间的文件不随仓库失败删除，见下段。批次没有任何成功项也会保存失败回执，修正后应使用新请求 ID。收录返回不等待派生加工；`readItem` 增加当前 `processing: pending | idle`，结合 `failures` 和字段判断结果。

`Operations` 合并进行中的同参请求，拒绝并发 ID 冲突；断线或超时后同 ID 继续等待或读取已保存回执。2026-10-26 起，文件先保存到默认写入空间，仓库持久保存未收录草稿；空间已保存但仓库失败返回 `FILE_STORED_NOT_ADOPTED`，原请求重试可复用已保存字节并重新校验业务条件，重启也有效。尚未完成全部保存时重试仍可能需要原输入。没有启动自动重试或后台续传；正常关库取消当前工作，已保存文件保留，已提交回执保持不变。跨介质中断可能留下未收录文件或待保存记录，当前不自动清理。原始输入文件始终保留。

2026-10-18：宿主 `CoreApi.ingest` 接受 `ImportInput[]`，在文件／文字输入之外增加 `{ type: 'bytes', name, bytes: Uint8Array, source? }`，用于剪贴板或无本地路径的文件。单份必须非空且不超过 32 MB，名称按跨平台文件名规范处理。核心先写本次暂存目录，再转换为普通文件输入；识别器和 `afterIngest` 仍只接收原有 `IngestInput`（file／text），无需更改插件或数据定义。暂存路径仅本次接入有效，不得作为素材永久路径保存，使用 `ctx.importFile` 的返回值。正常成功／失败均清理暂存；强制退出仍有上述文件系统限制。MCP 的 `import_files` 仍只接受明确本地路径，没有因此开放任意网址或二进制写入。

当前实例：文字插件的 `create_text → text.create` 创建正文和可选标签／来源；文件插件的 `import_files → ingest` 声明本地路径输入；标签仍用 `update_tags → tags.update`。文字数据照常参加搜索、阅读和导出，没有引入专用“AI 摘要”类型。

耗时解码、联网或生成不应在同步命令事务中执行；加工用 System，其他耗时工作完成后再提交明确命令并核对输入版本。文件修改必须使用上下文中可撤销的能力；直接 Node 外部副作用不能自动回滚。

### 文件空间的候选收录

2026-10-26：核心新增 `listFileSpaces / listSpaceFiles / adoptSpaceFiles`，空间的建立、关联和模式由宿主管理。候选收录复用 afterIngest 与 ingestMetadata，插件不必另写“从空间导入”的分支。直接文件导入按默认空间去重；候选以 spaceId/fileId 接续，不能只凭内容哈希合并不同文件身份。新路径是 opaque ref，继续使用 ctx.abs / host.abs / host.url；不要拼 root 或解析路径。

应用 MCP 对应 `list_file_spaces / list_space_files / adopt_space_files`，收录仅允许 organize/admin，不能传新路径建立关联。示例与权限见[文件存储层](../architecture/文件空间.md)。当前 revision 仅用于变更校验，共享原件仍只读，不是共享版本库。

### 仓库导入策略与组合入口

2026-11-04：有条件视图的交互使用 `previewViewImport(inputs, query)` 做只读、保守的输入预检，未知派生／搜索条件不会被当作匹配。`importToView(inputs, {requestId,query,allowUnmatched?:number[]})` 只接收已展开、已选择的输入，例外下标须来自明确选择，其余项在导入事务中执行完整准入；失败回滚仓库修改，准备阶段保存的空间文件保留。Query 和选择参与签名，原请求原参数可重试，不改变原 `importToLibrary` 签名或 MCP 导入行为。详细语义及限制见[查询与视图](../architecture/查询与视图.md)。

2026-10-26：`getImportSettings()` 只读当前配置及关联空间数量；`setImportSettings({defaultSpaceId,collect,spaces:[{spaceId,automatic}]})` 在仓库保存策略，立即生效。UI 单次导入使用 `importToLibrary(inputs, {requestId,spaceId?,collect?})`，默认采用仓库策略；`importFiles({requestId,files,spaceId?,collect?})` 是只接受明确文件路径的外部适配。返回 `ImportReport`，含 `saved`（空间文件身份）、`items`（仓库素材）、`errors`、`collect`、`spaceId` 与 `processing`。

只保存时不会写业务块，来源／ingestMetadata 意图暂存于本仓库，后续收录继续调用已启用插件。停用插件或业务引用失效会使收录失败并保留文件；不要绕过声明直接写入未知数据块。重试保持 requestId 和原输入，目标与策略使用原任务快照。旧 `CoreApi.ingest`、`OperationDefinition.ingest` 及 `import_files` 保持立即收录的返回契约，不受 collect 默认值影响。

`scanSpaceImports()` 是有写入效果的仓库检查，不能放入通用只读查询。UI／启动流程调用，返回本次 collected、remaining、errors；不开放为只读 MCP 工具。MCP 仅新发布 `get_import_settings`（读）与 `import_to_library`（organize/admin 写），配置修改仍在 UI。规则和有界检查范围见[仓库导入配置设计](../README.md)。

## 3. MCP 的位置

2026-10-20 增加公共能力：`IngestMetadataContext.readEntity(id, kinds)` 在导入提交事务中只读检查其他实体；`CommandContext.trash(ids)` 将普通素材移入回收站，保留 link 成员并沿用 attach 生命周期，支持当前命令事务、预演和撤销。外部包分别声明 `ingest-read-v1`（同时需要 `ingest-metadata-v1`）及 `command-trash-v1`。同日补齐 `CommandContext.restore(ids)` 与 `command-restore-v1`，沿用已有恢复规则，支持同一事务／预演／撤销，供业务插件发布恢复 operation。不开放彻底删除，不新增 MCP 业务分支。命令调用统一检查同步与上下文生命周期。限制和示例见[事务内引用检查与回收](事务内引用检查与回收.md)。

2026-10-19 增加 `CorePlugin.ingestMetadata`：导入可携带插件声明的业务意图，由核心按 schema 预校验、在收录事务中执行。MCP 通过 `describe_library.ingestMetadata` 发现，用 `import_files.files[].metadata` 传入；插件决定合并／保留规则。写入限制在当前素材、本插件普通持久块，外部包需声明 `ingest-metadata-v1`。参数、状态、示例与限制见[导入附加内容](导入附加内容.md)。

调用链为：AI 客户端 → MCP 协议适配 → 宿主连接权限检查 → 核心读取／操作服务 → 插件业务命令。

- 搜索和读取复用字段定义、搜索声明及核心读取服务，普通插件不必另写一套 MCP 读工具。
- 应用 MCP 的 `describe_library` 发布通用操作描述、`execute_operation` 按目标库调用；不再把各插件操作转换成同名 MCP 工具。插件无需引用 SDK、声明依赖 MCP 或维护 MCP 工具名单。
- 关闭接入后，插件的界面和核心行为仍可用。插件停用后，相关对外操作撤下，旧数据仍能读取。
- 连接凭据和关闭／只读／可整理权限由[宿主连接层](../../src/main/application-access.ts)执行，存在本机配置。可发现读工具不等于可以访问离线或未授权仓库。
- 业务写入只开放已声明操作，不代理任意 `run / put / purge / undo`；另有宿主提供的、有预览和回执的通用仓库生命周期工具。尚无逐操作授权界面。

MCP 已正式作为 `src/plugins/mcp/plugin.json` 声明的可选内置插件，通过 `scope: application` 的服务入口、应用设置分区和独立程序声明统一装配。协议、设置与样式归插件，生命周期和授权检查归宿主；具体契约、配置归属和停用语义见[服务插件 API](服务插件%20API.md)。

## 4. 格式导出贡献

`exporters` 决定一个身份写成什么文件。宿主按优先级选择一个实现，处理命名、进度和失败；可选 `bytes` 提供预览字节估算。`ExportContext.findByField` 提供通用索引查询，文件名链接等解释属于使用方。

`exportSections` 决定某些字段怎样出现在索引和其他导出格式中：

| 声明／结果 | 含义 |
| --- | --- |
| `id / kind / fields` | 稳定贡献 ID、所属数据块、接管的字段；限于本插件静态定义，禁止重复认领 |
| `order` | 小值优先，同序按 ID；只控制片段顺序，不覆盖其他贡献 |
| `render(data)` | 同步纯呈现；返回 `undefined` 时不接管字段 |
| `properties` | 供其他导出器复用的结构化属性；`key` 指定机器格式名称，`index: false` 表示已有专用段落，不重复列属性行 |
| `markdown / inline` | 完整段落／作为附属记录时的一行片段；未给 inline 时使用贡献的属性摘要 |
| `content` | 本片段已完整输出身份内容，必须同时有非空 Markdown；例如文本和 PDF 摘录没有独立文件也算成功，附属列表也使用完整 Markdown 而非短摘要 |

当前实例：笔记提供引文段落与 front matter 属性；标签提供 `tags` 属性名和行内标签；批注提供摘录、PDF 页码、时间段说明。文字导出器消费属性，不再判断笔记和标签的具体块。宿主从仓库引用索引判断依附关系，不再判断 `anchor`。

没有被接管的普通附加字段继续按定义输出；插件停用时回到通用字段表示，不承诺保留插件的专用排版。片段抛错会报告，并保留该字段的通用输出。没有文件导出器或完整内容片段时，仍提示使用“取回数据”。格式导出不保证保存全部数据；完整字段和原文件应走核心取回流程。

## 5. 边界检查与验证

[后端边界检查](../../scripts/checks/core-boundaries.ts) 随生成、类型检查、构建与测试执行，遍历实际核心入口、辅助文件、类型引用、重新导出及静态动态导入：

- 插件不得引用 `core / main / renderer / preload / mcp` 私有文件，或公共 UI／注入实现。
- 核心入口允许 Node 和媒体解码库；禁止直接导入 Electron、宿主 SQLite 库、React 与 MCP SDK。服务／独立入口另允许协议 SDK，只使用公共服务契约，不获得核心上下文。
- 公共契约和共享模块不能反向引用插件或装配；跨插件从公开的 `blocks.ts / extension.ts` 进入，不直接依赖私有文件。
- 模块路径须可静态检查。此检查不递归证明第三方包、不追踪任意变量别名，也不限制可信后端的全部 Node 权限。

`tests/integration/core-api.test.ts` 用独立插件验证搜索、界面命令入口、对外操作声明、重试、撤销、停用和导出，另覆盖违规依赖与贡献冲突。`tests/integration/export.test.ts` 验证原有输出、PDF 摘录、启停、错误回退及原文件。`tests/integration/automation-create.test.ts` 验证创建、异步导入、并发回执、部分失败、回收站保留、关库取消和重启；`mcpcreate / mcpcreateresume` 用真实 MCP 直接创建、导入新文件并检验重启。`CAPTURE_FLOW=appmcp` 从零仓库启动，验证应用设置、创建和打开仓库、多库权限、新 PNG／TXT 加工与原文件字节；同用户目录运行 `appmcpresume` 验证重启。格式导出和片段合并另由核心导出测试覆盖。

## 5. 插件管理记录

数据是否由插件产生，不决定它是不是素材。模板定义／标签分组／保存视图声明 `standalone: true, management: {}`；内容、原文件、摘录和素材上的模板字段不声明。宿主验证管理块不可重建、保留历史、不带内容／文件字段，并把管理角色写入定义快照。

命令用 `ctx.deleteRecord(id)` 删除本插件管理身份。插件先在同一命令中处理受影响数据：例如模板插件先移除所有使用处的字段块，再删除定义。宿主负责物理身份、索引、通知与整笔撤销；命令可以经 `preview` 预演。不能用 `ctx.remove` 移除管理定义而留下空身份，也不能通过该能力删除其他插件的管理记录或带文件／内容／未知块／依附者的异常记录。

`management: { emptyWhen: 'groups' }` 声明空容器的列表字段：启动仅清理已启用插件、该列表为空、没有其他块和依附内容的记录；不要用于仍有独立价值的空记录。停用不触发清理。

查询 `role: 'management'` 配合 `scope: 'all'` 获取当前管理记录，配合 `scope: 'trash'` 获取旧版已移除的管理记录。MCP 业务写入通过已登记的操作执行。

### 容器与普通素材

可浏览、可回收的文件夹等身份在不可重建的内容块上声明 `content: true, container: true`。外部包在 `coreFeatures` 中登记 `entity-roles-v1`。只选普通素材时使用 `role: 'material'`，只选容器用 `'container'`，两者一同浏览用 `'browse'`。`scope` 独立控制内容、全部在库身份或回收站。省略角色时 `content/trash` 默认浏览，`all` 还包括管理记录。

普通附加块默认适用于素材。确实也适合容器的块可声明 `allowOnContainer: true`。需要处理容器的右键操作、选择命令和检查器分区可声明 `includeContainers: true`，分区的 `kinds` 直接列有容器定义时也会纳入。旧插件升级容器定义时递增数据块版本，提供原定义的 `compatibleSchemas`。旧附加值继续保存在仓库里，停用容器插件后仍按快照识别角色。

## 数据驱动的动态定义

外部包的 `plugin.json` 可声明 `definitions: { "kind": "my-plugin-schema", "prefix": "my-plugin:" }`。核心 `defines` 必须声明同一 `kind`、`prefix` 和纯函数 `build(entityId, data)`；来源是本插件不可重建、保留历史的独立管理块。每份来源记录生成一个 `prefix + entityId` 的块，`plugin` 属于本插件，`template` 指回来源身份。

首版生成的是 version 1 的附加字段：text、longtext、number、boolean、date、enum、color、json；允许列表、选项、索引、文字搜索、格式、数值范围和文字呈现声明。不能声明原文件、引用生命周期、内容类、管理类、可重建数据、自定义校验函数或迁移函数。输出严格校验后才注册；纯函数不得读取外部状态、写库或产生副作用。可信代码仍未隔离，校验并不构成沙盒。

宿主先校验来源并传入副本，启动时将已有模板的生成结果与持久快照核对；包升级不得改变已有数据的解释，失败只停用该包并保留旧快照供基本读取。来源块及前缀契约首次启用后也固定，空库同样不能通过更新移除定义器。用户主动编辑模板仍通过插件命令：定义变更、值转换、索引、快照、历史在同一事务；失败、预演或撤销后恢复对应定义。

动态快照由核心按使用情况回收（2026-10-29）：`template` 是公共的来源身份标记，不限定字段插件或 `tpl:` 前缀。来源身份和来源块均已不存在，且主库、派生库都没有使用此 kind 的数据块时，才删除 `kind_def` 的对应快照。删除块／身份的外层事务在提交前检查一次，开库时同样清理旧残留；没有后台定时扫描，也无需插件调用清理接口。回收站中的来源或值仍算使用，停用／卸载不等于无用，异常残留也保守保留。

撤销历史不删除，先恢复来源记录、再生成定义与快照、最后恢复字段值；预演或失败会连同快照清理一起回滚。静态定义及 `externalSchema`／`externalDefinitions` 兼容契约不参与回收。逻辑删除不会自动压缩 SQLite 文件，释放的数据库页可供后续写入复用。回归见 `tests/core/kind-snapshots.test.ts`、`packaged-fields.test.ts` 及 Electron `fieldspackage` 的删除／撤销／重做验证。

模板业务、字段转换与删除预演在 [fields](../README.md)，宿主只维护定义的生命周期、校验与事务。普通包使用自己的 `<插件 ID>:` 前缀；`template` / `tpl:` 是应用为旧字段数据登记的迁包例外，分享包不能自行申请。

## 兼容旧结构与图像裁剪

2026-10-15 随批注迁包增加两项显式能力。外部 `plugin.json` 的 `coreFeatures` 可包含 `image-crop-v1`、`compatible-schemas-v1`；需要 core 入口，不接受未知／重复值。较旧宿主会拒绝这份声明，因此需要先更新应用。

### 保留原值的结构接续

`CorePlugin.compatibleSchemas: BlockKind[]` 冻结完整历史定义，不从当前定义减字段生成。每项必须属于本插件当前已有的静态持久块，版本小于当前，且不与 migrations／动态定义来源混用。宿主只允许新增字段、增加枚举选项和改变 `display`；既有字段定义、身份归属、生命周期、标题、引用、索引和其他元信息保持。新增／删除持久块、删除字段、改字段类型、改归属、任意函数转换均未开放。

加载前比较仓库快照及 `externalSchema` 契约，必须精确匹配当前或声明的历史定义。现存旧版记录的版本必须已声明；现存数据与相关撤销历史按新定义规范化后仍须完全等值。通过后仅更新 `schema_ver`，不改原数据、写入 `seq`、历史和引用索引。Host 将快照、包契约与版本更新放入一个数据库事务；失败回滚，加载预检失败只停用对应插件并保留休眠定义。休眠记录不自动迁移；已升级后降级包会被拒绝。

这是有限的兼容接续，不是任意数据迁移框架或备份恢复。`validate` 和这些声明都来自可信代码，仍无副作用沙箱。模板动态定义继续适用上节的独立规则。实际案例为 [annotate/schemas.ts](../README.md) 中 v1→v2 锚点：原三类局部保持，新定义增加 PDF 类型与字段。

### 图像运行原语

`SystemContext.images.crop(options, signal)` 的类型位于 [core/images.ts](../../src/plugin-api/core/images.ts)，可在加工的 JobContext 使用：

```ts
await ctx.images.crop({
  source: String(target.still.data.path),
  destination: `${ctx.cacheDir('locals')}/${id}.jpg`,
  region: { x: 0.1, y: 0.2, w: 0.4, h: 0.4 },
  maxSide: 1200,
  quality: 88
}, ctx.signal)
```

输入为库内相对路径（兼容旧反斜杠记录），输出仅限 `cache/` 内 `.jpg`。区域按 EXIF 转正后的比例坐标；最长边限制、不放大，返回输出像素宽高。路径、区域、质量与尺寸校验，拒绝越界符号链接；临时输出成功后替换目标，失败／取消不替换原缓存。原生 sharp 由宿主维护，不把任意原生模块或 node_modules 开放给包。输入选择、加工依赖、缓存键、新鲜度与数据块写入仍归插件和调度器。

纯工具 `format`（`formatBytes` / `formatDuration`）与 `pdf-text`（`normalizePdfText`）可同时被核心和 UI 使用，不携带插件或宿主状态。

回归：`tests/integration/packaged-annotate.test.ts` 检查冻结旧库、真包、兼容与拒绝、写入失败整体回滚、卸载重装；`tests/core/image-tools.test.ts` 检查 EXIF、尺寸、路径、失败与取消；Electron 新文件与界面验证见[使用文档](插件开发指南.md)。


## 文件定位与管理

文件读取用 `ctx.abs(ref)`，不要拼接 `ctx.root`，也不要把得到的物理路径持久写回数据块。收录用 `importFile`；派生输出可写宿主 `cacheDir` 提供的缓存位置。读取接口保持不变，旧引用在过渡期仍可读取。

原件内容修改统一通过[公共文件编辑](公共文件编辑.md)的异步准备、提交和接纳协议；界面插件声明 `uiFeatures: ["file-edits-v1"]`。文件内容由空间版本历史恢复，仓库撤销只处理身份和数据块。`file.rename` 只修改本仓库的显示名称，原件路径与版本不变。

本批移除 `CommandContext.writeFile / renameFile / ensureLocalFile / isSharedFile`、`file.replace` 和 `file-copy-on-write-v1` 能力声明。声明该旧能力的外部包会在校验时被拒绝，不能只删声明继续调用旧 API；应迁入异步文件编辑协议。已安装的读取、加工、标签、笔记等插件不受这些接口退出影响。本轮未发现项目内外部插件调用这组旧接口。

同步 commands / operations 继续只做仓库事务，不得 await 文件发布，更不能用 Node 直接覆盖 `ctx.abs` 返回的原件。通用 `put / patch` 不能改文件内容快照（`path / hash / size / ext / mime`），其他业务块写法不变。需要后台文件编辑时先反馈具体场景，不自行绕过边界。

## 仓库与文件空间的生命周期

`previewItemLifecycle / applyItemLifecycle` 管素材，`previewSpaceMutation / mutateSpaceFiles` 管原件，`previewUnlinkFileSpace` 查关联影响；目标身份、权限、事务与回执分开。仓库 purge 现在统一保留原件，不再调用系统废纸篓。原件回收暂限 UI 中的独享空间；插件 `ctx.trash / ctx.restore` 继续只改仓库记录。MCP 与 UI 的完整契约见[生命周期接口](../architecture/文件空间.md)，不要由插件绕过公共定位直接操作原件。


## 查询条件与保存视图（2026-11-04）

通用 Query 新增 `{ op: "in", kind, field, values }`，同一字段任一值命中，与其他条件取交集。MCP `search_items` 使用同一 schema 与查询执行器；外部核心插件使用新语法时声明 `query-in-v1`。该条件不推导写入。视图准入在写入确定值后验收完整查询，拒绝项回滚，接受项统一撤销。保存规则的版本校验、空值／排序口径、能力声明和限制见[查询与视图](../architecture/查询与视图.md)。


## 会话操作历史

`host.core.listHistory / readHistory` 与 MCP `list_history / read_history` 共用仓库核心历史；`historyChanged` 在事务成功提交后通知。`undo / redo` 可带会话、版本和目标 ID 保护，仍仅操作当前栈顶。operations 自动记录插件、操作及请求来源，插件不必重复实现。范围、分页与回执的区别见[操作历史与 MCP](操作历史.md)。


## 图像采样（image-sample-v1）

加工上下文提供 `ctx.images.sample({ source, maxSide }, ctx.signal)`，返回 `{ data: Uint8Array, width, height }`。source 是受管文件引用，最长边为整数 1～256，不放大；EXIF 转正，sRGB、去 alpha、三通道 RGB 连续排列，不写缓存。取消与读取失败拒绝 Promise。外部包声明 `coreFeatures: ["image-sample-v1"]`；无需携带原生 sharp。宿主负责解码和限制，颜色聚类等业务算法属于插件。
