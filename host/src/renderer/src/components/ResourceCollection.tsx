import { useCollectionLayout } from '../use-collection-layout'
import { DisplayMenu } from './DisplayMenu'
// 集合标签页：一个视图（查询 + 布局）的打开实例。
// 本地状态：临时筛选、搜索、选中、滚动锚点、卡片大小；按存档契约报告给窗口，冻结或重启后恢复。

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { CollectionSession } from '../collection-session'
import { admissionDescription, queryRules, withRules, searchesOf, type Cond, type Query, type QueryResult } from '../../../shared/query'
import { useEntityState } from '../../../plugin-api/ui/data'
import type { LayoutProps } from '../plugin'
import { useKeys } from '../plugin'
import { kindOf, useKinds } from '../ui-registry'
import type { ResourceCollectionProps } from '../../../plugin-api/ui/collection'
import { collectionFacetQuery, collectionBlockFacetQuery, replaceHasFilters, scopeCollectionQuery, scopeCollectionResult } from '../../../shared/collection'
import { pageInputReason } from '../../../shared/page-inputs'
import { effectiveQuery, toggleCollectionFilter, uniqueCollectionFilters } from '../collection-query'
import { QueryDialog, RulesEditor, SortEditor, ruleLabel, sortLabel } from './QueryBuilder'
import { ViewEditor, type ViewDraft } from './ViewEditor'
import { SearchContext } from '../search'
import { SearchBox, type SearchScope } from './SearchBox'

/** macOS 上按住 Control 点击就是右键。 */
const isMac = /Mac/.test(navigator.platform)


export function CollectionSurface({ id: tabId, params, host, active, visible = active, saved, presentationRevision, setState, setParams, setFocus, registerKeys, expose, inputs, scopeIds, Toolbar, beforeItems, onOpen, savedViews = false }: ResourceCollectionProps & { savedViews?: boolean }) {
  const viewActions = savedViews && scopeIds === undefined
  const createBlocked = pageInputReason(inputs, 'create')
  const receiveBlocked = pageInputReason(inputs, 'receive')
  const [filters, setFilters] = useState<Cond[]>(() => uniqueCollectionFilters(saved?.filters ?? []))
  const [criteria, setCriteria] = useState<Omit<Query, 'where'>>(saved?.criteria ?? {})
  const display = useCollectionLayout(params, saved, host.notify, presentationRevision)
  const { presentation, layouts, initialPresentation, current, missing, options, zoom, onAnchor, onState } = display
  const layout = display.requested.layout
  const [conditionDraft, setConditionDraft] = useState<Query>()
  const [editingCondition, setEditingCondition] = useState(false)
  const [sorting, setSorting] = useState(false)
  const [viewDraft, setViewDraft] = useState<ViewDraft>()
  const resetAfterSave = useRef(false)
  const [queryError, setQueryError] = useState('')
  const [search, setSearch] = useState(saved?.search ?? '')
  const [searchScope, setSearchScope] = useState<SearchScope>(saved?.searchScope ?? {})
  const searchBox = useRef<HTMLInputElement>(null)
  const [selection, setSelection] = useState<Set<string>>(() => new Set(saved?.selection ?? []))
  const [{ value: queried, revision: resultVersion, error: resultError }, setResult] = useState<{ value: QueryResult; revision: number; error?: string }>({ value: { ids: [], aspects: [] }, revision: -1 })
  const [highlight, setHighlight] = useState<{ ids: string[]; reveal?: { token: string; id: string } }>({ ids: [] })
  const [session] = useState(() => new CollectionSession((ids, reveal) => setHighlight({ ids, reveal })))
  const result = useMemo(() => scopeCollectionResult(queried, scopeIds), [queried, scopeIds])
  const pivot = useRef<string>(undefined)
  /** 右键按在哪些身份上：按下时定下来，紧接着的 contextmenu 事件弹出它们的菜单。 */
  const menuIds = useRef<string[]>(undefined)
  const viewState = useEntityState(params.viewId)
  const view = viewState.view

  // 保存视图来源由窗口统一订阅（包括冻结页）；模板预设名称仍跟随定义。
  const kinds = useKinds()
  useEffect(() => {
    const title = params.presetId && kindOf(params.presetId)?.title
    if (title && title !== params.title) setParams({ ...params, title })
  }, [kinds, params, setParams])

  // ---------- 查询 ----------

  const query = useMemo(() => effectiveQuery(params, { filters, criteria, search, searchScope }), [params, filters, criteria, search, searchScope])
  const runtimeQuery = useMemo(() => scopeCollectionQuery(query, scopeIds), [query, scopeIds])
  const facetQuery = useCallback((kind: string, field: string) => collectionFacetQuery(params,
    { filters, criteria, search, searchScope }, kind, field, scopeIds), [params, filters, criteria, search, searchScope, scopeIds])
  const blockFacetQuery = useCallback((kinds: readonly string[]) => collectionBlockFacetQuery(params,
    { filters, criteria, search, searchScope }, kinds, scopeIds), [params, filters, criteria, search, searchScope, scopeIds])
  const searches = useMemo(() => searchesOf(query), [query])
  const baseRules = queryRules(params.query)
  const temporaryRules = queryRules({ ...criteria, where: filters })
  const onBackgroundMenu = useCallback<LayoutProps['onBackgroundMenu']>((e, location = query) => {
    if (createBlocked) return
    const target = e.target as Element
    // 素材上的菜单交给下方的操作入口；控件与 portal 中的输入保留自身行为。
    if (!e.currentTarget.contains(target) || target.closest('[data-entity-id], input, textarea, select, button, a, [contenteditable]')) return
    e.preventDefault()
    e.stopPropagation()
    menuIds.current = undefined
    host.showCreateMenu({ tabId, query: location })
  }, [host, tabId, query, createBlocked])
  const selected = useMemo(() => result.ids.filter((id) => selection.has(id)), [result.ids, selection])
  useLayoutEffect(() => session.configure(runtimeQuery, selected, current.id, !!current.session), [session, runtimeQuery, selected, current.id, current.session])
  useLayoutEffect(() => session.accept(resultVersion, result.ids, resultError), [session, resultVersion, result.ids, resultError])
  const layoutSession = useMemo(() => ({ revision: resultVersion, highlightedIds: highlight.ids, reveal: highlight.reveal, onRendered: session.onRendered }), [resultVersion, highlight, session])
  useEffect(() => {
    let alive = true, generation = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const run = async () => {
      const current = ++generation
      const revision = session.invalidate()
      try { const r = await host.core.query(runtimeQuery); if (alive && current === generation) { setResult({ value: r, revision }); setQueryError('') } }
      catch (e) { if (alive && current === generation) { setResult(previous => ({ ...previous, revision, error: String(e) })); setQueryError(String(e)) } }
    }
    run()
    const off = host.core.on('listChanged', () => {
      generation++; session.invalidate()
      clearTimeout(timer)
      timer = setTimeout(run, 150)
    })
    return () => {
      alive = false
      clearTimeout(timer)
      off()
    }
  }, [host, runtimeQuery, session, current.id, current.session])

  // 拖动：按在已选中的卡片上时拖走整个选择（引用保持不变，卡片不必因为选择变化而重绘）
  const selectedRef = useRef(selected)
  selectedRef.current = selected
  const dragIds = useCallback((id: string) => (selectedRef.current.includes(id) ? selectedRef.current : [id]), [])

  // ---------- 存档契约：报告本地状态与焦点 ----------

  useEffect(() => {
    setState({ filters, criteria, presentation, search, searchScope, selection: selected, layouts, initialPresentation })
  }, [filters, criteria, presentation, search, searchScope, selected, layouts, initialPresentation, setState])

  useEffect(() => setFocus(selected), [selected, setFocus])

  // ---------- 筛选（侧栏分面经窗口调到这里） ----------

  const toggleFilter = useCallback((cond: Cond, options?: { exclusive?: boolean }) => {
    setFilters(fs => toggleCollectionFilter(fs, cond, !!kindOf(cond.kind)?.fields[cond.field]?.list, options?.exclusive))
  }, [])

  const setHasFilters = useCallback((kinds: readonly string[], selected: readonly string[]) => {
    setCriteria(c => ({ ...c, has: replaceHasFilters(c.has, kinds, selected) }))
  }, [])

  const selectAll = useCallback(() => setSelection(new Set(result.ids)), [result.ids])
  const select = useCallback((ids: string[]) => {
    setSelection(new Set(ids))
    pivot.current = ids[ids.length - 1]
  }, [])

  /** ⌘F：到搜索框。 */
  const find = useCallback(() => {
    searchBox.current?.focus()
    searchBox.current?.select()
  }, [])

  /** 导出什么：选中的，没选就是整个视图；文件夹默认叫"视图名 日期"。 */
  const exportable = useCallback(() => {
    const date = new Date().toISOString().slice(0, 10)
    const ids = selected.length ? selected : result.ids
    return { ids, name: `${params.title}${selected.length ? `（${selected.length} 项）` : ''} ${date}` }
  }, [selected, result.ids, params.title])

  useEffect(() => {
    if (visible) expose({ collectionSession: session, filters, toggleFilter, has: criteria.has, setHasFilters, selectAll, select, find, exportable, navigation: runtimeQuery, facetQuery, blockFacetQuery, context: { title: params.title } })
  }, [visible, session, filters, toggleFilter, criteria.has, setHasFilters, selectAll, select, find, exportable, expose, runtimeQuery, facetQuery, blockFacetQuery, params.title])

  // 从别的标签页按 ⌘F 开出来的"全部"：打开就到搜索框（只做一次）
  useEffect(() => {
    if (!params.find) return
    find()
    setParams({ ...params, find: undefined })
  }, [params, find, setParams])

  // ---------- 选择 ----------

  const selectionRef = useRef(selection)
  selectionRef.current = selection

  const onPointer = useCallback(
    (id: string, e: React.MouseEvent, order: string[] = result.ids) => {
      // 右键（或 Control 点击）：按在选中的上面就是整个选择，否则只选它（和访达一样）
      if (e.button === 2 || (isMac && e.button === 0 && e.ctrlKey && !e.metaKey)) {
        const sel = selectionRef.current
        if (sel.has(id)) menuIds.current = result.ids.filter((x) => sel.has(x))
        else {
          menuIds.current = [id]
          pivot.current = id
          setSelection(new Set([id]))
        }
        return
      }
      if (e.button !== 0) return
      setSelection((sel) => {
        if (e.metaKey || e.ctrlKey) {
          const next = new Set(sel)
          if (next.has(id)) next.delete(id)
          else next.add(id)
          pivot.current = id
          return next
        }
        if (e.shiftKey && pivot.current) {
          const a = order.indexOf(pivot.current)
          const b = order.indexOf(id)
          if (a >= 0 && b >= 0) return new Set(order.slice(Math.min(a, b), Math.max(a, b) + 1))
        }
        pivot.current = id
        // 按下已选中的卡片时保留多选，方便直接拖走
        return sel.has(id) ? sel : new Set([id])
      })
    },
    [result.ids]
  )

  // ---------- 键盘（这类标签页自己的快捷键） ----------

  useKeys(registerKeys, (e) => {
    if (e.key === ' ') {
      const id = pivot.current && selected.includes(pivot.current) ? pivot.current : selected[0]
      if (id) host.preview(id)
      return true
    }
    if (e.key === 'Escape' && selection.size) {
      setSelection(new Set())
      return true
    }
    // 回车：改名（和访达一样）
    if (e.key === 'Enter' && !e.isComposing && selected.length && params.query.scope !== 'trash') {
      host.rename(selected)
      return true
    }
    // Delete：移到回收站；在回收站里是彻底删除（先确认）
    if ((e.key === 'Backspace' || e.key === 'Delete') && selected.length) {
      if (params.query.scope === 'trash') host.purge(selected)
      else {
        host.trash(selected)
        setSelection(new Set())
      }
      return true
    }
    return false
  })

  // ---------- 布局与视图 ----------

  const temporary = temporaryRules.length > 0 || !!search.trim() || criteria.sort !== undefined || criteria.dir !== undefined || !!presentation
  const clearTemporary = () => { setFilters([]); setCriteria({}); setSearch(''); display.reset() }
  const openViewEditor = (mode: 'edit' | 'update' | 'copy') => { resetAfterSave.current = mode !== 'edit'; setViewDraft({
    ...(mode !== 'copy' && params.viewId ? { id: params.viewId, expectedSeq: view?.blocks.view?.seq } : {}),
    title: params.title, query: mode === 'edit' ? params.query : query,
    layout: mode === 'edit' ? params.layout ?? initialPresentation.layout : layout, options: mode === 'edit' ? params.options ?? {} : missing ? display.requested.options : options
  }) }
  const Layout = current.Component
  const trash = params.query.scope === 'trash'
  const hint = admissionDescription(query, kindOf)
  const dropHint = hint.blocked ?? [...hint.writes.map(s => `拖入时：${s}`), ...hint.checks.map(s => `需要满足：${s}`)].join('\n')
  const applyCriteria = (q: Query) => { const { where, ...rest } = q; setFilters(where ?? []); setCriteria(rest) }

  return (
    <div
      className="collection"
      onContextMenu={(e) => {
        const ids = menuIds.current
        menuIds.current = undefined
        const target = e.target as Element
        if (!e.currentTarget.contains(target) || target.closest('input, textarea, select, button, a, [contenteditable]')) return
        const id = target.closest<HTMLElement>('[data-entity-id]')?.dataset.entityId
        if (!id) return
        e.preventDefault()
        host.showActions(ids?.length ? ids : selection.has(id) ? selected : [id])
      }}
    >
      {/* 第一行：这是哪个视图、多少项、存视图；搜索；显示方式。选中、筛选都不会让它变长 */}
      <header className="toolbar">
        <div className="toolbar-title" title={params.title}>
          <span className="toolbar-name">{params.title}</span>
          {viewActions && !params.viewId && !params.presetId && <span className="muted">（未保存）</span>}
        </div>
        <span className="toolbar-count muted" title={receiveBlocked ?? (dropHint || '拖入的素材直接收录')}>
          {result.ids.length} 项
        </span>
        {viewActions && <div className="view-menu">
          <button className="small" aria-label="视图操作" onClick={async () => {
            const action = await host.contextMenu([
              ...(params.viewId ? [{ id: 'edit', label: '编辑视图规则…' }, ...(temporary ? [{ id: 'update', label: '将当前条件与显示更新到此视图…' }] : [])] : []),
              { id: 'copy', label: '另存为新视图…' }, ...(temporary ? [{ id: 'reset', label: '重置本页临时调整' }] : [])
            ])
            if (action === 'reset') clearTemporary()
            else if (action === 'edit' || action === 'update' || action === 'copy') openViewEditor(action)
          }}>视图 ⋯</button>
        </div>}
        <div className="toolbar-spacer" />
        {viewActions && trash && result.ids.length > 0 && (
          <button
            className="small danger"
            title="回收站里的全部彻底删除（先确认）"
            onClick={() => void host.core.query({ scope: 'trash' }).then((r) => host.purge(r.ids))}
          >
            清空回收站…
          </button>
        )}
        <SearchBox value={search} scope={searchScope} onScope={setSearchScope} onChange={setSearch} inputRef={searchBox} />
        <button className="small" onClick={() => setConditionDraft({ ...criteria, where: filters })}>＋筛选</button>
        <button className="small" title={sortLabel(query)} onClick={() => setSorting(true)}>排序</button>
        <DisplayMenu display={display} host={host} active={active} savedViews={viewActions} />
      </header>
      {Toolbar && <Toolbar host={host} ids={result.ids} selected={selected} query={runtimeQuery} />}
      {beforeItems}
      {!!baseRules.length && <details className="view-rules"><summary>视图规则 · {baseRules.length} 项<span>{baseRules.map(r => ruleLabel(r)).join('；')}</span></summary>
        <div>{baseRules.map((r, i) => <span className="chip" key={i}>{ruleLabel(r)}</span>)}{viewActions && params.viewId && <button className="small" onClick={() => openViewEditor('edit')}>编辑规则</button>}</div>
      </details>}
      {temporary && <div className="filter-bar">
        {temporaryRules.map((r, i) => <span className="chip" key={i}><button className="query-chip-label" title={ruleLabel(r)} onClick={() => setConditionDraft({ ...criteria, where: filters })}>{ruleLabel(r, true)}</button><button className="chip-x" aria-label={`移除筛选条件 ${i + 1}`} onClick={() => applyCriteria(withRules({ ...criteria, where: filters }, temporaryRules.filter((_, index) => index !== i)))}>×</button></span>)}
        {(criteria.sort !== undefined || criteria.dir !== undefined) && <button className="chip" onClick={() => setSorting(true)}>{sortLabel(query)}</button>}
        {presentation && <span className="chip">显示：{missing ? `${layout}（暂不可用）` : current.title}</span>}
        <button className="link filter-clear" onClick={clearTemporary}>重置</button>{viewActions && <button className="small" onClick={() => openViewEditor('copy')}>保存为视图…</button>}
      </div>}
      {queryError && <p className="query-error" role="alert">查询失败，当前仍显示上次结果：{queryError}</p>}
      {!!highlight.ids.length && <div className="filter-bar" role="status">AI 高亮 · {highlight.ids.length} 项<button className="link" onClick={() => session.clear()}>清除高亮</button></div>}
      {conditionDraft && <QueryDialog title="筛选" onClose={() => setConditionDraft(undefined)}>
        <p className="muted">与视图规则同时生效，只影响当前标签页。</p><RulesEditor query={conditionDraft} onChange={setConditionDraft} host={host} onEditing={setEditingCondition} />
        <footer><button onClick={() => setConditionDraft({ sort: conditionDraft.sort, dir: conditionDraft.dir })}>清除条件</button><button onClick={() => setConditionDraft(undefined)}>取消</button><button className="primary" disabled={editingCondition} title={editingCondition ? '请先确定或取消正在编辑的条件' : undefined} onClick={() => { applyCriteria(conditionDraft); setConditionDraft(undefined) }}>应用筛选</button></footer>
      </QueryDialog>}
      {sorting && <QueryDialog title="排序" onClose={() => setSorting(false)}><SortEditor value={query} onChange={q => setCriteria(c => ({ ...c, sort: q.sort, dir: q.dir ?? 'desc' }))} /><p className="muted">空值放在最后；同值保持稳定顺序。只影响本页{viewActions ? '，保存视图后才成为默认' : ''}。</p><footer><button onClick={() => setCriteria(c => ({ ...c, sort: undefined, dir: undefined }))}>恢复视图排序</button><button className="primary" onClick={() => setSorting(false)}>完成</button></footer></QueryDialog>}
      {viewDraft && <ViewEditor initial={viewDraft} host={host} onClose={() => setViewDraft(undefined)} onSaved={(viewId, draft) => {
        if (resetAfterSave.current || viewId !== viewDraft.id) clearTemporary()
        setParams({ ...params, title: draft.title, query: draft.query, layout: draft.layout, options: draft.options, viewId, presetId: undefined })
        setViewDraft(undefined)
      }} />}
      {missing && <div className="layout-unavailable" role="status">布局「{layout}」暂不可用，临时使用{current.title}；原配置仍保留。</div>}
      <SearchContext.Provider value={searches}>
      <Layout
        key={current.id}
        session={current.session ? layoutSession : undefined}
        query={runtimeQuery}
        ids={result.ids}
        aspects={result.aspects}
        options={options}
        zoom={zoom}
        selection={selection}
        host={host}
        active={active}
        visible={visible}
        state={display.memory?.state}
        onState={onState}
        anchor={display.memory?.anchor}
        onAnchor={onAnchor}
        onPointer={onPointer}
        onOpen={(id, order) => {
          const allowed = new Set(result.ids)
          if (!allowed.has(id)) return
          const from = order ? { ...runtimeQuery, orderedIds: [...new Set(order)].filter(id => allowed.has(id)) } : runtimeQuery
          if (onOpen) onOpen(id, from); else host.open(id, from)
        }}
        onBackground={() => setSelection(new Set())}
        onBackgroundMenu={onBackgroundMenu}
        dragIds={dragIds}
      />
      </SearchContext.Provider>
    </div>
  )
}
