import { pageContext } from '../page-context'
import { isContainer } from '../../../shared/blocks'
import type { EntityView } from '../../../shared/blocks'
import type { CommandContext } from '../../../plugin-api/ui/commands'
import type { Query } from '../../../shared/query'
import type { CollectionParams } from '../workspace'
import type { CollectionNavigationTarget } from '../collection-navigation'
import { pageInputReason } from '../../../shared/page-inputs'
import type { CreationContext, UiHost } from '../plugin'
import { actionsFor, creators, presetViews, pageInputsFor, tabTypeOf, uiCommands } from '../ui-registry'
import { sidebarCatalog } from '../sidebar-catalog'
import { UiCommands, type RuntimeCommand } from '../ui-command-service'
import type { PageAccess } from './page-access'
import type { Intake } from './intake'

interface Options {
  pages: PageAccess
  host(id?: string): UiHost
  create(id?: string, context?: CreationContext, host?: UiHost): Promise<void>
  createInLibrary(id: string, host: UiHost): Promise<void>
  intake: Pick<Intake, 'captureTarget' | 'receive' | 'receiveLibrary'>
  activate(id: string): void
  openCollection(params: CollectionParams, target: CollectionNavigationTarget): void
  togglePanel(side: 'sidebar' | 'inspector'): void
  busy(): boolean
}
/** 六类既有入口只做适配；实际创建、收录、设置及插件启停仍由原服务处理。 */
export function createWorkbenchCommands(options: Options, source?: () => string | undefined, execution?: { busy: boolean }): UiCommands {
  return new UiCommands(() => {
    const id = source ? source() : options.pages.active()
    const entry = id ? options.pages.entry(id) : undefined
    const host = options.host(id)
    const collectionTarget = { origin: id, group: options.pages.group(id) }
    const navigation = id ? options.pages.api(id)?.navigation : undefined
    const { orderedIds: _orderedIds, ...query } = navigation ?? {}
    const context: CommandContext = structuredClone({ page: entry ? { id: entry.id, type: entry.type, query: navigation ? query : undefined } : undefined, ids: id ? options.pages.focus(id) : [] })
    const identity = entry && (tabTypeOf(entry.type)?.key?.(entry.params) ?? JSON.stringify(entry.params))
    const pageReason = () => {
      if (!context.page) return '当前没有可操作的页面'
      const current = options.pages.entry(context.page.id)
      if (!current || current.type !== context.page.type || (tabTypeOf(current.type)?.key?.(current.params) ?? JSON.stringify(current.params)) !== identity) return '来源页面已关闭或切换内容，请重新打开命令面板'
    }
    const inputReason = (operation: 'receive' | 'create') => pageReason() ?? pageInputReason(pageInputsFor(entry), operation)
    let importTarget: ReturnType<Intake['captureTarget']> | undefined, importError = inputReason('receive')
    if (!importError && id) try { importTarget = options.intake.captureTarget({ type: 'page', id }) } catch (e) { importError = String(e) }
    const creationQuery = entry && tabTypeOf(entry.type)?.dropQuery?.(entry.params, entry.state)
    const creation: CreationContext | undefined = id ? { tabId: id, query: creationQuery && structuredClone(creationQuery) } : undefined
    const selected = async () => {
      const rows = await host.core.get([...context.ids])
      if (rows.length !== context.ids.length || context.ids.some(id => !rows.some(v => v.id === id))) throw new Error('部分选中素材已不存在，请重新选择')
      return context.ids.map(id => rows.find(v => v.id === id)!)
    }
    const forSelection = (commands: RuntimeCommand[], views: EntityView[]) => views.some(v => isContainer(v.blocks, host.kind))
      ? commands.filter(c => c.context !== 'selection' || c.includeContainers) : commands
    return {
      context, host,
      validate: async command => {
        if (options.busy()) throw new Error('工作区正在结束使用，请稍候')
        if (command.context === 'page' || command.context === 'selection') {
          const reason = pageReason(); if (reason) throw new Error(reason)
        }
        if (command.context === 'selection') {
          if (!context.ids.length) throw new Error('没有选中的素材')
          if (!forSelection([command], await selected()).length) throw new Error('此命令只适用于普通素材')
          const reason = pageReason(); if (reason) throw new Error(reason)
        }
      },
      collect: async requested => {
        const commands: RuntimeCommand[] = [
          { id: 'host.library.create-text', title: '新建文字（当前仓库）', category: '常用操作', enabled: () => creators().some(c => c.id === 'text') || '文字功能未启用', run: () => options.createInLibrary('text', host) },
          { id: 'host.library.import', title: '导入文件到当前仓库…', category: '常用操作', run: async () => {
            const paths = await window.bridge.pickImport()
            if (options.busy()) throw new Error('工作区正在结束使用，请稍候')
            if (paths.length) await options.intake.receiveLibrary({ paths })
          } },
          { id: 'host.settings', title: '打开设置', category: '设置', run: async () => { await host.openSettings() } },
          { id: 'host.file-spaces', title: '打开文件空间', category: '导航', run: () => host.openTab('file-spaces', {}) },
          { id: 'host.sidebar', title: '展开／收起左侧栏', category: '工作台', accelerator: 'CmdOrCtrl+\\', run: () => options.togglePanel('sidebar') },
          { id: 'host.inspector', title: '展开／收起右侧栏', category: '工作台', accelerator: 'Shift+CmdOrCtrl+\\', run: () => options.togglePanel('inspector') },
          { id: 'host.import', title: '导入文件…', category: '创建与导入', context: 'page', enabled: () => importError ?? true,
            run: async () => { const paths = await window.bridge.pickImport(); if (paths.length) { const reason = pageReason(); if (reason) throw new Error(reason); await options.intake.receive(id!, { paths }, undefined, importTarget) } } },
          ...creators().map(c => ({ id: `host.create.${c.id}`, title: `新建${c.title}`, category: '创建与导入', context: 'page' as const,
            enabled: () => inputReason('create') ?? (creationQuery?.scope === 'trash' ? '回收站中不能新建素材' : true), run: () => options.create(c.id, creation, host) })),
          ...presetViews.map(v => ({ id: `host.view.${v.id}`, title: v.title, category: '预设视图', run: () => {
            if (v.tab && v.tab !== 'collection') host.openTab(v.tab, { title: v.title, query: v.query, presetId: v.id })
            else options.openCollection({ title: v.title, query: v.query, presetId: v.id }, collectionTarget)
          } })),
          ...options.pages.entries().map(t => ({ id: `host.page.${t.id}`, title: pageContext(options.pages, t.id)?.title ?? String(t.params.title ?? t.params.name ?? '工具页面'), category: '已打开页面', run: () => { if (!options.pages.entry(t.id)) throw new Error('页面已关闭'); options.activate(t.id) } })),
          { id: 'host.context-tools', title: '打开当前页面工具', category: '侧栏面板', run: () => host.showView('host.context') },
          ...sidebarCatalog().views.map(v => ({ id: `host.tool.${v.id}`, title: `打开${v.title}`, category: '侧栏面板', run: () => host.showView(v.id) })),
          ...host.workbenchPresets.getSnapshot().presets.map(p => ({ id: `host.layout.${p.id}`, title: p.title, category: '工作台布局', keywords: p.description ? [p.description] : [], run: () => host.workbenchPresets.apply(p.id) })),
          { id: 'host.plugin-presets', title: '选择插件组合…', category: '插件', keywords: ['启用', '预设'], run: async () => { await host.openSettings({ scope: 'library', section: 'plugin-presets' }) } },
          ...host.settings.pages().map(s => ({ id: `host.setting.${s.scope}.${s.id}`, title: s.title, category: s.pluginTitle ? `插件设置 · ${s.pluginTitle}` : '设置', keywords: [...s.keywords ?? [], ...s.description ? [s.description] : []], run: async () => { await host.openSettings({ scope: s.scope, section: s.id }) } })),
          ...uiCommands()
        ]
        // 定点执行时只读取该命令依赖的数据。
        const needsData = requested?.some(id => id.startsWith('host.saved-view.') || id.startsWith('host.action.'))
        if (requested && !needsData) {
          const matches = commands.filter(c => requested.includes(c.id))
          if (!context.ids.length || !matches.some(c => c.context === 'selection' && !c.includeContainers)) return matches
          return forSelection(matches, await selected())
        }
        const [saved, views] = await Promise.all([host.core.query({ scope: 'all', has: ['view'], dir: 'asc' }).then(r => host.core.get(r.ids)), context.ids.length ? selected() : []])
        for (const v of saved) {
          const data = v.blocks.view?.data
          if (!data || v.deletedAt) continue
          commands.push({ id: `host.saved-view.${v.id}`, title: String(data.title), category: '保存的视图', run: async () => {
            const [fresh] = await host.core.get([v.id]), next = fresh?.blocks.view?.data
            if (!next || fresh.deletedAt) throw new Error('保存的视图已不存在')
            options.openCollection({ title: String(next.title), query: (next.query ?? {}) as Query, layout: String(next.layout ?? 'masonry'), options: (next.options ?? {}) as Record<string, unknown>, viewId: v.id }, collectionTarget)
          } })
        }
        for (const [actionId, action] of actionsFor(views).byId) commands.push({
          id: `host.action.${actionId}`, title: typeof action.title === 'function' ? action.title(views) : action.title,
          category: '选中素材', context: 'selection', includeContainers: action.includeContainers, accelerator: action.accelerator, danger: action.danger,
          run: async () => {
            const fresh = await selected(), current = actionsFor(fresh).byId.get(actionId)
            const reason = pageReason(); if (reason) throw new Error(reason)
            if (!current) throw new Error('此操作已不适用于原选择')
            await current.run(fresh, host)
          }
        })
        return forSelection(commands, views)
      }
    }
  }, execution)
}
