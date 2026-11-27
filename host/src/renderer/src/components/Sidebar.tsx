import { uiText, useUiLocale } from '../../../shared/i18n/interface-display'
import { t, useLanguage, viewTitle } from '../language'
import { ContentDropBoundary } from '../content-drop'
import { useUiDocument } from '../../../plugin-api/ui/widgets'
import { readBrowsingDefault } from '../../../shared/browsing-layout'
import { acceleratorLabel } from '../widgets'
// 导航：只负责打开视图，集合筛选由智能工具承载。
// 视图列表本身就是一个查询：挂有视图块的身份，加上插件提供的预设视图。

import { useEffect, useMemo, useRef, useState, type DragEvent, type HTMLAttributes } from 'react'
import { createPortal } from 'react-dom'
import type { Query } from '../../../shared/query'
import { browsingQuery } from '../../../shared/collection'
import { useEntity } from '../entity-cache'
import type { UiHost } from '../plugin'
import { navs, presetViews } from '../ui-registry'
import type { CollectionParams } from '../workspace'
import { ViewEditor, type ViewDraft } from './ViewEditor'
import { ViewDropHint } from './ViewDropHint'
import { PresetViewIcon } from './icons'
import { SAVED_VIEW_DRAG, moveSavedView, orderedViews, pinView, readViewNavigation, type ViewNavigation } from '../view-navigation'

interface Props {
  host: UiHost
  libraryId: string
  drop?: { id: string; internal: boolean }
  /** 当前标签页的参数，用来高亮正在看的视图。 */
  current?: CollectionParams
  /** 当前活动中央标签页的类型与参数。 */
  activeTab?: { type: string; params: Readonly<Record<string, unknown>> }
  /** newTab：⌘ 点击时在新标签页打开。 */
  onOpen(params: CollectionParams, newTab: boolean, window?: 'main'): void
}

function useLive<T>(host: UiHost, load: () => Promise<T>, initial: T, deps: unknown[]): T {
  const [value, setValue] = useState<T>(initial)
  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const run = () => load().then((v) => alive && setValue(v))
    run()
    const off = host.core.on('listChanged', () => {
      clearTimeout(timer)
      timer = setTimeout(run, 300)
    })
    return () => {
      alive = false
      clearTimeout(timer)
      off()
    }
    // 依赖由调用方给出
  }, deps)
  return value
}

export function Sidebar({ host, libraryId, current, activeTab, onOpen: navigate, drop }: Props) {
  useLanguage()
  const document = useUiDocument(), window = document.defaultView!
  const inMain = document === globalThis.document
  const onOpen = (params: CollectionParams, newTab: boolean) => navigate(params, newTab, inMain ? 'main' : undefined)
  const navHost = useMemo<UiHost>(() => inMain ? { ...host, openTab(type, params, options) {
    if (options?.group || options?.window) host.openTab(type, params, options)
    else host.openTab(type, params, { window: 'main', instance: options?.instance })
  } } : host, [host, inMain])
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<ViewDraft>()
  const [settings, setSettings] = useState(false)
  const navigationKey = `navigation:views:${libraryId}`
  const [navigation, setNavigation] = useState(() => {
    try { return readViewNavigation(JSON.parse(localStorage.getItem(navigationKey) ?? '{}')) }
    catch { return readViewNavigation(null) }
  })
  const navigationRef = useRef(navigation)
  const changeNavigation = (change: (n: ViewNavigation) => ViewNavigation) => {
    const next = change(navigationRef.current)
    navigationRef.current = next; setNavigation(next)
    try { localStorage.setItem(navigationKey, JSON.stringify(next)) } catch { host.notify(uiText("导航顺序仅在本次窗口中生效")) }
  }
  const dragging = useRef<string | null>(null)
  const [reorder, setReorder] = useState<{ id?: string; pinned: boolean; after: boolean }>()
  const storageKey = `navigation:visible:${host.root}`
  const [visibility, setVisibility] = useState<Record<string, boolean>>(() => {
    try {
      const value = JSON.parse(localStorage.getItem(storageKey) ?? '{}')
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
    } catch { return {} }
  })
  const visible = (id: string, initial = true) => typeof visibility[id] === 'boolean' ? visibility[id] : initial
  const toggle = (id: string, checked: boolean) => {
    const next = { ...visibility, [id]: checked }
    setVisibility(next)
    try { localStorage.setItem(storageKey, JSON.stringify(next)) } catch { host.notify(uiText("显示设置仅在本次窗口中生效")) }
  }
  const saved = useLive(host, () => host.core.query({ scope: 'all', has: ['view'], dir: 'asc' }).then((r) => r.ids), [] as string[], [host])
  const ordered = orderedViews(saved, navigation).filter(id => visible(`saved:${id}`))
  const finishDrag = () => { dragging.current = null; setReorder(undefined) }
  useEffect(() => {
    const end = () => { dragging.current = null; setReorder(undefined) }
    window.addEventListener('dragend', end); window.addEventListener('drop', end)
    return () => { window.removeEventListener('dragend', end); window.removeEventListener('drop', end) }
  }, [document])
  const dropProps = (pinned: boolean, id?: string): HTMLAttributes<HTMLDivElement> => ({
    onDragEnter(e) { if (dragging.current && e.dataTransfer.types.includes(SAVED_VIEW_DRAG)) e.stopPropagation() },
    onDragOver(e) {
      if (!dragging.current || !e.dataTransfer.types.includes(SAVED_VIEW_DRAG)) return
      e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'move'
      const rect = e.currentTarget.getBoundingClientRect(), after = !!id && e.clientY > rect.top + rect.height / 2
      setReorder(old => old?.id === id && old?.pinned === pinned && old?.after === after ? old : { id, pinned, after })
    },
    onDragLeave(e) { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setReorder(undefined) },
    onDrop(e) {
      if (!dragging.current || !e.dataTransfer.types.includes(SAVED_VIEW_DRAG)) return
      e.preventDefault(); e.stopPropagation()
      const source = dragging.current, rect = e.currentTarget.getBoundingClientRect()
      changeNavigation(n => moveSavedView(n, saved, source, id, pinned, !!id && e.clientY > rect.top + rect.height / 2))
      finishDrag()
    }
  })
  const menu = async (id: string) => {
    const pinned = navigationRef.current.pinned.includes(id)
    const group = ordered.filter(x => navigationRef.current.pinned.includes(x) === pinned), index = group.indexOf(id)
    const extensions = host.extensions.list<import('../../../plugin-api/ui/extensions').SavedViewAction>('host.saved-view-actions', 1)
    const action = await host.contextMenu([
      { id: 'pin', label: pinned ? t('workbench.unpin') : t('workbench.pin') },
      ...(index > 0 ? [{ id: 'up', label: uiText("上移") }] : []),
      ...(index < group.length - 1 ? [{ id: 'down', label: uiText("下移") }] : []),
      ...extensions.map(ext => ({ id: ext.id, label: ext.value.label })),
      { id: 'edit', label: t('workbench.viewRules') }, { id: 'hide', label: uiText("从导航隐藏") },
      { id: 'delete', label: uiText("删除视图（保留素材，可撤销）") }
    ])
    const contribution = extensions.find(ext => ext.id === action)
    if (contribution) {
      try {
        const [view] = await host.core.get([id])
        if (!view?.blocks.view || view.deletedAt) throw new Error(uiText("视图已删除"))
        await host.extensions.invoke(contribution, item => item.run({ viewId: id, host }))
      } catch (error) { host.notify(String(error)) }
      return
    }
    if (action === 'pin') changeNavigation(n => pinView(n, id, !pinned))
    else if (action === 'up' || action === 'down') changeNavigation(n => moveSavedView(n, saved, id, group[index + (action === 'up' ? -1 : 1)], pinned, action === 'down'))
    else if (action === 'hide') toggle(`saved:${id}`, false)
    else if (action === 'delete') await host.core.run('view', 'deleteView', { id }).then(() => host.notify(uiText("已删除视图，可以撤销（{value1}）", { value1: String(acceleratorLabel('CmdOrCtrl+Z')) })))
    else if (action === 'edit') {
      const view = (await host.core.get([id]))[0], block = view?.blocks.view
      if (!block || view.deletedAt) throw new Error(uiText("视图已删除"))
      setEditing({ id, expectedSeq: block.seq, title: String(block.data.title), query: (block.data.query ?? {}) as Query,
        layout: String(block.data.layout ?? 'masonry'), options: (block.data.options ?? {}) as Record<string, unknown> })
    }
  }
  const section = (pinned: boolean) => {
    const ids = ordered.filter(id => navigation.pinned.includes(id) === pinned)
    if (pinned && !ids.length) return null
    return <div className="saved-view-section" data-view-section={pinned ? 'pinned' : 'saved'} {...dropProps(pinned)} data-reorder={reorder && !reorder.id && reorder.pinned === pinned ? 'end' : undefined}>
      <div className="nav-title">{pinned ? t('workbench.pinned') : t('workbench.saved')}</div>
      {ids.map(id => <SavedView key={id} id={id} host={host} active={current?.viewId === id} onOpen={onOpen} pinned={pinned}
        onMenu={() => void menu(id).catch(e => host.notify(String(e)))}
        onDragStart={e => { e.stopPropagation(); dragging.current = id; e.dataTransfer.clearData(); e.dataTransfer.setData(SAVED_VIEW_DRAG, id); e.dataTransfer.effectAllowed = 'move' }} onDragEnd={finishDrag}
        dropProps={dropProps(pinned, id)} reorder={reorder?.id === id ? (reorder.after ? 'after' : 'before') : undefined} drop={drop?.id === id ? drop : undefined} />)}
      {!ids.length && <div className="nav-hint muted">{uiText("拖到这里取消固定")}</div>}
    </div>
  }

  const removed = useLive(host, () => host.core.query({ scope: 'trash', role: 'management', has: ['view'], dir: 'asc' }).then(r => r.ids), [] as string[], [host])

  return (
    <nav className="sidebar">
      {editing && <ViewEditor initial={editing} host={host} onClose={() => setEditing(undefined)} onSaved={() => { setEditing(undefined); host.notify(uiText("视图规则已更新")) }} />}
      {creating && <ViewEditor initial={{ title: '', query: { scope: 'content' }, ...readBrowsingDefault(localStorage, libraryId) }} host={host} onClose={() => setCreating(false)} onSaved={(viewId, draft) => {
        setCreating(false); onOpen({ title: draft.title, query: draft.query, layout: draft.layout, options: draft.options, viewId }, true)
      }} />}
      <div className="sidebar-scroll">
        <div className="nav-group">
          <div className="nav-title">{t('workbench.views')}<button className="nav-add" title={t('workbench.createView')} aria-label={t('workbench.createView')} onClick={() => setCreating(true)}>＋</button><button className="nav-add" title={t('workbench.viewSettings')} aria-label={t('workbench.viewSettings')} aria-expanded={settings} onClick={() => setSettings(!settings)}>⚙</button></div>
          {settings && <div className="nav-visibility" role="group" aria-label={uiText("显示哪些视图")} onKeyDown={e => { if (e.key === 'Escape') setSettings(false); e.stopPropagation() }}>
            <div className="nav-hint muted">{uiText("显示哪些视图")}</div>
            {presetViews.map(p => <label key={p.id}><input type="checkbox" checked={visible(p.id, p.defaultVisible !== false)} onChange={e => toggle(p.id, e.target.checked)} />{viewTitle(p.id, p.title)}</label>)}
            {saved.map(id => <SavedViewToggle key={id} host={host} id={id} checked={visible(`saved:${id}`)} toggle={checked => toggle(`saved:${id}`, checked)} />)}
            {removed.length > 0 && <div className="nav-hint muted">{uiText("旧版移除的视图")}</div>}
            {removed.map(id => <SavedView key={id} id={id} host={host} active={false} onOpen={onOpen} />)}
            <button className="small" onClick={() => setSettings(false)}>{t('workbench.done')}</button>
          </div>}
          {section(true)}
          {presetViews.filter(p => visible(p.id, p.defaultVisible !== false)).map((p) => (
            <button
              key={p.id}
              className={`nav-item${current?.presetId === p.id ? ' active' : ''}`}
              onClick={(e) => p.tab && p.tab !== 'collection' ? navHost.openTab(p.tab, { presetId: p.id }) : onOpen({ title: p.title, query: p.query, presetId: p.id }, e.metaKey || e.ctrlKey)}
            >
              <PresetViewIcon id={p.id} />
              <span className="nav-label">{viewTitle(p.id, p.title)}</span>
            </button>
          ))}
          {!!ordered.length && section(false)}
        </div>
        {navs.map((n) => (
          <ContentDropBoundary key={n.id} title={uiText("导航分组")} query={n.dropQuery}>
            <n.Component host={navHost} current={current?.presetId ?? current?.viewId} activeTab={activeTab} open={(params, newTab) => onOpen({ ...params }, newTab)} />
          </ContentDropBoundary>
        ))}
      </div>
    </nav>
  )
}

function SavedView({ id, host, active, onOpen, pinned, onMenu, onDragStart, onDragEnd, dropProps, reorder, drop }: {
  id: string; host: UiHost; active: boolean; onOpen: Props['onOpen']; pinned?: boolean; onMenu?: () => void
  onDragStart?: (e: DragEvent) => void; onDragEnd?: () => void; dropProps?: HTMLAttributes<HTMLDivElement>
  reorder?: 'before' | 'after'; drop?: Props['drop']
}) {
  useUiLocale()
  const document = useUiDocument(), window = document.defaultView!
  const view = useEntity(id)
  const row = useRef<HTMLDivElement>(null)
  const data = view?.blocks.view?.data
  if (!data) return null
  const title = String(data.title)
  const rect = drop && row.current?.getBoundingClientRect()
  return (
    <div ref={row} className={`nav-item view-item${active ? ' active' : ''}`} data-saved-view={!view?.deletedAt ? id : undefined} data-reorder={reorder} {...dropProps}
      onContextMenu={onMenu ? e => { e.preventDefault(); e.stopPropagation(); onMenu() } : undefined}>
      {onDragStart && <button className="nav-grip" draggable onDragStart={onDragStart} onDragEnd={onDragEnd} onClick={onMenu} title={uiText("拖动排序，或点击打开视图菜单")} aria-label={uiText("调整「{title}」顺序", { title })}>{pinned ? '★' : '⠿'}</button>}
      <button
        className="nav-label"
        onClick={(e) =>
          onOpen(
            {
              title,
              query: (data.query ?? {}) as Query,
              layout: String(data.layout ?? 'masonry'),
              options: (data.options ?? {}) as Record<string, unknown>,
              viewId: id
            },
            e.metaKey || e.ctrlKey
          )
        }
      >
        {title}
      </button>
      {onMenu ? <button className="nav-view-menu" title={uiText("视图菜单")} aria-label={uiText("「{title}」视图菜单", { title })} onClick={onMenu}>⋯</button> : <button className="nav-x" title={uiText("删除视图（保留素材，可撤销）")} onClick={() => {
        void host.core.run('view', 'deleteView', { id }).then(() => host.notify(uiText("已删除视图，可以撤销（{value1}）", { value1: String(acceleratorLabel('CmdOrCtrl+Z')) }))).catch(e => host.notify(String(e)))
      }}>
        ×
      </button>}
      {rect && drop && createPortal(<div className="sidebar-view-drop-hint" style={{ left: Math.max(8, Math.min(rect.right + 12, window.innerWidth - 364)), top: Math.max(8, Math.min(rect.top, window.innerHeight - 320)) }}>
        <ViewDropHint query={browsingQuery(data.query as Query | undefined)} title={title} internal={drop.internal} />
      </div>, document.body)}
    </div>
  )
}

function SavedViewToggle({ id, host, checked, toggle }: { id: string; host: UiHost; checked: boolean; toggle(value: boolean): void }) {
  const view = useEntity(id)
  return <label><input type="checkbox" checked={checked} onChange={e => toggle(e.target.checked)} />{view ? host.title(view) : t('workbench.saved')}</label>
}
