# 公共 UI API：插件界面的使用约定

新写表单、菜单或弹窗时，先查[插件 UI Kit 速查](UI-Kit.md)。

按职责查找见[公共 API 总览](公共API总览.md)。`UiHost` 组合工作台、仓库和文件服务；布局、选区、草稿的本机状态与仓库业务数据分别管理，不能按“是否从 UI 调用”判断写入影响。

核对日期：2026-10-21。这是内置与可信外部插件共用的界面接口，配合[插件开发指南](插件开发指南.md)和[公共后端 API](公共后端%20API.md)使用。表格、自定义字段、看板已使用此入口并迁为外部包；其他内置插件的公共组件、媒体叠加层查询和原生菜单调用也已改用此入口。外部包通过 `@resource-manager/plugin-api/ui/…` 使用，由宿主提供 React 和公共上下文实例；当前 API 版本为 1。没有发布独立 npm SDK 或承诺长期兼容，安装子集与资源约定见[本地插件使用与开发](插件开发指南.md)。

浏览布局只需要收录日期时，可声明 `entity-identities-v1` 并调用 `host.core.getIdentities(ids)`。它批量返回 `id`、`createdAt`、`deletedAt`，按 ID 匹配；已回收的身份仍可读取，已清除的身份会略过。同一 ID 只返回一次。

## 插件和套件的界面词典

在源 `plugin.json` 或 `suite.json` 添加可选的 `locales`。打包工具会把词典写入静态清单，安装预览和起始方案选择器都可以在加载插件代码之前读取它。每个包独立查词，缺少对应语言或译文时显示作者原文。用户保存的视图名、标签和笔记保留原样。

```json
{ "locales": { "en": { "标签": "Tags", "移入「{name}」": "Move to “{name}”" } } }
```

插件自绘界面可声明 `uiFeatures: ["ui-locale-v1"]`，使用公共入口订阅语言。将用户内容作为插值传入。中英文模板须包含相同的命名占位符。
展示数据块、字段名或枚举选项时，可同时声明 `ui-schema-labels-v1`，从同一入口调用 `kindTitle(kind)`、`fieldTitle(kind, field)`、`enumTitle(kind, field, value)`。三者读取定义所属插件的词典。用户创建的模板、字段、选项保留原文。查询和写入仍传原始值。


```tsx
import { pluginMessages, useLocale } from '@resource-manager/plugin-api/ui/locale'

const msg = pluginMessages('my-plugin')
function MoveLabel({ name }: { name: string }) {
  useLocale()
  return <span>{msg('移入「{name}」', { name })}</span>
}
```

静态分面、检查器标题和套件方案的标题、说明按原文查词。查询条件上的块名、字段名与预定义枚举分别使用 `block.<kind>`、`field.<kind>.<field>`、`value.<kind>.<field>.<value>`。例如 `value.image-filter.geometry.shape.竖图` 可译为 `Portrait`。筛选与写入继续传原始值。

## 1. 责任与入口

插件声明 UI 贡献，宿主负责装配和提供运行能力。内置插件从 `src/plugin-api/` 按需导入，不引用 `src/renderer/` 的实现；共享的数据块、查询等纯契约继续从 `src/shared/` 导入。

| 模块（相对 `src/plugin-api/`） | 可用能力 | 责任 |
| --- | --- | --- |
| [core.ts](../../src/plugin-api/core.ts) | `CoreClient` 类型 | 异步核心接口及带清理函数的事件订阅；连接实例由宿主提供 |
| [ui/contracts.ts](../../src/plugin-api/ui/contracts.ts) | `UiPlugin`、`UiHost`、`LayoutProps`、`TabProps`、各媒体 overlay props | 纯类型；声明贡献和接收场景上下文 |
| [ui/extensions.tsx](../../src/plugin-api/ui/extensions.tsx) | 自定义贡献类型、`ExtensionBoundary`；通过 `host.extensions` 取目录与调用 | 窗口静态协作、版本／来源与局部错误隔离；见[插件自定义 UI 扩展点](插件自定义UI扩展点.md) |
| [ui/local-state.ts](../../src/plugin-api/ui/local-state.ts) | `PluginUiState`、`usePluginState` | 按插件与 application/library 范围保存小型本机偏好；见[接入规则](插件本机界面状态.md) |
| [ui/data.ts](../../src/plugin-api/ui/data.ts) | `useEntityState`、`useEntity`、`useGone`、`useKinds` | 素材和数据块定义订阅；缓存、合并读取与失效由宿主管理 |
| [ui/entities.ts](../../src/plugin-api/ui/entities.ts) | `EntityState`、`EntitySource` 类型 | 状态契约；不提供缓存实例，也不提供可写容器 |
| [ui/media.tsx](../../src/plugin-api/ui/media.tsx) | `ResourceCover`、`ResourceCard`、`ResourceBadge`、`Embed`、对应 props、标题区高度 | 宿主标准呈现；按当前启用插件选择具体封面与嵌入 |
| [ui/collection.tsx](../../src/plugin-api/ui/collection.tsx) | `ResourceCollection`、`collectionQuery`、集合参数／状态类型 | 标准集合、动态 ID 范围、业务工具条与自定义双击；见[公共集合与页面输入](公共集合与页面输入.md) |
| [ui/fields.tsx](../../src/plugin-api/ui/fields.tsx) | `editable`、`writeField`、`FieldEditor`、`BlockEditor`、编辑位置判断 | 现有值类型的通用编辑；结构操作仍由拥有语义的插件命令负责 |
| [ui/widgets.tsx](../../src/plugin-api/ui/widgets.tsx) | `FieldValue`、`AutoSaveText`、`Overlay`、格式化与输入工具 | 复用现有显示、编辑保存、弹层和样式 |
| [ui/navigation.ts](../../src/plugin-api/ui/navigation.ts)、[ui/hooks.ts](../../src/plugin-api/ui/hooks.ts) | `useNeighbors`、`useKeys` | 列表上下项查询、键盘注册及清理 |
| [ui/search.tsx](../../src/plugin-api/ui/search.tsx) | `SearchContext`、`useSearch`、`useSnippet`、`Marked`、`markTermsIn` 等 | 传递当前搜索范围，复用摘要与高亮 |
| [ui/playback.ts](../../src/plugin-api/ui/playback.ts) | `usePlaybackRecord` | 媒体事件监听与保存回调；记录类型和命令归调用方业务插件 |
| [ui/selection.tsx](../../src/plugin-api/ui/selection.tsx) | `ContentSurface`、`useContentSelection`、选区／定位类型 | 窗口内临时选区、统一操作菜单与内容定位，见[公共选区通道](公共选区通道.md) |
| [content-selection.ts](../../src/plugin-api/content-selection.ts) | `ContentReference`、`ContentLocator`、`findTextQuote` | 可保存的来源描述与纯文字定位，核心和 UI 共用 |
| [ui/layout.ts](../../src/plugin-api/ui/layout.ts) | `computeMasonry`、`MasonryLayout` | 纯坐标计算，不查询数据、不读窗口、不控制虚拟列表 |

`ui/internal/` 是宿主注入实现，插件不可导入。宿主启动仓库窗口时，创建稳定的运行上下文，注入素材订阅源、定义订阅、卡片／封面／嵌入组件和打开外链能力。公共组件本身不加载插件清单或注册表，因此不会形成“公共入口 → 装配 → 插件 → 公共入口”的运行时循环。

公共组件沿用应用的 CSS。需要仓库上下文的 hooks、呈现组件及字段控件应在宿主提供的插件挂载位置使用；不支持单独挂到任意网页。当前接口没有独立主题包或 CSS 隔离。

媒体事件监听由 [ui/playback.ts](../../src/plugin-api/ui/playback.ts) 提供。当前签名为 `usePlaybackRecord(ref, identity, source, recorder, options?)`，`recorder` 提供 `position?`、`save(sample)` 和 `onError()`；外部调用者声明 `media-recording-v1`。hook 只负责实际播放后的定时／暂停／结束报告和可选续播，不拥有数据块，也不依赖独立播放插件。每次绑定形成会话 ID，首次真正播放才开始计时；调用方按素材换元素，并在文件／代理版本变化时传新 source token。只打开、同一位置重复暂停与卸载不重复保存。保存失败通知并允许后续重试。

音频和视频各自注册 `audioPlayback` / `videoPlayback`，通过 `core.run('audio' | 'video', 'recordPlayback', { id, hash, ...sample })` 保存。命令核对身份、媒体类型、原文件指纹和会话新鲜度，累计实际播放会话次数；记录不写入撤销历史。共同的事务算法可使用 `core/playback.playbackCommand(mediaKind, recordKind)`，它不登记任何类型或系统。音乐播放器只调用音频命令，传 `{ restore: false }`，让音乐会话负责队列位置恢复。具体归属、旧数据与查询接续见[播放记录归属](播放记录归属.md)。

## 2. 读取、更新与生命周期

`useEntityState(id)` 明确区分状态：

| 状态 | 含义 | `view` |
| --- | --- | --- |
| `idle` | 没传有效 ID，不发请求 | 无 |
| `loading` | 首次读取还未完成 | 无 |
| `ready` | 读取成功 | 当前快照 |
| `missing` | 核心查询未返回此身份 | 无 |
| `error` | 读取失败 | 刷新失败时保留上次快照，首次失败时无；`error` 为说明文字 |

`useEntity` 适合只需显示内容的地方；它返回 `view`，不区分加载、缺失和首次失败。`useGone` 只有 `missing` 才为真，网络或进程错误不会误判为素材消失。读取到的回收站记录仍是 `ready`，是否被软删除看 `view.deletedAt`。

宿主把短时间内的请求合并为批量 `core.get`，同一 ID 的快照在变化前保持同一引用。`changed` 使订阅项重读、未订阅项失效；旧响应不能覆盖变化后或重新订阅后的新读取。刷新期间保留原快照。失败项在重新订阅或收到变化事件时重试，暂未增加自动循环重试或手动刷新 API。

卸载组件自动解除 hook 的订阅；最后一个订阅离开时取消尚未发出的请求。在途 RPC 不强制中断，迟到结果会按订阅和版本状态丢弃。关闭／重载仓库窗口销毁缓存、定时器及事件监听。插件自行调用 `core.on`、启动计时器或观察 DOM 时，仍须自行清理。

`useKinds()` 返回启用的静态定义、动态模板定义及休眠快照；定义变化自动刷新。返回值按只读快照使用，不要原地修改。非 React 的检查器匹配函数通过 `match(view, definitions)` 的第二个参数读取 `definitions.kind(id)` 或 `definitions.kinds()`，不用接触注册容器。

一次性或集合读取仍用 `host.core.get/query`；本轮没有添加通用查询缓存。数据写入仍走 `host.core.patch` 或业务命令 `host.core.run`，由核心负责校验、事务、通知和撤销。不要把 hook 返回的旧快照当作整份记录覆盖保存。

## 3. 呈现与宿主操作

`ResourceCover` 接收已有 `view`，不会重复读取；无专用封面时显示通用摘要，可传 `fallback` 覆盖（包括 `null`）。`ResourceCard` 接收 ID 并订阅，复用封面、标题、角标与拖动。`Embed` 复用嵌入仲裁及缺失回退。封装不增加 DOM 外壳，注入的组件身份稳定，避免接口迁移导致图片和卡片重新挂载。

选择、排列、虚拟化和滚动位置属于布局。调用 `computeMasonry(aspects, width, target, gap, captionHeight)` 时显式传标题区高度；使用标准卡片时取 `RESOURCE_CARD_CAPTION_HEIGHT`，纯封面布局可传 `0`。

下面是自定义行的使用方式（示例放在 `src/plugins/<id>/ui.tsx` 时的相对路径）：

```tsx
import { useEntityState } from '../../plugin-api/ui/data'
import { ResourceCover } from '../../plugin-api/ui/media'
import type { UiHost } from '../../plugin-api/ui/contracts'

function ResourceRow({ id, host, dragIds }: {
  id: string
  host: UiHost
  dragIds(id: string): string[]
}) {
  const state = useEntityState(id)
  if (!state.view) return <span>{state.status === 'error' ? state.error : '等待内容'}</span>
  return <div draggable onDragStart={e => host.startDrag(e, dragIds(id))}>
    <ResourceCover view={state.view} host={host} fallback={<span>无封面</span>} />
    <button onClick={() => host.open(id)}>{host.title(state.view)}</button>
  </div>
}
```

| 宿主入口 | 约定 |
| --- | --- |
| `host.openData(id)` | 直接打开只读通用详情，适用于素材、组织记录和休眠数据。普通 `host.open` 优先专用打开方式，不可用时也回到通用详情。 |
| `host.takeout(ids, name)` | 打开通用记录取回对话框，显示范围、问题及输出位置，用户确认后复制。区别于 `host.export` 的专用格式导出；不依赖插件导出器，不代表完整仓库备份。 |
| `host.startDrag(event, ids)` | 必须在拖动手势中同步调用。布局传完整选择；宿主读取缓存并选择原文件拖出或内部身份拖动。全部已加载且可导出时交出全部文件；混合选择或有未加载项时保留完整 ID，不临时异步查询、不丢掉选择中的文字。 |
| `host.contextMenu(items)` | 返回所选 ID，取消为 `null`；插件保留菜单打开时的目标快照。业务后果由调用者通过核心命令执行。 |
| `host.overlays(space)` | 返回对应媒体坐标系内已启用且依赖满足的贡献。媒体提供位置、选择与定位入口，叠加层负责自己的功能。 |
| `host.open/preview/openTab/showDialog/openExternal/notify` 等 | 沿用宿主已有能力。插件不用持有窗口控制器、Electron 通道或注册表实例。 |

表格迁入了封面、素材订阅、通用字段控件和拖动；字段插件迁入了响应式定义查询与检查器匹配上下文；看板迁入了标准卡片和纯布局工具。类型 ID、字段 ID、原文件、模板记录和保存的视图均不变，无需数据迁移。

### 集合、输入规则与动态角标（2026-11-05）

`ResourceCollection` 复用标准集合界面，动态范围由调用者提供，页面状态随工作区保存；业务工具条与双击动作可替换。`TabType.inputs` 统一声明拖入／粘贴／导入和新建规则，未声明保持原行为。卡片 `badges` 可提供订阅组件，以窗口共享状态更新本机角标，不必写素材数据块。三项能力分别声明 `collection-surface-v1 / page-inputs-v1 / reactive-badges-v1`，接入与边界见[公共集合与页面输入](公共集合与页面输入.md)。

### 多种打开方式（2026-11-05）

`opens` 可成对声明稳定的 `id/title`；宿主列出所有匹配项，并按本机仓库和扩展名记住用户默认选择。`host.open` 的 `options.opener` 支持指定打开器及 `host.choose / host.auto / host.data / host.system`；声明 `open-with-v1`。旧无名打开器继续可用，但不能保存默认。来源与分屏位置保持独立，系统查看仅交出本库已接纳版本的独立临时副本。完整规则与示例见[打开方式](打开方式.md)。

受控编辑使用 `host.editFile(id)`，声明 `file-working-copy-v1`。它交给当前启用的文件编辑界面，由界面使用宿主服务创建／复用副本并按本库编辑偏好打开或让用户选择编辑器，不更改普通 `host.open` 的阅读行为；保存、冲突与清理由宿主统一处理，见[受控文件编辑](../development/受控文件编辑.md)。插件可进一步声明 `file-working-copy-service-v1`，通过 `host.fileEditing` 查询／订阅任务、选择已登记编辑器、检查预览、完成和明确放弃；编辑管理界面现为独立 `file-editing` 包，通过 `file-working-copy-ui-v1` 的 `fileEditingUis` 接入通用入口；缺少界面时不创建新任务。类型与接入见[公共工作副本](公共工作副本.md)。

### 列表来源与连续浏览（2026-10-20）

自定义视图打开素材时，通过 `host.open(id, from)` 提供来源。`from` 是 `ui/navigation` 的 `NavigationList`，兼容原来的 `Query`：普通列表传当前筛选与排序；业务查询产生的自定义顺序可传 `{ orderedIds: 当前结果按显示顺序排列的ID }`。只有 `ids` 会限制范围，不保证保持该数组的顺序。

标签页也可用 `expose({ navigation: from, ...其他能力 })` 声明当前列表，宿主详情栏／操作菜单的 `host.open(id)` 会使用调用时活动标签页的来源。显式传入的 `from` 优先；没有来源时保持单项打开，不推断成全库。异步读取素材前就捕获来源，之后切换标签页不会改用新页面的列表。

查看器通过 `opens.params(view, from)` 把来源存入标签页参数，再调用 `useNeighbors(host, list, id, kind)`。打开时读取一次列表快照，保留筛选和排序，只保留指定类型（多类型取并集）；切到下一项不重新排序。重新从另一列表打开时刷新来源。`orderedIds` 会去重、过滤不可用或类型不符项，同时与其他查询条件取交集；空数组得到空列表，不能扩大成全库。不要原地修改来源对象。

```tsx
// 自定义分页视图：此例明确只浏览当前页。
const source = { orderedIds: page.items.map(item => item.id) }
host.open(item.id, source)
// 若可用 Query 表达整个视图，传 Query，即可跨页连续浏览。
```

`orderedIds` 只属于 UI 导航协议，不是仓库 `Query`／MCP 搜索字段；不要将它直接传给 `core.query`。公共 `navigationIds` 会剥离此字段再查询。外部包依赖显式顺序或 `TabApi.navigation` 时声明 `"uiFeatures": ["navigation-order-v1"]`，旧宿主会拒绝安装而不是静默丢失导航能力。

Collection 1.2.0 的组内列表传组关系、搜索与排序，允许跨页；“未分组”来自业务查询，使用当前页的顺序快照。图片顶部提供上一张／下一张、位置与缩放控制；PDF、文字、音视频沿用同一个导航 hook。

## 4. 自动检查与验证

`npm run plugins:generate`、`plugins:check`、类型检查、测试和构建都会执行 [UI 边界检查](../../scripts/checks/ui-boundaries.ts)。从所有声明的 UI 入口遍历本地依赖闭包，包括辅助文件、重新导出、类型导入和字面量动态导入：

- 不得引用 `src/renderer/` 的私有组件、缓存、注册表或类型；旧 `renderer/src/plugin.ts` 等兼容转发只供宿主代码使用。
- 只能引用表中公开模块，不能引用 `plugin-api/ui/internal/`。
- 公共 API 不得直接或通过本地辅助模块在运行时反向加载插件／生成清单；纯类型的表格协作契约允许引用。
- 不得直接使用 `window.bridge`、`globalThis.bridge`、`self.bridge`（包含方括号访问与直接解构）；具体操作通过 `UiHost` 或宿主注入。
- 沿用浏览器依赖检查：禁止核心实现、Node、Electron 和原生库混入界面；无法静态确认的动态模块路径报错。错误包含引用链。

这是维护边界检查，不是任意 JavaScript 的安全证明，不做变量别名追踪或不可信插件隔离。第三方包仍由构建检查，尚无独立包导出或权限协商机制。

针对性单测见 [ui-api.test.ts](../../tests/integration/ui-api.test.ts)，覆盖请求合并、稳定快照、错误与缺失、过期响应、卸载和清理、同步拖动与混合选择、布局坐标及违规依赖。实际 Electron 回归使用独立临时库和 `RM_USER_DATA`：

- `CAPTURE_FLOW=uiapi`：新图真实导入、封面、表格多选拖出请求、混合身份、看板移动／撤销、文件回拖复用身份、切换布局后的订阅恢复。
- `CAPTURE_FLOW=tableplugins`：模板编辑、字段变化、撤销、分别停用表格／字段、只读保留及恢复。
- `CAPTURE_FLOW=masonry`：演示库中的图片节点保留、两侧栏动画、快速反向、滚动与虚拟化。
- `CAPTURE_FLOW=taggroups`：检查迁入宿主菜单后的分组创建、移动、改名、撤销、折叠恢复与插件启停。

运行方式见 [README](../development/开发与验证.md#检查)。自动流程验证原生拖出请求和调试协议投递的回拖；实际拖到 Finder 等外部软件、系统菜单外观仍需人工验证。

## 设置分区与本机服务

`UiPlugin.settingsSections` 现在也支持 `title / description / keywords`；宿主收集时保留插件身份。`host.settings / openSettings` 提供导航与退出检查，`host.commands` 提供固定上下文的 UI 命令会话，新增贡献为 `UiPlugin.commands`。设置浮层与命令面板的前端接线、示例及兼容边界见[设置与命令接入](设置与命令接入.md)。

`UiPlugin.settingsSections` 提供设置页分区：稳定 `id`、`order`、`scope: 'local' | 'library'`、`Component`，可选 `needs`。只收集实际启用贡献，组件接收稳定的 `UiHost`；scope 显示设置保存位置，不自动创建存储或表单。

`host.service(pluginId, method, input?)` 返回 `Promise<unknown>`，调用本仓库已启用的服务实例。宿主根据真实窗口确定仓库，插件校验自己的参数；插件 UI 不直接使用 bridge。应用级 MCP 的 UI 另用 `plugin-api/ui/application.ts` 的 `ApplicationUiHost`（服务调用、目录选择），无仓库也能装配，不持有 CoreClient。MCP 的设置、样式及服务在自己的目录，具体生命周期和权限责任见[服务插件 API](服务插件%20API.md)。仓库数据继续通过 `host.core` 调用公共业务入口。

持续调用使用 `host.streamService(plugin, method, input, { signal?, onData })`，返回代表整次调用的 `Promise<void>`；onData 可以异步消费，消费完成后服务才发送下一段。拥有者卸载时取消，常驻会话不要因面板隐藏取消。它不持久化任务或结果，错误、范围及示例见[外部本机服务](外部本机服务.md)。

## 管理记录与导航显隐

`PresetView.defaultVisible?: boolean` 控制左侧导航初始显隐，默认 true；用户选择覆盖初始值，按仓库路径存在本机。`tab?: string` 可指定已注册的专用标签页，省略时仍打开集合；专用页接收 `{ presetId }`。管理数据页使用此能力，默认隐藏。显隐不影响插件装配或仓库数据。

`BlockKind.management` 数据在通用界面只读，不复用素材操作或通用字段编辑器；`editable()` 对它返回 false。管理页只显示本身定义的字段，旧误附加元数据仍在仓库中，明确删除时纳入撤销。定义结构和删除从所属插件 UI 调用命令；`fields.deleteTemplate` 提供影响预演与确认，`tags.deleteGroup` 和 `view.deleteView` 自动处理容器／配置生命周期。操作成功后正常订阅 `changed / kinds`；物理删除后的订阅为 `missing`，打开的保存视图转成未保存实例，不能再向已删除身份保存。

## 窗口常驻部件与侧栏

音乐播放器第一次需要“切换／关闭标签页继续播放”与“当前歌曲歌词不跟随素材选择”。据此新增以下窗口贡献；登记、依赖过滤、排序、重复 ID 检查和外部包错误恢复沿用现有机制。

| 契约 | 归属与生命周期 |
| --- | --- |
| `UiPlugin.windowProviders` | `{ id, order, Component({ host, children }), needs? }`。每仓库窗口挂载一次，包裹标签页、两侧栏、窗口部件及对话框。插件可以提供自己的 React Context；类型和 key 必须稳定，切标签页不能重建会话。重载／退出时插件负责保存、取消订阅与释放媒体。 |
| `UiPlugin.toolViews` | 新工具声明 `tool-placement-v1`，允许区域与初始放置建议分开，宿主补齐默认组；只接收当前声明，旧接口升级见工作区布局文档。普通／智能组、固定来源与按声明跨中央停靠分别接入，完整契约见[工作台 API 索引](工作区布局.md#工作台-api-索引)。容器的选择规则与文字／图标样式分开。 |
| `host.showView(id)` | 按用户当前位置展开视图和容器，不强制搬回默认位置。 |
| `TabType.panels` | **已弃用**。仅在接续旧工作区未保存的一侧时读一次；新建工作区默认资源／详情。切换中央标签页不再改变侧栏选择。 |
| `ui/playback.usePlaybackRecord` | 共用媒体事件监听，保存由 `recorder.save` 回调负责；声明 `media-recording-v1`。音乐依赖 audio 并调用其记录命令，可选 `{ restore: false }`。 |

侧栏容器的顺序、当前内容、开合与高度比例保存在本机工作区 `sidebars`；中央位置另由分割树管理，工具跨区保持同一实例。普通组按用户选择，智能组按中央页面能力选候选，固定工具保留来源页。最左是常用操作快捷栏，不再显示工具位置目录。详情仍跟随选择，歌词可跟随播放服务；停用／缺包保留布局记录。详见[操作和生命周期](工作区布局.md)。

宿主负责两侧边缘调整宽度：拖动、左右方向键微调、双击或 Home 恢复默认。期望宽度在工作区 `panelSizes` 按库保存，窗口缩窄时临时压缩两侧，为中央至少保留约 320px；扩窗后恢复偏好。插件内容使用容器宽度，应支持左栏 176～360px、右栏 240～480px；文字标签、图标及提示的具体排布由外壳决定，不属于插件的固定布局依赖。

歌词面板内部上方独立滚动，下方承载进度、播放、模式和音量，隐藏歌词时控制区一起隐藏。持续播放归窗口 Provider，面板可见性不改变它的生命周期。窗口级捕获媒体的 `play` 事件，暂停同窗口其他 `audio/video`；不会自动恢复被暂停的媒体，也不做跨仓库窗口的全局互斥。

外部包使用以上窗口能力时，在 `plugin.json` 中声明 `"uiFeatures": ["window-surfaces-v1"]`。旧版宿主的严格包校验会拒绝新声明，避免安装后缺少会话或侧栏却静默运行；基础 `apiVersion` 仍为 1，旧状态／看板包继续兼容。此标记包含本轮公共播放记录 hook。没有引入任意窗口停靠、多窗口服务、后台播放进程或跨插件的任意服务定位器。

完整消费例子在 独立音乐插件工程。Provider 的高频时钟与队列状态分开订阅，歌词和进度更新不要求整个歌曲列表每帧刷新。宿主不知道 `music` 的数据定义和播放规则，外部包不能导入宿主私有实现。

## 跨平台快捷键

从 `ui/widgets` 导入 `acceleratorLabel('CmdOrCtrl+Z')`，由公共实现根据运行平台显示 Mac 符号或 `Ctrl+Z`。插件不直接读取原生 bridge，不写死 `⌘` 提示，也不据此自行注册系统快捷键。已有函数签名保持兼容，API 版本仍为 1。文件 URL 和系统绝对路径继续通过 `host.url`／`host.abs` 取得；块内文件引用使用 `/`；它也可能是 `shared/...`，不能拼接仓库目录。`host.abs` 同步解析共享登记，失联可能抛错；仅用于当前读取、拖出或显示，不持久化其结果。

## 批注外部包与纯工具

批注的 region / timeline / text / pdf 叠加层已在 `plugins/annotate` 随包加载。标记、选区与批注提示的样式归插件；媒体容器（timeline-lane、reader-page）和文字反向引用共用的 local-row 列表样式仍由宿主提供。没有新增一套叠加层或 React 状态来源。

`@resource-manager/plugin-api/pdf-text` 的 `normalizePdfText` 统一 PDF 文字层和正文的空白／兼容字符处理；`format` 提供 `formatBytes` / `formatDuration`。它们是纯函数，可随包编译，不依赖另一个插件的源码；带上下文的 UI 模块仍复用宿主运行实例。

## 详情中的操作与摘要

`actions` 是素材右键菜单、命令面板与检查器的同一份业务声明。检查器按 `group / order` 取首个非危险的 `inspector: 'primary'` 操作，及最多三个 `inspector: 'shortcut'` 操作；`icon` 使用 `ui/commands.QuickActionIcon` 标准图标。未标记、超额或危险操作仍在更多菜单中，更多菜单与卡片右键共用完整列表。窄栏可收起快捷按钮，入口仍在菜单；`when` 和原操作的校验继续有效。不以按钮文字匹配、复制业务回调或用 CSS action ID 决定主次。

`sections.actions?: string[]` 引用已注册的操作 ID，宿主在分区头部渲染图标入口；只显示对当前素材适用的操作。例如文件分区声明 `['file.storage']`，完整数据取回仍属于素材操作。

分区组件的 `InspectorSectionProps.summarizedFields?` 提供摘要已呈现的 `{ kind, field }`，组件可据此省略重复显示。`blockSections` 同样接收此属性。不要删除数据或改变完整数据详情；名称由其他块提供时，文件分区仍显示原文件名。

标题提供方可声明 `titles[].TitleEditor`，接收 `{ view, host, onDone }`，拥有输入、校验、保存与错误显示，完成／取消调用 `onDone()`。未声明时继续使用 `rename` 对话框。文件原地编辑与对话框使用同一重命名命令，扩展名保护与撤销保持；切换素材会结束未提交的标题输入，不把它当作共享持久草稿。

检查器的“打开”按已注册打开器的 `tab + TabType.key` 查找同内容页面：当前页为“正在查看”，其他已打开页为“定位到页面”；列表选中不代表打开。回调型 `opens.open` 无法据此推断目标，继续显示“打开”，不执行回调探测状态。这个提示不代替原有页面实例仲裁，也不会把打开自动改成编辑。

## 详情分区排序与折叠

详情面板在素材标题、封面和操作下收集分区；加工失败始终单独显示。宿主统一渲染标题、折叠按钮、拖动柄和操作菜单。标题点击展开／折叠；拖动柄上下拖动，聚焦后可用方向键移动；菜单提供置顶、上移、下移、置底；“布局”菜单提供展开／折叠全部和恢复默认。

- 旧 `UiPlugin.sections` 继续按 `kinds / claims / match` 选择，稳定键为 `section:<贡献 ID>`，默认顺序来自 `order`。聚合区仍为一个整体。
- 新 `UiPlugin.blockSections` 为未被旧分区认领的数据块提供专用正文：`{ id, priority, order, match(kind), Component, needs? }`。仅匹配当前素材实际拥有且未休眠的定义，`priority` 最小者获选，`order` 是默认位置，组件接收 `BlockSectionProps = { view, host, kind }`。
- 每个逐块分区使用 `block:<kind.id>` 作为稳定键，标题来自定义；没有适用提供方时仍以同一键呈现通用字段。休眠／缺定义显示只读提示，不执行专用提供方。

```tsx
import type { BlockSectionProps, UiPlugin } from '@resource-manager/plugin-api/ui/contracts'
import { BlockEditor } from '@resource-manager/plugin-api/ui/fields'

function Detail({ view, host, kind }: BlockSectionProps) {
  return <BlockEditor view={view} host={host} kind={kind} />
}
export const plugin: UiPlugin = {
  id: 'example',
  blockSections: [{ id: 'example.detail', priority: 10, order: 40,
    match: kind => kind.plugin === 'example', Component: Detail }]
}
```

外部包使用此接口必须声明 `uiFeatures: ["block-sections-v1"]`；可与 `window-surfaces-v1` 并用。旧宿主拒绝未知能力，新宿主仍接受不使用此接口的旧包。贡献 ID 全局检查重复，`needs` 沿用装配规则，`priority / order` 必须是有限数。

布局存于本机 localStorage，以仓库路径区分，不改素材记录、数据块顺序、搜索或撤销历史。同库所有素材共享一份偏好；当前缺席的分区位置保留，新分区靠近默认相邻项加入，恢复默认会清除此库全部分区偏好。不按素材单独保存、不跨设备同步，也不提供隐藏分区功能。静态聚合分区与通用块不是同一身份；插件停用后保留原分区设置，但其通用块单独显示；逐块分区及模板能直接沿用通用回退的设置。

折叠只隐藏正文，排序保持组件 key，不卸载编辑器；操作前失焦使现有输入提交。换素材按身份重建正文，避免草稿串到下一项；插件编辑器仍须负责自己的失焦／卸载提交及订阅清理。返回 `null` 的空正文连同标题隐藏，不参与可见分区的相邻移动。字段包 1.1.0 已采用逐块贡献，添加模板为独立旧式分区；旧包仍按整组模板排序，升级必须显式选择版本。

验证：`tests/integration/inspector-layout.test.ts` 覆盖布局合并、损坏配置、缺席分区、仓库隔离和能力声明；`CAPTURE_FLOW=inspectlayout / inspectlayoutresume` 检查真实编辑保存、DOM 节点保持、菜单／键盘／DOM 拖放、窄栏、模板改名及移除撤销、字段插件启停与应用重启。原生菜单选择由截图模式代办，系统鼠标拖动手感仍需人工体验。

## 公共内容选区

`selectionActions / selectionLayers / contentLocations` 让来源阅读器与选区使用方独立声明，宿主统一装配。`host.selection` 持有窗口内的临时快照，`host.revealContent` 路由已保存的来源；`definitions.hasContentLocation` 可在检查器匹配时判断来源能力。外部包要求 `content-selection-v1`，完整接入、有效期和旧摘录兼容见[公共选区通道](公共选区通道.md)。


## 中央标签组（2026-11-01）

`TabProps.active` 为窗口内唯一操作焦点，`visible` 为所属组当前可见页面；分屏时可能多页 visible，但只有一页 active。绘制、滚动与尺寸恢复使用 visible，键盘和选区使用 active。依赖新字段声明 `editor-groups-v1`；宿主支持局部递归分割、边缘拖放、移组、合并、比例及本机存档。

传给标签页的 `host.open / openTab / openData / toggleFilter` 按发起页面定位目标组／筛选上下文；侧栏与窗口级 host 仍面向当前操作页。窗口内 `TabType.key` 去重规则不变。移动保留组件实例，重启使用 `saved / setState`，持续服务使用窗口 provider。完整操作、接续范围和限制见[工作区布局](工作区布局.md#中央标签组与分屏)。


`OpenOptions` 增加可选 `group: 'current' | 'other'`：`host.open(id, from?, options?)`、`host.openTab(type, params, options?)`、`host.openData(id, options?)`。声明 `open-target-v1` 后使用。省略位置仍按原有身份规则定位；显式位置会移动已开的同身份页，other 选择最近使用的其他组，无其他组且空间足够时向右创建。菜单和异步打开捕获来源与目标上下文，回调打开器继承位置。完整边界及示例见[指定打开位置](工作区布局.md#指定打开位置)。

## 页面结束与恢复

`TabType.beforeLeave`（`page-lifecycle-v1`）由宿主在关闭、切换内容、重载及正常退出时调用，并等待完成；静态声明可覆盖已暂时卸载的页面。失败保留页面，`setState` 提供本机恢复快照。具体事件语义、信号与 PDF 示例见[页面生命周期](页面生命周期.md)。未接入页面不自动获得共享草稿或保存失败保护。

页面数量、显式多视图与同内容结束快照见[工作区布局](工作区布局.md#page-instances)。`TabType.instances` 与 `OpenOptions.instance` 需声明 `page-instances-v1`；普通打开与旧插件行为保持。

## 共享文字草稿

`host.editing` 提供窗口内的共享文字会话、保存串行化、冲突与本机恢复；接入方法见[共享编辑会话](共享编辑会话.md)。


## 查询视图（2026-11-04）

宿主集合页提供条件编辑、单字段排序、保存规则与临时调整分离，以及拖入规则说明。规则来自数据定义，插件不需要为自己的字段另写筛选面板。Query 新增同字段 `in`，外部 UI 声明 `query-in-v1`；旧 `eq`、范围、空值与 TabApi 分面入口保持。集合的有效查询继续交给 LayoutProps、dropQuery 和来源导航；布局自己的选项保留在原 Options 入口。行为与接入见[查询与视图](../architecture/查询与视图.md)。

侧栏保存视图直接使用保存的 Query 接纳拖入，和中央页共用 `core.admit`，不带入当前页临时筛选。导航固定／排序是宿主本机偏好，不新增插件声明或数据库字段；插件提供的预设、分面与导航组件保持原有边界，不因出现在侧栏就自动成为写入目标。

## 浏览布局配置与状态

`UiPlugin.layouts` 使用 `LayoutDef`：描述、初始选项、尺寸控制声明与自定义 Options；集合按布局分别保存配置、缩放、锚点及私有 JSON 状态。`LayoutProps` 补充 `visible/state/onState`，打开回调可带视觉顺序。新增能力声明 `browsing-layout-v1`，旧包仍保持原控制。默认范围、缺失回退、代码示例见[浏览布局](浏览布局.md)。


## 工作台预设（2026-11-06）

声明 `workbench-presets-v1`，通过 `host.workbenchPresets` 查询／订阅冻结快照，以及保存当前布局、复制原版、应用与返回。`UiPlugin.workbenchPresets` 提供带稳定 ID 的只读原版，`workbenchPresetUis` 替换管理组件，`host.openWorkbenchPresets()` 打开当前装配的界面；两种贡献可独立使用。默认界面走同一公共服务，宿主保留基础菜单与渲染故障回退。原版与用户副本、缺失面板、预览及完整示例见[工作台预设 API](工作台预设API.md)。


## 按页面范围联动分面

`scoped-facets-v1`（2026-11-08）支持当前集合范围的侧栏分面。UI 插件依赖这一语义时在 `plugin.json` 声明 `uiFeatures: ["scoped-facets-v1"]`；依赖新的 `QueryContext.facet` 选项的核心插件声明同名 `coreFeatures`。无须改数据库或既有数据块。

```ts
// 打标补全、条件编辑仍用全库词汇，不受当前页面的筛选影响。
const all = await host.core.facet('tags', 'values')
// 仅统计指定查询命中的完整身份集合；limit 限制返回的值数量，不是采样素材数。
const scoped = await host.core.facet('tags', 'values', {
  query: { has: ['file'], where: [{ op: 'eq', kind: 'file', field: 'ext', value: 'png' }] },
  limit: 100
})
```

可选第三参数为 `FacetOptions { query?: Query; limit?: number }`，字段必须是有索引的文本、枚举或引用字段。结果仍为 `{ value, count }[]`，按数量降序、值升序，只含正数；每个身份每个值只计一次。`limit` 为正整数，UI 未指定时不截断。省略 `query` 保持原语义：未删除、非管理的素材身份（包括没有 content 块的身份）；显式 `{}` 则遵循默认内容查询，`scope: 'trash'` 可统计回收站，`ids: []` 必须为空。查询排序不影响分面数量，不产生摘要连接或排序工作。

`TabApi.facetQuery?(kind, field): Query | undefined` 是侧栏的范围入口，与用于打开／翻页的 `navigation` 分工不同。宿主集合页及 `ResourceCollection` 自动提供：

- 保留保存视图的基础条件，包括基础条件中的同字段要求。
- 保留当前搜索、其他字段条件、有无数据块条件及动态 `scopeIds` 的交集。
- 仅去掉当前字段的临时 `where` 条件，避免点击一个值后兄弟值消失；不剥离基础条件，不清空搜索。
- 不提供此方法或返回 `undefined` 时沿用全库统计；自定义页面可按自己的临时状态实现此方法，不能用最终 `navigation.where` 猜条件来源。

侧栏使用当前操作页面的范围，跟随数据变化刷新；范围切换立即隔离旧数据，迟到请求不能覆盖新范围。数量表示排除本字段临时条件后的可选范围，不是叠加一个标签后的交集预测。多标签的 AND 选择语义没有改变。

宿主向自定义分面 `FacetProps` 传递范围内的 `items` 和可选 `loading/error/reload`。首次／范围切换时 `items` 为空、`loading` 为真；同范围刷新可以暂留旧值。插件不得把错误画成“没有数据”；可调用 `reload()` 重试。已选但归零的条件仍应可以清除，不能因隐藏空组丢掉清除入口。

标签插件的分组只是全库目录，侧栏取目录与分面结果的交集；完整分组、空组、未使用标签从「管理全部标签分组」访问。范围变化不删除标签、不改组、不写撤销记录。其他分面可以复用同一机制，不需要标签专用的宿主 API。

## 同字段独占筛选（2026-11-15）

UI 能力 `exclusive-filter-v1` 扩展现有 `UiHost.toggleFilter` 与集合 `TabApi.toggleFilter`（包括 `collection.filter` 页面能力），无需颜色专用接口：

```ts
// 列表字段也可以普通点击单选，修饰键点击沿用列表的 AND 累加。
api.toggleFilter?.(condition, { exclusive: !event.metaKey && !event.ctrlKey })
// 从详情组件控制关联的集合页。
host.toggleFilter(condition, { exclusive: true })
```

- `exclusive: true` 一次替换当前页面同 `kind.field` 的所有临时条件；如果原来仅有这个完全相同的条件，则清除它。
- 不修改保存视图的基础规则，不清除搜索或其他字段条件。条件进入通用 Query，照常保存视图。
- 未传选项保持已有语义：列表字段累加，非列表字段替换；相同条件再次点击移除。
- 上下文工具通过绑定的 `TabApi` 操作其原页面；详情通过其 `host` 操作页面上下文。无集合目标时，宿主的独占调用给出提示，不自动新开集合。自定义集合页面若提供 `toggleFilter`，应转发或实现同样的选项语义。
- 插件需声明 `uiFeatures: ["exclusive-filter-v1"]`，避免旧宿主忽略选项而悄悄累加。不要用「先清若干条件，再追加」的多次 toggle 模拟原子替换。

## 内容实例接收拖入（2026-11-15）

`content-drop-v1` 让 `toolViews` 与 `navs` 内部的接收区域进入宿主收录流程。声明该 `uiFeatures` 后，组件只标记 `data-drop-zone`（非空业务键）和可选 `data-drop-title`，贡献提供 `dropQuery`；不要直接导入文件、读取侧栏位置或调用私有 IPC。

```tsx
const folders: ToolViewContribution = {
  id: 'example.folders', title: '文件夹', order: 10,
  placement: { regions: ['left', 'center', 'right'] },
  dropQuery: zone => ({ where: [
    { op: 'eq', kind: 'example.member', field: 'folder', value: zone }
  ] }),
  Component: () => <div data-drop-zone="folder-id" data-drop-title="参考资料">参考资料</div>
}
```

- 普通工具：`dropQuery(zone)`；导航分组：同样的声明，仍通过 `navs` 注册。
- 上下文工具：`dropQuery(zone, context)` 收到**这份实例**的 `PageContext`。智能工具使用当前来源，固定工具始终使用固定来源，来源失效时拒绝接收。不要查全局活动标签来替代它。
- 返回 `undefined` 表示拒绝此区域；`{}` 是默认内容查询，不表示绕过准入检查。工具空白处不会隐式接收到中央页。
- 宿主按最近的内容边界解析，普通侧栏、固定工具、智能容器、中央与独立窗口共用；保存视图仍使用已保存规则，页面仍使用 `TabType.dropQuery(params, saved, zone)` 和 `inputs`。
- 放下时捕获查询快照；下载／读文件期间切换焦点不会改变本批目标。已有素材走 `admit`，外部输入走预检／选择／收录；不匹配默认不收录，用户可显式保留例外。它不是任意业务命令通道：只有现有准入机制支持的块和字段才可自动写入。
- 插件自己消费的拖动（例如文件夹层级重排）应 `preventDefault` 并阻止冒泡；保存视图／工具布局拖动不视为素材输入。

`navigation-context-v1` 同时明确 `NavProps.activeTab?: { type, params }`：用于自定义导航高亮；不是允许导航修改任意页面状态的入口。

## 数据块存在分面（2026-11-15）

字段分面继续使用 `FacetDef.kind/field`（`source` 省略或为 `field`），宿主负责 `core.facet` 查询。模板这类“是否挂有某块”的分面使用显式 `source: 'blocks'`，必须提供稳定 `id` 和 `Component`，不再用空字符串字段作暗号。依赖新能力的 UI 包声明 `block-facets-v1`。

```tsx
facets: [{ id: 'example.templates', title: '模板', order: 20,
  source: 'blocks', Component: TemplateFacet }]

// TemplateFacet 内，kinds 是本分面管理的一组块 ID：
const scope = api.blockFacetQuery?.(kinds)
const counts = await host.core.kindCounts(kinds, scope)
api.setHasFilters?.(kinds, selectedKinds)
```

- `core.kindCounts(kinds, query?)` 一次返回 `{ [kind]: count }`，每个身份每块只计一次，含零值，未知定义为 0。最多 1000 个 kind；结果不传输身份／卡片列表。省略 Query 与普通 facet 的全库语义一致，显式 `{}` 按默认内容查询；支持搜索、动态身份范围、回收站、角色与字段条件，排序不影响数量。
- `TabApi.blockFacetQuery(kinds)` 仅排除这些块的**临时 has**；保留基础视图规则、搜索、其他临时条件及动态身份范围。不传空 kind/field 给字段分面接口。
- `api.has` 只读；`setHasFilters(kinds, selected)` 一次替换本组临时条件，其他分面的条件保留。selected 必须属于 kinds，重复去重，多个 has 为 AND。普通单击替换／再点取消，Cmd/Ctrl 切换多选由插件决定。
- 集合页面与 `ResourceCollection` 自动提供；自定义页面可提供同名能力。`collection.filter` 上的动作仍按来源 ID 解析，来源失效后不写其他页面。没有该能力时插件应明确降级，不能写全局状态冒充当前筛选。
- `FacetProps.active` 表示实际可见，隐藏时暂停统计。自定义块分面自行处理 loading/error/retry，范围变化立即移除旧数字，迟到结果不能覆盖新范围；错误不能画成“0 项”。字段分面继续使用宿主的 items/loading/error/reload。

只需要数量时使用 `kindCounts`，业务分类、并集计数或关系遍历仍由插件业务查询提供；本次不新增树关系专用的宿主接口。

### 检查器的支撑块与休眠数据

`BlockKind.display.inspector: false` 表示该块不参与日常详情的通用信息分区，不影响封面、查询、数据详情或清理。定义快照保留此呈现声明；当前 preview 的 still/thumb 使用它，避免缓存路径与来源序号挤占详情。它不限制插件显式贡献的业务分区，也不是权限限制。

“信息分区 → 布局 ···”可显示／隐藏未启用插件的数据（包括没有定义的只读残留块），默认隐藏；选项随本机当前仓库详情布局保存，不随素材变化，隐藏保留排序、折叠与原数据。通用“数据详情”仍可查看所有数据块。

## 页面按需取图

在包的 `uiFeatures` 声明 `interactive-images-v1`。消费方和本地提供方声明同一份 v2 文件能力契约，设置 `source: "file"`、`interactive: true`、`artifact: "image"` 和空的 `output`。标签页通过 `TabProps.imageReads` 发起请求。原件用素材 ID 和已接纳的文件块序号指定，参数遵循能力契约。

```ts
const handle = await imageReads.image('comic/archive.page@1', {
  id: view.id, fileSeq: view.blocks.file.seq, params: { entry: ordinal }
}, { signal: controller.signal, priority: 'display' })
image.src = handle.url
// 替换画面或离开可见区时执行
handle.release()
```

缩略图栏可在第三个参数中传 `{ maxEdge: 160 }`。范围为 1–1024 像素，宿主保持比例、不放大，返回 WebP，并按缩小后的字节计入会话缓存。省略时直接返回 Provider 的原编码图像。原图和不同尺寸的缩略图分别缓存。

句柄带有真实 MIME、宽和高。临时协议地址限此仓库会话，适合直接用作图像源。独立窗口共读同一版本、能力和参数时，共享计算和缓存，各自释放句柄。预取可以用 `priority: 'prefetch'`，同页进入前台会提升排队优先级。页面卸载、连接关闭或库重载会收回对应句柄。原件换版后按新的文件块序号读取。需要在素材列表保留封面或缩略图时，让加工 System 发布可重建图像。`(await host.core.info()).capabilities` 可查看当前仓库的引擎和就绪状态。页面或工具调用无原件的值能力前，可用 `await props.capabilities.inspect(id)` 查询该插件在当前仓库的调用资格。

### 观察单项加工

按需 System 和调用过 `ctx.progress` 的后台 System 会发送单项终态。先订阅 `host.core.on('job', handler)`，按 `id` 和 `system` 筛选，再发起 `demand`。运行中收到 `phase: 'progress'` 和 0–1 的 `progress`。任务结束后，`done` 表示有可用产物，`empty` 表示成功执行且没有产物，其他终态为 `failed`、`skipped`、`cancelled`。需要失败原因或逐块结果时读 `processingStatus`。命中既有结果会直接复用，订阅后也应读一次当前状态。

## 工作室插件的界面扩展

| 清单中的 uiFeatures | 接入方法与生命周期 |
| --- | --- |
| `transient-drop-v1` | 用 `<ReceiveSurface mode="transient">` 包住搜索或比对区域，在子组件的 `onDrop` 同步取出 `dataTransfer.files` 或库内拖动的身份。此区域自行处理拖放和粘贴。焦点在页面空白处或窗口 body 时，包含瞬态接收面的活动页也会跳过默认粘贴收录；需要响应这类粘贴的插件可在所属窗口监听 paste。焦点明确落在另一个接收面内时，按最近的接收面处理。 |
| `preset-layout-v1` | 集合型 `views[]` 可写 `layout` 和可序列化的 `options`。打开新页时优先使用显式呈现，其次使用视图声明，再取本库默认。已有页面保留用户选择。布局插件缺席时显示回退布局，同时保留原布局 ID。 |
| `region-tools-v1` | 图片 `region` 叠加层可声明 `title`、`interaction: 'tool' 或 'passive'`。当前工具独占输入，可提供 `Toolbar`；希望切走工具后继续展示已有标记时可提供只读的 `Passive`。切换模式卸载原工具，监听器和拖动草稿应在 cleanup 中释放。被动图层一直显示且不参与命中。旧图层自动列入工具选择。 |
| `tool-image-reads-v1` | 普通、智能与固定侧栏工具均可用 `props.imageReads?.image(能力ID, { id, fileSeq, params }, { maxEdge, signal })`。使用后调用 `release()`。工具隐藏、关闭及上下文页或选区变化时宿主兜底释放，旧实例的接口失效。取图沿用已声明的本地图像 Provider。 |
| `interactive-values-v1` | 页面和工具可用 `props.capabilities?.inspect(id)` 查询当前本地引擎，再用 `run(id, params, { signal })` 取得结构化结果。能力必须在消费清单中有对应的无文件值契约。未配置的可选能力可隐藏入口。 |

插件可直接读取拖入的浏览器 `File`。需要按视图规则入库时，继续使用带 `viewId` 的接收面。
