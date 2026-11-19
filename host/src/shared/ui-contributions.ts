import { validateUiExtensionDeclarations, type UiExtensionDeclarations } from './ui-extensions'
import { rejectLegacyToolDeclarations, resolveToolDeclarations } from './tool-placement'
import { validateSettingsMetadata } from './settings-contributions'
import { readWorkbenchLayout } from './workbench-layout'
import { layoutConfigurationSchema } from './browsing-layout'
import { pageInputsSchema } from './page-inputs'
import { QUICK_ACTION_ICONS } from '../plugin-api/ui/commands'
import { validateContributions, type PluginInfo } from './plugin-plan'

// 普通函数／类，以及 React memo、forwardRef 等带标记的组件类型。
const componentType = (v: unknown) => typeof v === 'function' || (!!v && typeof v === 'object' && '$$typeof' in v && typeof v.$$typeof === 'symbol')

/** 只依赖结构，便于在不加载 React / DOM 的环境验证装配规则。 */
export function validateUiContributions<T extends UiExtensionDeclarations & { id: string; actions?: { id: string; inspector?: string; icon?: import('../plugin-api/ui/commands').QuickActionIcon }[]; workbenchPresets?: { id: string; title: string; description?: string; layout: unknown }[]; workbenchPresetUis?: { id: string; priority: number; Component?: unknown }[]; layouts?: { id: string; title: string; description?: string; defaultOptions?: Record<string, unknown>; size?: unknown }[]; fileEditingUis?: { id: string; priority: number; open?: unknown }[]; opens?: { id?: string; title?: string; priority: number }[]; badges?: { id?: string; order: number; get?: unknown; Component?: unknown }[]; tabTypes?: { workbench?: import('../plugin-api/ui/workbench-presets').PageWorkbenchAdapter<any, any>; id: string; inputs?: unknown; key?: unknown; instances?: { scope: string; max?: number } }[]; toolViews?: { id: string; title: string; order: number; placement?: import('../plugin-api/ui/contracts').ToolViewContribution['placement']; context?: import('../plugin-api/ui/page-context').ContextToolRule; dropQuery?: unknown }[]; navs?: { id: string; order: number; dropQuery?: unknown }[]; selectionActions?: { id: string; order: number }[]; selectionLayers?: { id: string; order: number }[]; contentLocations?: { id: string; version: number }[]; blockSections?: { id: string; order: number; priority: number }[]; windowProviders?: { id: string; order: number }[]; commands?: import('../plugin-api/ui/commands').CommandContribution[]; settingsSections?: ({ id: string; order: number; scope: string } & import('../plugin-api/ui/settings').SettingsMetadata)[] }>(plugins: T[], manifest: PluginInfo[]): void {
  for (const plugin of plugins) rejectLegacyToolDeclarations(plugin)
  validateContributions(plugins, ['commands', 'workbenchPresets', 'workbenchPresetUis', 'fileEditingUis', 'toolViews', 'selectionActions', 'selectionLayers', 'contentLocations', 'windowProviders', 'settingsSections', 'sections', 'blockSections', 'navs', 'overlays', 'views', 'actions', 'creates', 'tabTypes', 'layouts'], manifest)
  validateUiExtensionDeclarations(plugins, manifest)
  const openerIds = new Set<string>(), badgeIds = new Set<string>()
  const viewIds = new Set<string>(), containerIds = new Set<string>()
  for (const p of plugins) {
    for (const preset of p.workbenchPresets ?? []) {
      if (!preset.id.startsWith(p.id + '.') || preset.id.length > 100 || !preset.title?.trim() || preset.title.length > 80 || (preset.description !== undefined && (typeof preset.description !== 'string' || preset.description.length > 500))) throw new Error(`工作台预设声明无效：${preset.id}`)
      readWorkbenchLayout(preset.layout)
    }
    for (const ui of p.workbenchPresetUis ?? []) if (!ui.id.startsWith(p.id + '.') || ui.id.length > 100 || !Number.isFinite(ui.priority) || !componentType(ui.Component)) throw new Error(`预设界面声明无效：${ui.id}`)
    for (const l of p.layouts ?? []) if (!layoutConfigurationSchema.safeParse(l).success) throw new Error(`布局配置声明无效：${l.id}`)
    for (const ui of p.fileEditingUis ?? []) if (!ui.id.startsWith(p.id + '.') || !Number.isFinite(ui.priority) || typeof ui.open !== 'function') throw new Error(`文件编辑界面声明无效：${ui.id}`)
    for (const t of p.tabTypes ?? []) if (t.workbench && (typeof t.workbench.capture !== 'function' || typeof t.workbench.resolve !== 'function' || (t.workbench.describe !== undefined && typeof t.workbench.describe !== 'function') ||
      (t.workbench.presentation && (typeof t.workbench.presentation.capture !== 'function' || typeof t.workbench.presentation.apply !== 'function')))) throw new Error(`页面编排声明无效：${t.id}`)
    for (const t of p.tabTypes ?? []) if (t.inputs !== undefined && !pageInputsSchema.safeParse(t.inputs).success) throw new Error(`页面输入规则无效：${t.id}`)
    for (const b of p.badges ?? []) {
      if (!Number.isFinite(b.order) || (typeof b.get === 'function') === !!b.Component) throw new Error(`角标必须提供 get 或 Component 之一及有效 order：${p.id}`)
      if (b.Component || b.id !== undefined) {
        if (!b.id?.startsWith(p.id + '.') || b.id.length > 150 || badgeIds.has(b.id)) throw new Error(`角标 ID 无效或重复：${b.id}`)
        badgeIds.add(b.id)
      }
    }
    for (const o of p.opens ?? []) {
      if (!Number.isFinite(o.priority)) throw new Error(`打开方式 priority 无效：${p.id}`)
      if (o.id === undefined && o.title === undefined) continue // 已发布的无名打开器继续自动匹配。
      if (!o.id?.startsWith(p.id + '.') || o.id.length > 150 || !o.title?.trim() || o.title.length > 80 || openerIds.has(o.id)) throw new Error(`打开方式 ID / title 无效或重复：${o.id}`)
      openerIds.add(o.id)
    }
    for (const t of p.tabTypes ?? []) if (t.instances) {
      if (!['content', 'type'].includes(t.instances.scope) || (t.instances.scope === 'content' && typeof t.key !== 'function') || (t.instances.max !== undefined && (!Number.isSafeInteger(t.instances.max) || t.instances.max < 1))) throw new Error(`页面实例规则无效：${t.id}`)
    }
    for (const v of p.toolViews ?? []) {
      if (viewIds.has(v.id)) throw new Error(`工具视图重复：${v.id}`)
      viewIds.add(v.id)
      if (!v.id.startsWith(p.id + '.') || v.id.length > 150 || !v.title?.trim() || v.title.length > 80) throw new Error(`工具视图 ID / title 无效：${v.id}`)
      if (v.dropQuery !== undefined && typeof v.dropQuery !== 'function') throw new Error(`工具视图接收规则无效：${v.id}`)
      if (v.context && (!Array.isArray(v.context.requires) || !v.context.requires.length || v.context.requires.length > 32 || v.context.requires.some(k => typeof k !== 'string' || !/^[a-zA-Z0-9_-]+\.[a-zA-Z0-9_.-]+$/.test(k) || k.length > 150) || new Set(v.context.requires).size !== v.context.requires.length || (v.context.defaultVisible !== undefined && typeof v.context.defaultVisible !== 'boolean'))) throw new Error(`上下文工具能力声明无效：${v.id}`)
      if (v.context?.detachable !== undefined && (!Number.isInteger(v.context.detachable?.maxInstances) || v.context.detachable.maxInstances < 1 || v.context.detachable.maxInstances > 16)) throw new Error(`固定工具实例上限需要 1～16：${v.id}`)
    }
    const defaults = resolveToolDeclarations(p.id, p.toolViews ?? [])
    for (const group of defaults.groups) {
      if (containerIds.has(group.id)) throw new Error(`默认组合与已有容器 ID 冲突：${group.id}`)
      containerIds.add(group.id)
    }
    for (const s of [...p.selectionActions ?? [], ...p.selectionLayers ?? []]) if (s.id.startsWith('host.') || !Number.isFinite(s.order)) throw new Error(`选区贡献 ID / order 无效：${s.id}`)
    for (const s of p.contentLocations ?? []) if (!s.id.startsWith(p.id + '.') || !Number.isSafeInteger(s.version) || s.version < 1) throw new Error(`内容定位 ID / version 无效：${s.id}`)
    for (const s of p.blockSections ?? []) if (!Number.isFinite(s.order) || !Number.isFinite(s.priority)) throw new Error(`插件 ${p.id} 的数据块分区 order / priority 无效：${s.id}`)
    for (const s of [...(p.toolViews ?? []), ...(p.windowProviders ?? [])]) {
      if (s.id.startsWith('host.') || !Number.isFinite(s.order)) throw new Error(`窗口贡献 ID / order 无效：${s.id}`)
    }
    for (const n of p.navs ?? []) {
      if (!Number.isFinite(n.order) || (n.dropQuery !== undefined && typeof n.dropQuery !== 'function')) throw new Error(`导航分组声明无效：${n.id}`)
    }
    for (const a of p.actions ?? []) {
      if (a.inspector !== undefined && !['primary', 'shortcut'].includes(a.inspector)) throw new Error(`检查器操作呈现无效：${a.id}`)
      if (a.icon !== undefined && !QUICK_ACTION_ICONS.includes(a.icon)) throw new Error(`素材操作图标无效：${a.id}`)
    }
    for (const c of p.commands ?? []) {
      validateSettingsMetadata(c)
      if (c.quickAction !== undefined && (!c.quickAction || typeof c.quickAction !== 'object' || Array.isArray(c.quickAction) ||
          (c.quickAction.icon !== undefined && !QUICK_ACTION_ICONS.includes(c.quickAction.icon)) ||
          (c.quickAction.order !== undefined && !Number.isFinite(c.quickAction.order)) || (c.context !== undefined && c.context !== 'window'))) throw new Error(`快捷操作声明无效：${c.id}`)
      if (!c.id.startsWith(p.id + '.') || c.id.length > 150 || !c.title?.trim() || typeof c.run !== 'function' ||
          (c.context !== undefined && !['window', 'page', 'selection'].includes(c.context)) ||
          (c.category !== undefined && (typeof c.category !== 'string' || !c.category.trim() || c.category.length > 100)) ||
          (c.accelerator !== undefined && (typeof c.accelerator !== 'string' || c.accelerator.length > 100)) ||
          (c.danger !== undefined && typeof c.danger !== 'boolean') ||
          (c.when !== undefined && typeof c.when !== 'function') || (c.enabled !== undefined && typeof c.enabled !== 'function')) throw new Error(`UI 命令声明无效：${c.id}`)
    }
    for (const s of p.settingsSections ?? []) {
      validateSettingsMetadata(s)
      if (!['local', 'library'].includes(s.scope) || !Number.isFinite(s.order)) throw new Error(`插件 ${p.id} 的设置分区 scope / order 无效：${s.id}`)
    }
  }
}
