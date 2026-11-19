import { usePluginState } from '@resource-manager/plugin-api/ui/local-state'
import { useEffect, useState, type DragEvent, type MouseEvent } from 'react'
import type { FacetProps, UiPlugin } from '@resource-manager/plugin-api/ui/contracts'
import type { Cond, Query } from '@resource-manager/plugin-api/query'
import { branchCondition, descendants, type TagNode } from './model'
import { nodeKind } from './blocks'
import './tree.css'
const mime = 'application/x-rm-tag-tree-item'
const message = (e: unknown) => e instanceof Error ? e.message : String(e)
function TreeTags({ host, facet, api }: FacetProps) {
  const queryKey = JSON.stringify(api.facetQuery?.('tags', 'values') ?? { scope: 'all', role: 'material' })
  const [manage, setManage] = useState(false), [revision, refresh] = useState(0)
  const [state, setState] = useState<{ key: string; nodes: TagNode[]; counts: Record<string, number>; parents: string[] }>()
  const [failure, setFailure] = useState(''), [busy, setBusy] = useState(false)
  const [editor, setEditor] = useState<{ tag: string; parent: string }>()
  const [dropTarget, setDropTarget] = useState<string>()
  const collapse = usePluginState<string[]>(host, 'tag-tree', 'collapsed', [], { legacyKey: `tag-tree:collapsed:${host.root}` })
  const collapsed = Array.isArray(collapse.value) ? collapse.value.filter(v => typeof v === 'string') : []

  const stateKey = JSON.stringify([queryKey, manage])
  useEffect(() => {
    let alive = true, generation = 0, timer: ReturnType<typeof setTimeout> | undefined
    const load = async () => {
      const ticket = ++generation
      try {
        const scope: Query = manage ? { scope: 'all', role: 'material' } : JSON.parse(queryKey)
        const [ids, facets] = await Promise.all([host.core.query({ scope: 'all', has: [nodeKind], dir: 'asc' }), host.core.facet('tags', 'values', { query: scope })])
        const rows = await host.core.get(ids.ids)
        const nodes = rows.map(v => ({ id: v.id, ...v.blocks[nodeKind].data } as TagNode))
        const counts = Object.fromEntries(facets.map(f => [f.value, f.count]))
        const parents = [...new Set(nodes.flatMap(n => n.parent ? [n.parent] : []))]
        // 只为实际分支查询并集；叶子复用普通 facet。限制并发，旧请求不覆盖新的来源页。
        let at = 0
        await Promise.all(Array.from({ length: Math.min(4, parents.length) }, async () => {
          while (at < parents.length && alive && ticket === generation) {
            const tag = parents[at++]
            if (![...descendants(nodes, tag)].some(t => (counts[t] ?? 0) > 0)) { counts[tag] = 0; continue }
            const found = await host.core.executeQuery({ query: 'tag-tree.branch', args: { tag, scope } })
            counts[tag] = Number(found.result.count)
          }
        }))
        if (alive && ticket === generation) { setState({ key: stateKey, nodes, counts, parents }); setFailure('') }
      } catch(e) { if (alive && ticket === generation) setFailure(message(e)) }
    }
    setFailure(''); void load()
    const schedule = () => { ++generation; clearTimeout(timer); timer = setTimeout(() => void load(), 150) }
    const off = host.core.on('changed', schedule), offList = host.core.on('listChanged', schedule)
    return () => { alive = false; clearTimeout(timer); off(); offList() }
  }, [host, stateKey, queryKey, manage, revision])
  const current = state?.key === stateKey ? state : undefined
  const nodes = current?.nodes ?? [], counts = current?.counts ?? {}
  const selected = (api.filters ?? []).filter(c => c.kind === 'tags' && c.field === 'values')
  const selectedKeys = selected.flatMap(c => (c.op === 'eq' || c.op === 'subtree') && typeof c.value === 'string' ? [c.value] : [])
  const active = (tag: string) => selected.some(c => c.op === 'eq' && c.value === tag || c.op === 'subtree' && c.value === tag && c.tree.kind === nodeKind)
  const run = async (command: string, args: Record<string, unknown>) => {
    if (busy) return false
    setBusy(true)
    try { await host.core.run('tag-tree', command, args); refresh(v => v + 1); return true }
    catch(e) { host.notify(message(e)); return false }
    finally { setBusy(false); setDropTarget(undefined) }
  }
  const pick = (event: MouseEvent, tag: string, exact = false) => {
    const c: Cond = exact ? { op: 'eq', kind: 'tags', field: 'values', value: tag } : branchCondition(tag)
    const sameCondition = (x: Cond) => x.op === c.op && (x.op === 'eq' || x.op === 'subtree') && x.value === tag && (x.op !== 'subtree' || x.tree.kind === nodeKind)
    const same = selected.some(sameCondition)
    if (event.metaKey || event.ctrlKey || same && selected.length === 1) { api.toggleFilter?.(selected.find(sameCondition) ?? c); return }
    for (const old of selected) if (!sameCondition(old)) api.toggleFilter?.(old)
    if (!same) api.toggleFilter?.(c)
  }
  const moveMenu = async (tag: string) => {
    const exclude = descendants(nodes, tag)
    const names = [...new Set([...nodes.map(n => n.tag), ...Object.keys(counts)])].filter(x => !exclude.has(x)).sort()
    const choice = await host.contextMenu([{ id: '$root', label: '移到根层' }, ...names.map((name, i) => ({ id: String(i), label: `移到「${name}」下` })), ...(nodes.some(n => n.tag === tag) ? [{ type: 'separator' as const }, { id: '$remove', label: '移除层级节点（保留素材标签）' }] : [])])
    if (choice === '$root') await run('setParent', { tag, parent: null })
    else if (choice === '$remove') await run('remove', { tag })
    else if (choice !== null && names[Number(choice)]) await run('setParent', { tag, parent: names[Number(choice)] })
  }
  const drop = (parent: string | null) => ({
    onDragOver(e: DragEvent) { if (manage && e.dataTransfer.types.includes(mime)) { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'move'; setDropTarget(parent ?? '$root') } },
    onDragLeave(e: DragEvent) { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropTarget(undefined) },
    onDrop(e: DragEvent) { if (!manage) return; const tag = e.dataTransfer.getData(mime); if (!tag) return; e.preventDefault(); e.stopPropagation(); void run('setParent', { tag, parent }) }
  })
  const all = new Map(nodes.map(n => [n.tag, n]))
  for (const tag of [...Object.keys(counts), ...selectedKeys]) if (!all.has(tag)) all.set(tag, { id: tag, tag })
  const children = new Map<string, string[]>()
  for (const n of all.values()) { const parent = n.parent && all.has(n.parent) ? n.parent : ''; children.set(parent, [...children.get(parent) ?? [], n.tag]) }
  const mustShow = new Set(selectedKeys)
  for (const tag of selectedKeys) { let parent = all.get(tag)?.parent; const seen = new Set<string>(); while(parent && !seen.has(parent)) { seen.add(parent); mustShow.add(parent); parent = all.get(parent)?.parent } }
  const visible = (tag: string) => manage || (counts[tag] ?? 0) > 0 || mustShow.has(tag)
  const pill = (tag: string) => <button className={`tree-pill${active(tag) ? ' active' : ''}`} aria-pressed={!manage ? active(tag) : undefined} disabled={busy}
    draggable={manage} data-tag={tag} data-drop={dropTarget === tag} {...drop(tag)}
    title={manage ? `${tag}：拖动或点击调整层级` : `${tag}及下级；⌘/Ctrl 点击叠加，Alt 点击仅此标签`}
    onDragStart={e => { e.stopPropagation(); e.dataTransfer.setData(mime, tag); e.dataTransfer.effectAllowed = 'move' }} onDragEnd={() => setDropTarget(undefined)}
    onClick={e => manage ? void moveMenu(tag) : pick(e, tag, e.altKey)}>
    <span>{tag}</span><small>{counts[tag] ?? 0}</small>
  </button>
  const toggle = (tag: string) => { const next = collapsed.includes(tag) ? collapsed.filter(t => t !== tag) : [...collapsed, tag]; void collapse.set(next).catch(e => host.notify(message(e))) }
  const branch = (parent: string, seen = new Set<string>()): React.ReactNode => {
    const entries = (children.get(parent) ?? []).filter(t => !seen.has(t) && visible(t))
    const leaves = entries.filter(t => !children.has(t)), parents = entries.filter(t => children.has(t))
    return <>{!!leaves.length && <div className="tree-pill-flow">{leaves.map(t => <span key={t}>{pill(t)}</span>)}</div>}{parents.map(tag => <section className="tree-branch" key={tag}>
      <div className="tree-branch-head"><button className="tree-toggle" aria-label={`折叠或展开${tag}`} aria-expanded={manage || !collapsed.includes(tag)} disabled={!collapse.ready || collapse.busy} onClick={() => toggle(tag)}>{!manage && collapsed.includes(tag) ? '▸' : '▾'}</button>{pill(tag)}</div>
      {(manage || !collapsed.includes(tag)) && <div className="tree-children">{branch(tag, new Set([...seen, tag]))}</div>}
    </section>)}</>
  }
  return <div className="nav-group tag-tree" onKeyDown={e => { if (['Enter',' '].includes(e.key) || (e.target as Element).matches('input')) e.stopPropagation() }}>
    <div className="nav-title"><span>{facet.title}</span><div className="tree-tools"><button className="nav-add" aria-label="整理层级标签" aria-pressed={manage} onClick={() => { setManage(!manage); setEditor(undefined) }}>{manage ? '完成' : '整理'}</button>{manage && <button className="nav-add" aria-label="新建层级标签" disabled={busy} onClick={() => setEditor({ tag: '', parent: '' })}>＋</button>}</div></div>
    {collapse.error && <p className="nav-hint" role="alert">{collapse.error}</p>}
    {editor && <form className="tree-editor" onSubmit={e => { e.preventDefault(); if (editor.tag.trim()) void run('setParent', { tag: editor.tag, parent: editor.parent.trim() || null }).then(ok => { if(ok) setEditor(undefined) }) }}>
      <input autoFocus className="field-text" aria-label="标签名称" placeholder="标签名称" value={editor.tag} disabled={busy} onChange={e => setEditor({ ...editor, tag: e.target.value })}/>
      <input className="field-text" aria-label="母标签名称" placeholder="母标签（留空为根层）" value={editor.parent} disabled={busy} onChange={e => setEditor({ ...editor, parent: e.target.value })}/>
      <button className="small" disabled={busy || !editor.tag.trim()}>创建</button><button type="button" className="small" onClick={() => setEditor(undefined)}>取消</button>
    </form>}
    {failure && <div role="alert" className="nav-hint">读取失败 <button className="link" title={failure} onClick={() => refresh(v => v + 1)}>重试</button></div>}
    {!current && !failure && <div className="nav-hint muted">正在读取标签…</div>}
    {current && branch('')}
    {current && ![...all.keys()].some(visible) && <div className="nav-hint muted">当前范围没有标签</div>}
    {manage && <div className="tree-root-drop" data-drop={dropTarget === '$root'} {...drop(null)}>拖到这里移到根层</div>}
  </div>
}
export const plugin: UiPlugin = { id: 'tag-tree', facets: [{ id: 'tag-tree.facet', title: '层级标签', kind: 'tags', field: 'values', order: 12, Component: TreeTags }] }
