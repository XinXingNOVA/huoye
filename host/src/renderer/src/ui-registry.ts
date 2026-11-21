import { subscribeLanguage } from '../../shared/i18n/display-locale'
import { hostLabel, uiText } from '../../shared/i18n/interface-display'
import { UiExtensionRegistry } from '../../shared/ui-extensions'
import { resolveToolDeclarations } from '../../shared/tool-placement'
import { TOOL_TAB, type TabEntry } from './workspace'
import { collectSettings } from '../../shared/settings-contributions'
import type { ProvidedPreset } from './workbench-preset-service'
import { managementKind, isContainer } from '../../shared/blocks'
// 收集插件界面部分，解析单值扩展点（仲裁）和多值扩展点（排序）。
// 只收这个仓库启用了的插件（设计文档 8.4）：启动时由 initUi 使用核心进程给的实际装配结果。
// 数据块定义有两部分：启用的插件用代码定义的（随界面代码一起）；运行时才知道的（用户的模板、
// 停用的插件留下的休眠定义），从核心进程取，会变。

export { useKinds } from '../../plugin-api/ui/data'
import type { BlockKind, EntityView } from '../../shared/blocks'
import { summaryTitle } from '../../shared/title'
import { blockKinds, uiPlugins } from '../../plugins/ui'
import { PLUGINS, type PluginAssembly } from '../../plugins/manifest'
import { enabledPlugins, selectContributions } from '../../shared/plugin-plan'
import type { PluginInfo } from '../../shared/plugin-plan'
import { validateUiContributions } from '../../shared/ui-contributions'
import { builtinUi } from './builtin'
import { collectOpeners } from './openers'
import type { ActionDef, FacetDef, OverlayDef, OverlaySpaces, UiHost, UiPlugin } from './plugin'

/** 多值的扩展点：插件给的是一个列表。 */
type ListKey = { [K in keyof UiPlugin]-?: NonNullable<UiPlugin[K]> extends readonly unknown[] ? K : never }[keyof UiPlugin]
type Item<K extends ListKey> = NonNullable<UiPlugin[K]>[number]

import { pluginMessages } from '../../plugin-api/ui/locale'

const byPriority = <T extends { priority: number }>(xs: T[]) => [...xs].sort((a, b) => a.priority - b.priority)
const byOrder = <T extends { order: number }>(xs: T[]) => [...xs].sort((a, b) => a.order - b.order)

function titled<T extends { title: string }>(id: string, contribution: T): T {
  const text = pluginMessages(id)
  return { ...contribution, get title() { return text(contribution.title) } }
}

function build(plugins: UiPlugin[], manifest = PLUGINS) {
  validateUiContributions(plugins, manifest)
  const labels = manifest.map(m => ({ ...m, title: m.external ? pluginMessages(m.id)(m.title) : hostLabel(m.title) }))
  const collect = <K extends ListKey>(key: K): Item<K>[] => plugins.flatMap((p) => (p[key] ?? []) as Item<K>[])
  const sections = byOrder(plugins.flatMap(p => (p.sections ?? []).map(s => titled(p.id, s))))
  const layouts = collect('layouts')
  const tools = plugins.map(p => resolveToolDeclarations(p.id, p.toolViews ?? []))
  return {
    workbenchPresetUis: collect('workbenchPresetUis').sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id)),
    workbenchPresets: plugins.flatMap(p => (p.workbenchPresets ?? []).map(v => ({ ...v, source: p.id === 'host' ? { kind: 'builtin' as const } : { kind: 'plugin' as const, id: p.id, title: labels.find(m => m.id === p.id)?.title ?? p.id } }))) as ProvidedPreset[],
    fileEditingUis: byPriority(collect('fileEditingUis')),
    selectionActions: byOrder(collect('selectionActions')),
    selectionLayers: byOrder(collect('selectionLayers')),
    contentLocations: collect('contentLocations'),
    defaultToolGroups: byOrder(tools.flatMap(t => t.groups)),
    toolViews: byOrder(tools.flatMap(t => t.views)),
    windowProviders: byOrder(collect('windowProviders')),
    settingsSections: collectSettings(plugins, labels),
    commands: plugins.flatMap(p => (p.commands ?? []).map(c => ({ ...c, pluginId: p.id, category: c.category ?? labels.find(m => m.id === p.id)?.title ?? p.id }))),
    covers: byPriority(collect('covers')),
    titles: byPriority(collect('titles')),
    previews: byPriority(collect('previews')),
    embeds: byPriority(collect('embeds')),
    opens: collectOpeners(plugins, manifest),
    dragOuts: byPriority(collect('dragOut')),
    icons: byPriority(collect('icons')),
    sections,
    blockSections: byPriority(collect('blockSections')),
    badges: byOrder(collect('badges')),
    staticFacets: plugins.flatMap(p => (p.facets ?? []).map(f => titled(p.id, f))),
    facetMakers: plugins.flatMap((p) => (p.facetsFor ? [p.facetsFor] : [])),
    navs: byOrder(collect('navs')),
    presetViews: byOrder(collect('views')),
    tabTypes: new Map(collect('tabTypes').map((t) => [t.id, t])),
    layoutList: layouts,
    layouts: new Map(layouts.map((l) => [l.id, l])),
    overlays: byOrder(collect('overlays')),
    creates: byOrder(collect('creates')),
    actions: collect('actions').sort((a, b) => a.group - b.group || a.order - b.order),
    /** 分区负责的数据块，不再走通用呈现。 */
    presented: new Set(sections.flatMap((s) => s.kinds))
  }
}

let activePlugins = [builtinUi, ...uiPlugins]
let activeManifest = PLUGINS
let ui = build(activePlugins)
let extensions = new UiExtensionRegistry([], PLUGINS, new Set())
export const uiExtensions = () => extensions
let staticKinds = blockKinds
let kindMap = new Map(staticKinds.map((k) => [k.id, k]))

// 多值扩展点的结果，各处直接用（ES 模块的导出是活的，initUi 之后就是新的）
export let badgeList = ui.badges
export let navs = ui.navs
export let presetViews = ui.presetViews
export let layoutList = ui.layoutList

/**
 * 按这个仓库启用的插件重新收集。宿主自己的部分（集合标签页、瀑布流、"全部""回收站"）总在。
 * 在渲染界面之前调用一次。
 */
export function checkExternalUi(plugins: UiPlugin[], manifest: PluginInfo[]): void {
  validateUiContributions([builtinUi, ...uiPlugins, ...plugins], manifest)
}
export function initUi(assembly: PluginAssembly, external: UiPlugin[] = [], manifest = PLUGINS): void {
  const enabled = enabledPlugins(assembly, manifest)
  const plugins = [builtinUi, ...uiPlugins, ...external]
  activePlugins = selectContributions(plugins, enabled)
  activeManifest = manifest
  refreshPresentation()
  extensions = new UiExtensionRegistry(plugins, manifest, enabled)
  staticKinds = blockKinds.filter((k) => enabled.has(k.plugin))
  kindMap = new Map(staticKinds.map((k) => [k.id, k]))
  kindList = [...staticKinds, ...runtimeMap.values()]
}

function refreshPresentation() {
  ui = build(activePlugins, activeManifest)
  badgeList = ui.badges
  navs = ui.navs
  presetViews = ui.presetViews
  layoutList = ui.layoutList
}
subscribeLanguage(refreshPresentation)


/** 侧栏分面：插件写好的，加上按当前数据块定义生成的。 */
export const facetsFor = (kinds: BlockKind[]): FacetDef[] =>
  byOrder([...ui.staticFacets, ...ui.facetMakers.flatMap((f) => f(kinds))])

let runtimeMap = new Map<string, BlockKind>()
let kindList: BlockKind[] = staticKinds
const kindListeners = new Set<() => void>()

export const kindOf = (id: string): BlockKind | undefined => kindMap.get(id) ?? runtimeMap.get(id)
export const allKinds = (): BlockKind[] => kindList

/** 换上核心进程给的、运行时才知道的数据块定义（用户的模板、停用的插件留下的休眠定义）。 */
export function setDefinedKinds(kinds: BlockKind[]): void {
  runtimeMap = new Map(kinds.map((k) => [k.id, k]))
  kindList = [...staticKinds, ...kinds]
  kindListeners.forEach((fn) => fn())
}

/** 宿主运行时注入订阅，插件通过公共 useKinds 使用。 */
export const subscribeKinds = (listener: () => void): (() => void) => {
  kindListeners.add(listener)
  return () => { kindListeners.delete(listener) }
}

export const tabTypeOf = (id: string) => ui.tabTypes.get(id)
/** 中央工具位置不是素材收录页面；工具内的输入仍交给组件。 */
export const pageInputsFor = (entry: TabEntry | undefined) => entry?.type === TOOL_TAB ? { receive: false, create: false, reason: uiText("请在素材视图中收录或新建内容") } : entry && tabTypeOf(entry.type)?.inputs
/** 空白处菜单列出全部；⌘N 使用 order 最小的那个。 */
export const creators = () => ui.creates
export const creatorFor = (id?: string) => id === undefined ? ui.creates[0] : ui.creates.find((c) => c.id === id)

/** 菜单里的一项：分隔线，或者一个操作。 */
export type MenuItem = { type: 'separator' } | { id: string; label: string; accelerator?: string; danger?: boolean }

/** 对这些身份适用的操作，排成菜单：段之间加分隔线。 */
export function actionsFor(views: EntityView[]): { items: MenuItem[]; byId: Map<string, ActionDef> } {
  const items: MenuItem[] = []
  const byId = new Map<string, ActionDef>()
  if (views.some(v => managementKind(v.blocks, kindOf))) return { items, byId }
  const containers = views.some(v => isContainer(v.blocks, kindOf))
  let group: number | undefined
  for (const a of ui.actions) {
    if (!views.length || (containers && !a.includeContainers) || (a.when && !a.when(views))) continue
    if (group !== undefined && a.group !== group) items.push({ type: 'separator' })
    group = a.group
    items.push({ id: a.id, label: typeof a.title === 'function' ? a.title(views) : a.title, accelerator: a.accelerator, danger: a.danger })
    byId.set(a.id, a)
  }
  return { items, byId }
}
/** 某种坐标系上的叠加层。 */
export const overlaysFor = <S extends keyof OverlaySpaces>(space: S) => ui.overlays.filter((o): o is Extract<OverlayDef, { space: S }> => o.space === space)
export const layoutOf = (id: string) => ui.layouts.get(id) ?? ui.layouts.get('masonry')!

const claimedBy = (s: (typeof ui.sections)[number], kind: string) => {
  const def = kindOf(kind)
  return !!def && !!s.claims?.(def)
}

const claimed = (kind: string) => ui.presented.has(kind) || ui.sections.some((s) => claimedBy(s, kind))

export const coverFor = (v: EntityView) => ui.covers.find((c) => c.match(v))
export const previewFor = (v: EntityView) => !managementKind(v.blocks, kindOf) && ui.previews.find((p) => p.match(v))
export const embedFor = (v: EntityView) => ui.embeds.find((e) => e.match(v))
/** 所有可用打开方式；管理数据仍只走宿主详情。 */
export const openersFor = (v: EntityView) => managementKind(v.blocks, kindOf) ? [] : ui.opens.filter(({ contribution: o }) => o.match(v) && ('open' in o || ui.tabTypes.has(o.tab)))

/** 能给这一批改名的插件：每一项的标题都由它给，而且它能改名。 */
export function renamerFor(views: EntityView[]): ((views: EntityView[], host: UiHost) => void) | undefined {
  if (views.some(v => managementKind(v.blocks, kindOf))) return undefined
  const providers = new Set(views.map(titleProviderFor))
  const [only] = providers
  return views.length && providers.size === 1 ? only?.rename : undefined
}

export const titleProviderFor = (v: EntityView) => ui.titles.find(t => t.get(v))

export function titleFor(v: EntityView): string {
  for (const t of ui.titles) {
    const s = t.get(v)
    if (s) return s
  }
  return summaryTitle(v.blocks, kindOf, v.id)
}

export function dragOutFor(v: EntityView, host: UiHost): { file: string; icon?: string } | undefined {
  for (const d of ui.dragOuts) {
    const file = d.get(v, host)
    if (!file) continue
    for (const i of ui.icons) {
      const icon = i.get(v, host)
      if (icon) return { file, icon }
    }
    return { file }
  }
  return undefined
}

export function sectionsFor(v: EntityView) {
  if (managementKind(v.blocks, kindOf)) return []
  const container = isContainer(v.blocks, kindOf)
  return ui.sections.filter((s) => (!container || s.includeContainers || s.kinds.some(k => kindOf(k)?.container)) && (s.match ? s.match(v, { kind: kindOf, kinds: allKinds, hasContentLocation: v => ui.contentLocations.some(p=>p.match(v)) }) : Object.keys(v.blocks).some((k) => s.kinds.includes(k) || claimedBy(s, k))))
}

/** 没有分区负责的数据块：用通用呈现。包括停用、卸载了的插件留下的数据。 */
export function genericKindsFor(v: EntityView): string[] {
  return Object.keys(v.blocks).filter((k) => kindOf(k)?.display?.inspector !== false && !claimed(k))
}

export const blockSectionFor = (kind: BlockKind) => kind.dormant ? undefined : ui.blockSections.find(s => s.match(kind))

export const settingsSections = () => ui.settingsSections
export const windowProviders = () => ui.windowProviders

export const selectionActions = () => ui.selectionActions
export const selectionLayers = () => ui.selectionLayers
export const contentLocation = (id: string, version: number) => ui.contentLocations.find(p => p.id === id && p.version === version)

export const defaultToolGroups = () => ui.defaultToolGroups
export const toolViews = () => ui.toolViews

/** 编辑管理界面可卸载；缺少贡献时保留任务服务，不暗中创建无法管理的新副本。 */
export const fileEditingUi = () => ui.fileEditingUis[0]

export const workbenchPresetUi = () => ui.workbenchPresetUis[0]
export const workbenchPresetCatalog = () => ui.workbenchPresets

export const uiCommands = () => ui.commands
