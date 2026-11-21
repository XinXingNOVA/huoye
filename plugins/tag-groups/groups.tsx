import { usePluginState } from '@resource-manager/plugin-api/ui/local-state'
import { useEffect, useState, type DragEvent, type MouseEvent } from 'react'
import type { FacetProps } from '@resource-manager/plugin-api/ui/contracts'
import type { FacetItem, Cond } from '@resource-manager/plugin-api/query'
import type { TagGroup } from './blocks'
import './groups.css'

import { pluginMessages, useLocale } from '@resource-manager/plugin-api/ui/locale'

const msg = pluginMessages('tag-groups')

const dragType = 'application/x-rm-tag-group-item'
const message = (e: unknown) => e instanceof Error ? e.message : String(e)
const kind = 'tag-groups.groups'

export function GroupedTags({ host, facet, items, api, loading, error, reload }: FacetProps) {
  useLocale()
  const [manage, setManage] = useState(false)
  const [groups, setGroups] = useState<TagGroup[]>([])
  const [legacyAvailable, setLegacyAvailable] = useState(false)
  const [known, setKnown] = useState<FacetItem[]>([])
  const [failure, setFailure] = useState(''), [ready, setReady] = useState(false)
  const [revision, refresh] = useState(0)
  const collapse = usePluginState<string[]>(host, 'tag-groups', 'collapsed', [], { legacyKey: `tag-groups:collapsed:${host.root}` })
  const collapsed = Array.isArray(collapse.value) ? collapse.value.filter(v => typeof v === 'string') : []

  const [editor, setEditor] = useState<{ id?: string; title: string }>()
  const [busy, setBusy] = useState(false), [dropTarget, setDropTarget] = useState<string>()
  useEffect(() => {
    let alive = true, generation = 0, timer: ReturnType<typeof setTimeout> | undefined
    setReady(false); setFailure('')
    const load = async () => {
      const ticket = ++generation
      try {
        const own = await host.core.query({ scope: 'all', has: [kind], dir: 'asc' })
        const old = !own.ids.length ? await host.core.query({ scope: 'all', has: ['tagGroups'], dir: 'asc' }) : undefined
        const id = own.ids[0]
        const [rows, all] = await Promise.all([id ? host.core.get([id]) : [], manage ? host.core.facet('tags', 'values') : []])
        if (!alive || ticket !== generation) return
        setGroups((rows[0]?.blocks[kind]?.data.groups as TagGroup[]) ?? [])
        setLegacyAvailable(!!old?.ids.length)
        setKnown(all); setReady(true); setFailure('')
      } catch(e) { if (alive && ticket === generation) { setFailure(message(e)); setReady(false) } }
    }
    const schedule = () => { ++generation; clearTimeout(timer); timer = setTimeout(() => void load(), 100) }
    void load()
    const off = host.core.on('changed', schedule), offList = host.core.on('listChanged', schedule)
    return () => { alive = false; clearTimeout(timer); off(); offList() }
  }, [host, manage, revision])
  const run = async (command: string, input: Record<string, unknown>) => {
    if (busy) return false
    setBusy(true)
    try { await host.core.run('tag-groups', command, input); refresh(v => v + 1); return true }
    catch(e) { host.notify(message(e)); return false }
    finally { setBusy(false); setDropTarget(undefined) }
  }
  const tagConditions = (api.filters ?? []).filter(c => c.kind === 'tags' && c.field === 'values')
  const selected = tagConditions.filter((c): c is Extract<Cond, { op: 'eq' }> => c.op === 'eq')
  const active = (tag: string) => selected.some(c => c.value === tag)
  const pick = (e: MouseEvent, tag: string) => {
    if (!api.toggleFilter || manage) return
    const c: Cond = { op: 'eq', kind: 'tags', field: 'values', value: tag }
    if (e.metaKey || e.ctrlKey || (tagConditions.length === 1 && active(tag))) { api.toggleFilter(c); return }
    for (const old of api.filters ?? []) if (old.kind === 'tags' && old.field === 'values' && !(old.op === 'eq' && old.value === tag)) api.toggleFilter(old)
    if (!active(tag)) api.toggleFilter(c)
  }
  const moveMenu = async (tag: string, current?: string) => {
    const choice = await host.contextMenu([
      ...groups.filter(g => g.id !== current).map(g => ({ id: g.id, label: msg('移到「{name}」', { name: g.title }) })),
      ...(current ? [{ id: '$root', label: msg('移出分组') }] : [])
    ])
    if (choice) await run('moveTag', { tag, group: choice === '$root' ? null : choice })
  }
  const drop = (id: string | null) => ({
    onDragOver(e: DragEvent) { if (manage && e.dataTransfer.types.includes(dragType)) { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'move'; setDropTarget(id ?? '$root') } },
    onDragLeave(e: DragEvent) { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropTarget(undefined) },
    onDrop(e: DragEvent) { if (!manage) return; const tag = e.dataTransfer.getData(dragType); if (!tag) return; e.preventDefault(); e.stopPropagation(); void run('moveTag', { tag, group: id }) }
  })
  const counts = new Map((manage ? known : items).map(i => [i.value, i.count]))
  if (manage) { for (const g of groups) for (const t of g.tags) if (!counts.has(t)) counts.set(t, 0) }
  else for (const c of selected) if (typeof c.value === 'string' && !counts.has(c.value)) counts.set(c.value, 0)
  const assigned = new Set(groups.flatMap(g => g.tags))
  const loose = [...counts.keys()].filter(t => !assigned.has(t))
  const shown = groups.map(g => ({ ...g, tags: g.tags.filter(t => manage || counts.has(t)) })).filter(g => manage || g.tags.length)
  const row = (tag: string, group?: string) => <div key={tag} className={`tag-nav-row${active(tag) ? ' active' : ''}`} data-tag={tag}>
    <button className={`nav-item${active(tag) ? ' active' : ''}`} disabled={busy} draggable={manage} aria-pressed={!manage ? active(tag) : undefined}
      title={manage ? msg('{tag}：拖动或点击选择分组', { tag }) : msg('{tag}；⌘/Ctrl 点击叠加筛选', { tag })}
      onDragStart={e => { e.stopPropagation(); e.dataTransfer.setData(dragType, tag); e.dataTransfer.effectAllowed = 'move' }} onDragEnd={() => setDropTarget(undefined)}
      onClick={e => manage ? void moveMenu(tag, group) : pick(e, tag)} onContextMenu={e => { if (manage) { e.preventDefault(); void moveMenu(tag, group) } }}>
      <span className="nav-label">{tag}</span><span className="nav-count">{counts.get(tag) ?? 0}</span>
    </button>
  </div>
  const toggle = (id: string) => {
    const next = collapsed.includes(id) ? collapsed.filter(x => x !== id) : [...collapsed, id]
    void collapse.set(next).catch(e => host.notify(message(e)))
  }
  return <div className="nav-group tag-groups" data-presentation="pills" onKeyDown={e => { if (['Enter', ' '].includes(e.key) || (e.target as Element).matches('input')) e.stopPropagation() }}>
    <div className="nav-title"><span>{facet.title}</span><div className="tag-group-tools">
      <button className="nav-add" aria-label={msg('整理标签分组')} aria-pressed={manage} title={manage ? msg('完成整理') : msg('整理全库标签分组')} onClick={() => { setManage(!manage); setEditor(undefined) }}>{manage ? msg('完成') : msg('整理')}</button>
      {manage && <button className="nav-add" aria-label={msg('新建标签分组')} disabled={!ready || busy} onClick={() => setEditor({ title: '' })}>＋</button>}
    </div></div>
    {collapse.error && <p className="nav-hint" role="alert">{collapse.error}</p>}
    {ready && legacyAvailable && <div className="nav-hint">
      {msg('旧版分组备份尚在，需手动导入。')}
      <button className="small" disabled={busy} onClick={() => void run('importLegacy', {})}>{msg('导入旧分组')}</button>
    </div>}
    {editor && <form className="tag-inline-editor" onSubmit={e => { e.preventDefault(); if (!busy && editor.title.trim()) void run(editor.id ? 'renameGroup' : 'createGroup', { ...(editor.id ? { group: editor.id } : {}), title: editor.title }).then(ok => { if(ok) setEditor(undefined) }) }}>
      <input className="field-text" autoFocus aria-label={msg('分组名称')} value={editor.title} disabled={busy} onChange={e => setEditor({ ...editor, title: e.target.value })} />
      <button className="small" disabled={busy || !editor.title.trim()}>{msg('保存')}</button><button type="button" className="small" disabled={busy} onClick={() => setEditor(undefined)}>{msg('取消')}</button>
    </form>}
    {(failure || error) && <div role="alert" className="nav-hint">{msg('读取失败')} <button className="link" title={failure || error} onClick={() => { refresh(v => v + 1); reload?.() }}>{msg('重试')}</button></div>}
    {(!ready || loading && !items.length) && !failure && <div className="nav-hint muted">{msg('正在读取标签…')}</div>}
    {ready && <>
      {(loose.length > 0 || manage) && <div className="tag-loose" data-drop={dropTarget === '$root'} {...drop(null)}>
        <div className="tag-pill-flow">{loose.map(t => row(t))}</div>
        {manage && <div className="tag-group-hint muted">{msg('拖到这里移出分组')}</div>}
      </div>}
      {shown.map(g => <section key={g.id} className={`tag-folder${collapsed.includes(g.id) && !manage ? ' collapsed' : ''}`} data-tag-group={g.id} data-drop={dropTarget === g.id} {...drop(g.id)}>
        <div className="tag-group-head"><button className="tag-group-toggle" aria-expanded={manage || !collapsed.includes(g.id)} disabled={!collapse.ready || collapse.busy} onClick={() => toggle(g.id)}>
          <span>{!manage && collapsed.includes(g.id) ? '▸' : '▾'}</span><span className="nav-label">{g.title}</span><span className="nav-count">{g.tags.length}</span>
        </button>{manage && <button className="tag-menu" aria-label={msg('管理分组「{name}」', { name: g.title })} onClick={async () => {
          const action = await host.contextMenu([{ id: 'rename', label: msg('重命名分组') }, { type: 'separator' }, { id: 'delete', label: msg('删除分组（保留标签）') }])
          if (action === 'rename') setEditor({ id: g.id, title: g.title })
          if (action === 'delete') await run('deleteGroup', { group: g.id })
        }}>⋯</button>}</div>
        {(manage || !collapsed.includes(g.id)) && <div className="tag-pill-flow">{g.tags.map(t => row(t, g.id))}{manage && !g.tags.length && <div className="tag-group-hint muted">{msg('拖入标签，或点击标签选择此组')}</div>}</div>}
      </section>)}
      {!shown.length && !loose.length && !manage && !loading && !error && <div className="nav-hint muted">{msg('当前范围没有标签')}</div>}
    </>}
  </div>
}
