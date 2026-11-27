# 插件 UI Kit 速查

宿主和插件共用 React 组件与样式。使用本页组件时，在 `plugin.json` 现有 `uiFeatures` 数组追加 `"ui-kit-v1"`。打包器会检查声明。安装插件需要支持这项特性的宿主。

```tsx
import { useState } from 'react'
import { Button, IconButton, Input, Popover } from '@resource-manager/plugin-api/ui/kit'

function Rename({ save }: { save: (name: string) => void }) {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null)
  const [name, setName] = useState('')
  return <>
    <IconButton icon="edit" label="改名" onClick={e => setAnchor(e.currentTarget)} />
    {anchor && <Popover anchor={anchor} role="dialog" aria-label="改名" onClose={() => setAnchor(null)}>
      <form onSubmit={e => { e.preventDefault(); if (name.trim()) { save(name.trim()); setAnchor(null) } }}>
        <Input aria-label="新名称" value={name} onChange={e => setName(e.target.value)} />
        <Button type="submit" variant="primary" disabled={!name.trim()}>保存</Button>
      </form>
    </Popover>}
  </>
}
```

## 选择组件

组件 | 常用属性与行为
--- | ---
`Button` | 原生 button 属性，默认 `type="button"`。可选 `variant="default｜primary｜ghost｜danger"`、`size="sm｜md"`、`loading`。提交表单显式传 `type="submit"`。
`IconButton` | 同 Button，必填 `icon` 和可读的 `label`。
`Input`、`TextArea` | 原生属性和 ref，另有 `onEnter(event)`。中文候选确认期间抑制回车提交。多行回车默认换行。
`Select` | 单选，沿用 `value / onChange(event)`、`<option>`、`<optgroup>` 与键盘导航。用 label 关联或传 `aria-label`。
`Checkbox`、`Switch` | 传 `checked / onChange`，从 `e.currentTarget.checked` 取布尔值。用 label 关联可读名称。
`SegmentedControl`、`Tabs` | `label, value, options: {value,label,disabled?}[], onChange(value)`；方向键、Home、End 可切换。Tabs 的 children 是当前页内容。
`Badge`、`Tag` | 只读计数、状态与标签，`tone="neutral｜accent｜success｜warning｜danger"`。
`Popover` | `anchor: HTMLElement ｜ DOMRectReadOnly, align?: 'start' ｜ 'end', onClose, children`。优先传元素，随滚动定位；菜单坐标快照随外部滚动关闭。支持 `role` 与 `aria-label`。
`DropdownMenu` | `anchor: HTMLElement, label, groups: {label?,items}[], onSelect(id), onClose`；菜单项 `{id,label,disabled?,danger?,checked?}`。组间自带分隔。
`Dialog` | `title, description?, children?, footer?, busy?, onClose`。挂在当前显示窗口，浏览器管理模态焦点，Esc 交给 onClose。
`ConfirmDialog` | Dialog 加 `confirmLabel, onConfirm, danger?`。调用方管理开关、异步 busy 和失败反馈。
`Tooltip` | `text` 加一个可聚焦的子控件，鼠标悬停或键盘聚焦时显示。图标按钮仍需 label。
`SectionHeader`、`StatBar` | 标题用 `title, subtitle?, badge?, actions?`；统计条用 `label, meta?, actions?`。
`Toolbar`、`ToolbarSeparator` | `label, start?, children?, end?`；children 居中，分隔符可放在各槽中。
`ListRow`、`TreeRow` | `title, icon?, count?, selected?, onClick?, actions?`。树行另有 `depth?, expanded?, onToggle?`，展开与选择可独立操作。
`EmptyState` | `title, description?, icon?, action?`。
`Icon` | `name, size?`，默认 16px，继承文字颜色。可选名称如下。

```text
grid text import command tool search book tag music chat clock layout folder plus split history
close check minus down up left right more edit trash filter table list play pause link
```

## 主题和边界

安装外部主题后，以下变量也会随工作台和独立小窗更新。外部主题也可装饰标准素材卡片、检查器分区和文字、PDF、EPUB 阅读页。宿主公共 `ResourceCard` 自带这些卡片部位，使用它的布局继续负责外框定位。外观包契约与可安装示例见[外部主题包](../../examples/themes/README.md)。

- 表面与线条使用 `--bg --panel --panel-2 --elevated --line`（`--surface` 是 `--panel` 的别名），文字与状态使用 `--text --muted --accent --danger --success --warning`，纸张使用 `--paper --ink`。
- 圆角使用 `--radius`，间距使用 `--hy-space-1 … --hy-space-4`（4 / 8 / 12 / 16px），浮层阴影使用 `--hy-shadow`。
- 强调色按钮上的文字使用 `--hy-on-accent`，选中底色使用 `--hy-selected-bg`，键盘焦点描边使用 `--hy-focus-ring`。标准控件的最小高度取 `--hy-control-height`（舒展 28px、紧凑 24px）。
- 虚拟表格取 `--hy-table-row-height`（舒展 40px、紧凑 32px）。通过所在文档的元素实测行高，并用同一数值计算滚动范围、行位置和首行锚点。旧宿主可回退到 40px。
- 正文可使用 `--hy-reading-font`，纸色与墨色分别取 `--paper` 和 `--ink`。这些变量随工作台同步至独立内容小窗。
- 单选优先用 Select。自定义控件用主题变量，素材本身的颜色仍由数据提供。
- 浮层交给 Popover、DropdownMenu 或 Dialog。需要测量时取元素的 `ownerDocument.defaultView`；内容移窗后，全局 `window` 可能仍指向主窗口。
- 自定义样式用插件自己的类名。Kit 根类使用 `.hy-*`，例如 `.hy-button`、`.hy-select`、`.hy-popover`。内部 DOM、宿主的设置页与表格类名属于实现细节。
- 业务组件 `FieldValue`、`AutoSaveText` 和底层 `UiPortal/useUiDocument` 继续从 `ui/widgets` 导入。

在宿主目录运行 `npm run build` 后，`node tests/electron/content-window-check.mjs uikit` 会用临时仓库验证自定义字段和看板，并保存深浅主题截图。

同一命令使用 `theme` 参数可建一个含十万条文字素材的临时库，在工作台和独立小窗验证主题切换、虚拟表格锚点与鼠标命中。使用 `theme-parts` 参数可验证 v2 主题对卡片、搜索摘录、详情分区和独立阅读小窗的影响，以及主题更新和还原。`theme-libraries` 会启动两次 Electron，验证两个仓库独立设置、各自小窗的继承、恢复应用默认以及关闭仓库后的主题包移除。 `theme-decoration` 使用青瓷薄雾测试夹具验证壁纸、贴纸和表面模糊，覆盖素材回收与恢复、小窗拖选、键盘调整及另一库的外观隔离。

用 `theme-composition` 参数可验收 v5 主题卡片预览、壁纸平铺、贴纸构图、本库覆盖及还原。用 `theme-cycle` 参数可验证昼夜主题在系统切换、按库固定、独立小窗、重启和卸载时的表现。包格式见[主题作者示例](../../examples/themes/README.md)。

公共 `Icon` 会采用当前窗口主题里的同名 SVG。使用 `node tests/electron/content-window-check.mjs theme-readers` 可在两个真实文档中验证图标回退与阅读排版。
