# 工作台预设 API

2026-11-06。宿主拥有预设服务和状态保护，插件可以提供预设、绘制预览，或者替换管理界面。三种能力可以独立使用，不要求一个插件同时负责。默认界面随宿主交付，使用相同服务和贡献入口；用户无需安装额外包才能管理布局。

## 声明与入口

在 `plugin.json` 声明 `uiFeatures: ["workbench-presets-v1"]`。类型入口为 `@resource-manager/plugin-api/ui/workbench-presets`，不包含宿主内部的工作区控制器或存储类。已有独立工程更新宿主后，运行 `node <宿主>/scripts/plugins/project.ts configure <插件工程>` 刷新本机 SDK 映射，再使用新类型入口。

```tsx
import { useSyncExternalStore } from 'react'
import type { WorkbenchPresetUiProps } from '@resource-manager/plugin-api/ui/workbench-presets'

function Manager({ host, close }: WorkbenchPresetUiProps) {
  const api = host.workbenchPresets
  const state = useSyncExternalStore(api.subscribe, api.getSnapshot)
  return <div>
    {state.presets.map(p => <button key={p.id} onClick={() => {
      try { api.apply(p.id); close() } catch (error) { host.notify(String(error)) }
    }}>{p.title}</button>)}
  </div>
}
```

`getSnapshot()` 是冻结的只读快照，无变化时保持引用稳定；组件不能修改它来改变工作区。`subscribe(listener)` 返回取消订阅函数。目录写入成功、布局改变、返回点变化或本机存储事件后更新；仅更改搜索、草稿等未纳入编排的状态不会改变公开快照；支持的呈现配置会更新。API 仅作用于发起调用的仓库窗口，不跨仓库执行，也不开放本机存储键。

| 快照字段 | 含义 |
|---|---|
| `presets` | 当前启用贡献、已登记方案的配套布局与用户保存的预设；含 `id/title/description?/layout/source/editable/missingViews/issues?` |
| `source` | `builtin`、`plugin`（附插件 ID 和名称）、`scheme`（方案附带，含方案 ID 和来源名称）、`user`；只有 `user` 可原位更新或删除 |
| `current` | 当前可保存的布局和显式支持的内容描述；工作区未就绪或无法捕获时缺省 |
| `views` | 当前可用面板的稳定 ID 和名称，供预览标注 |
| `canReturn` | 本窗口会话是否有上一切换的返回点 |
| `catalogError/currentError` | 用户目录读取或当前布局捕获失败；展示原因，已有数据不被覆盖 |

## 动作

动作同步返回，失败抛错，由调用界面展示。不要在渲染、读取预览或订阅回调里执行写动作。

| API | 语义 |
|---|---|
| `preview(layout): WorkbenchPresetPreview` | 只读生成内容名称、显示说明、工具目录和可用性问题；不打开页面或改变工作区 |
| `saveCurrent(title): string` | 捕获调用时的当前布局并保存用户预设，返回新 ID |
| `copy(id, title): string` | 从指定预设复制布局，不依赖当前工作区布局，返回独立用户副本 ID |
| `updateFromCurrent(id)` | 以调用时的当前布局更新已有用户预设 |
| `rename(id, title)` / `remove(id)` | 只管理用户预设；删除不改变当前工作区 |
| `apply(id)` | 校验最新预设并切换，保留页面／草稿，建立返回点 |
| `back()` | 恢复布局、仍存在页面的位置和本次改变的呈现；不复活关闭页或覆盖新编辑 |

内置／插件原版的重命名、更新和删除会被服务拒绝。原版更新后沿用稳定 ID，用户副本不再跟随原版。停用／卸载提供者会撤下原版，但保留副本和当前布局；重新启用后恢复贡献。需要修改原版时使用 `copy`，不要自己读写 `localStorage`。

目录损坏时仍列出内置／插件预设并允许应用，但保存、复制等写操作拒绝覆盖坏目录。保存失败不乐观地宣告成功；工作区处于页面结束流程时拒绝切换，可以稍后重试。订阅者异常不会撤销已完成动作或阻断其他订阅者。

## 只读预览与基础界面（2026-11-13）

`preview(layout)` 接受从快照取得的只读布局，返回冻结的 `{ contents, tools, issues }`。`contents` 按中央分区 ID 给出与 `layout.contents[id].items` 同序的 `{ title, detail? }`；`tools` 同时包括普通与上下文工具的 ID／名称。几何、开合、关闭项、顺序和默认激活继续读取布局本身，避免再建立一套布局事实。`issues` 包含入口／放置校验和预览描述失败；这不是对当下工作现场的无条件执行承诺，实际应用仍复核实例等规则。

```tsx
const state = useSyncExternalStore(api.subscribe, api.getSnapshot)
const selected = state.presets.find(p => p.id === selectedId)
const preview = useMemo(() => selected && api.preview(selected.layout), [api, selected])
// 选择条目只展示 preview；用户明确按应用按钮后调用 api.apply(selected.id)。
```

预览方法不写目录、创建标签或挂载页面组件，不需要实际切换布局来生成缩略图。输入格式错误会抛出异常；单项描述或内容失效则在 `issues` 中报告，其余项目仍可预览。名称与说明为运行时元数据，不进入已保存预设。不要把这些缓存为另一个配置源。

页面可在已有 `TabType.workbench` 上选填纯函数 `describe(target, presentation) => ({ title, detail? })`。用于说明如「全部／瀑布流 · 大小 340」，禁止调用有 hooks 的 `Title` 或业务读写。未提供时，宿主使用解析参数中的文本 `title`，否则显示通用功能页名称；呈现仅提示含显示配置。既有页面无需改动，但建议接入此描述。描述失败只影响预览，不会改变页面或保存格式。

宿主基础界面也只消费这套 API：目录搜索、选择预览、显式应用、当前保存、原版／用户预设另存、用户预设重命名／覆盖／删除及返回。覆盖确认展示当前编排，删除不改当前工作台。外部管理界面可复用同样能力，仍能从「使用基础预设界面…」回到宿主入口；渲染失败自动兜底。

## 贡献只读预设

```tsx
export const plugin: UiPlugin = {
  id: 'reader-tools',
  workbenchPresets: [{
    id: 'reader-tools.compare', title: '阅读对照', description: '左右对照，收起两侧栏',
    layout: {
      version: 1, primary: 'reading', panels: { sidebar: false, inspector: false },
      root: {
        type: 'split', id: 'split', direction: 'columns', ratio: 0.6,
        first: { type: 'group', id: 'reading' }, second: { type: 'group', id: 'reference' }
      }
    }
  }]
}
```

贡献 ID 必须以插件 ID 加点开头，在同一扩展点中唯一；不要在更新时随机生成。`root` 的节点 ID 只标识几何区域，不是素材或标签 ID；每棵树内唯一，`primary` 指向一片区域。分割方向为 `columns / rows`，比例介于 0 与 1 之间；最多 64 个区域。

可选 `panelSizes` 记住侧栏期望宽度；可选 `sidebars` 描述容器、工具视图位置、选中容器、折叠与高度权重，结构见公共类型和示例。省略这两项表示应用时沿用当前值。预览可按节点比例绘制示意图，不需要真实切换、挂载内容、调用插件视图组件或产生截图；小窗口的实际排布仍受宿主最小尺寸约束。

跨插件面板通过稳定的工具视图 ID 引用。缺少的视图记录在 `missingViews`，布局保留位置并按可用贡献回退，不自动安装／启用依赖。若业务上要求某插件启用才显示该预设，可使用既有 `needs` 和 manifest 依赖声明；否则允许预设保留缺失位置。旧的纯布局预设保持原语义；新增内容入口使用下文显式契约，不执行任意命令或创建业务数据。

## 内容编排（2026-11-13）

使用 `layout.contents` 或 `TabType.workbench` 时额外声明 `workbench-content-v1`。几何树仍只包含区域；`contents` 以中央叶子 ID 为键，定义可重建入口、顺序和默认激活下标。普通工具使用 `kind: 'tool', id`，按既有区域能力与单实例规则放置，不能携带 `bound:` 固定来源。

```ts
layout: {
  version: 1, primary: 'main', panels: { sidebar: true, inspector: true },
  root: { type: 'split', id: 'split', direction: 'columns', ratio: .6,
    first: { type: 'group', id: 'main' }, second: { type: 'group', id: 'space' } },
  contents: {
    main: { items: [{ kind: 'page', type: 'collection', target: { presetId: 'all' },
      presentation: { layout: 'masonry', options: {}, zoom: 320 } }] },
    space: { items: [{ kind: 'page', type: 'file-spaces', target: {} }], active: 0 }
  }
}
```

页面要显式声明 `TabType.workbench: PageWorkbenchAdapter<P, S>`：

- `capture(params, saved)`：只输出 `{ target, presentation? }`；具体素材、草稿或不可迁移入口返回 `undefined`，仍然保留在现场。不能直接序列化整个 params / saved。
- `resolve(target)`：校验、规范化入口并返回开页参数；入口失效时抛出可理解的错误。描述升级由提供方处理。只允许同步纯转换，不接收 host，不写库、不申请网络或创建笔记。
- 可选 `presentation.capture(params, saved)` / `presentation.apply(params, saved, value)`：读取可还原的呈现配置、校验新配置并合入一份新状态。必须保留搜索、选择、锚点、草稿等其他字段，不修改输入对象。

宿主更改呈现后，更新 `saved` 并递增 `TabProps.presentationRevision`。已挂载页面在这个序号变化时，仅采用 saved 中的呈现字段，不重置整个组件；未挂载或重启后的页面直接使用最新 saved。标准 `ResourceCollection` 已接入，外部封装应继续透传完整 TabProps。序号只表示宿主呈现更改，不是业务版本、撤销记录或持续绑定。

首批内置适配：

| 内容 | 可保存部分 | 不保存部分 |
|---|---|---|
| 集合 | 导航入口 `presetId`，当前布局 ID / options / zoom | 保存视图实体 ID、自定义查询、临时筛选、搜索、选择、滚动和布局私有运行状态 |
| 文件空间 | 无参数的仓库空间工作台 | 指定 spaceId 的页面 |
| 操作历史 | 无参数的会话历史页 | 操作记录和历史选择 |
| 普通工具 | 工具 ID 和所在容器 | 局部草稿及固定来源页 ID |

`target` / `presentation` 必须是 JSON 对象，各限 64 KB；最多 128 个中央入口。活动下标必须指向本槽位项，重复工具位置拒绝。缺失插件或无效单项记录在 `issues` 并在应用时提示，其他项仍可用；预设原文保留，稍后启用插件后重新应用，不自动安装或运行依赖。`missingViews` 保留给原管理组件使用，只涵盖普通侧栏工具；新界面应展示 `issues`。

应用规则：优先匹配目标组内同入口，其次复用其他组未分配实例，未命中才经页面实例规则新建。不会把受数量限制的另一份内容替换掉。空组采用默认激活项；有真实内容的组保留当前显示和操作焦点，新增功能页加入标签。重复应用不堆积同入口。工具移动遵守 `placement.regions`，智能候选仍按上下文能力筛选；按页面类型保存的只是工具偏好。

`back()` 恢复还存活的页面位置、本次改变的呈现与工具安排；新开页面保留、已关闭页面不复活。页面已转到其他内容时跳过其呈现返回，业务编辑和播放进度不回滚。返回点只在当前窗口一次有效；不是工作区历史快照。预设应用打开的新功能页在返回时也保留。

## 替换管理界面

```tsx
workbenchPresetUis: [{
  id: 'reader-tools.preset-manager', priority: 100, Component: Manager
}]
```

组件接收 `{ host, intent: 'manage' | 'save', close }`，由宿主标准弹窗承载；处理保存意图、关闭按钮、错误反馈和溢出滚动。数值小的 `priority` 优先，同值按贡献 ID 排序；默认内置界面为 `1000`。当前没有额外的界面选择设置，组件应声明确定的优先级；可以只声明界面而不附带任何预设。

左下「布局」的保存／管理入口，以及 `host.openWorkbenchPresets(intent?)`，都使用这一贡献。基础快速切换菜单和侧栏配置入口归宿主；「使用基础预设界面…」可以绕过自定义界面。管理组件渲染出错时，宿主原位回退到基础界面，不撤下其预设、不重载仓库；事件处理和异步请求的异常仍由插件捕获。其他页面、侧栏或窗口部件也可以直接调用服务，制作不同的快捷入口。

这不是任意代码的安全沙箱。插件仍须遵守原有公共 API 与可信安装约定；这里的只读和校验用于明确职责和保护正常调用的状态。

## 示例和验证

可打包示例见 [examples/workbench-presets](../../examples/workbench-presets/README.md)。示例同时声明三分屏原版、素材与文件空间内容编排、管理组件和工具入口；管理界面仅从服务读取所有来源的预设并画简单预览。它不进入默认发行包，不增加普通用户的插件管理负担。

验证命令与边界见[开发与验证](../development/开发与验证.md#工作台预设公共接口)，原有切换／返回及保存规则见[工作台布局预设](../architecture/工作台布局预设.md)。

2026-11-13：`scheme` 布局来自应用级组合目录，尚未启用插件也可见，缺失能力通过预览问题提示。独立切换布局不安装或启用插件，完整应用走[插件组合预设](插件组合预设.md)；只读原版可复制到当前仓库的用户布局目录。
