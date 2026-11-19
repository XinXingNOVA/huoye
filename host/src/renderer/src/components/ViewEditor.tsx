import { LayoutPicker, LayoutOptions } from './DisplayMenu'
import { layoutOptions, layoutRecord } from '../../../shared/browsing-layout'
import { useState } from 'react'
import type { Query } from '../../../shared/query'
import { querySchema } from '../../../shared/query-input'
import type { UiHost } from '../plugin'
import { layoutList, useKinds } from '../ui-registry'
import { QueryDialog, RulesEditor, SortEditor } from './QueryBuilder'

export interface ViewDraft {
  id?: string
  expectedSeq?: number
  title: string
  query: Query
  layout: string
  options: Record<string, unknown>
}
export function ViewEditor({ initial, host, onClose, onSaved }: { initial: ViewDraft; host: UiHost; onClose(): void; onSaved(id: string, draft: ViewDraft): void }) {
  const [draft, setDraft] = useState(() => structuredClone(initial))
  const [layoutMemories, setLayoutMemories] = useState<Record<string, Record<string, unknown>>>({})
  const layout = layoutList.find(l => l.id === draft.layout)
  const [editingCondition, setEditingCondition] = useState(false)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [revision, setRevision] = useState(initial.expectedSeq)
  const kinds = useKinds()
  const save = async (copy = false) => {
    setError('')
    const parsed = querySchema.safeParse(draft.query)
    if (!draft.title.trim()) { setError('请填写视图名称'); return }
    if (!parsed.success) { setError(parsed.error.issues.map(i => i.message).join('；')); return }
    setBusy(true)
    try {
      const submitted = { ...draft, options: layout ? layoutOptions(layout, draft.options) : draft.options, title: draft.title.trim(), query: parsed.data, id: copy ? undefined : draft.id, expectedSeq: revision }
      const result = await host.core.run('view', 'saveView', submitted) as { id: string }
      onSaved(result.id, submitted)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); setBusy(false) }
  }
  const reload = async () => {
    if (!initial.id) return
    setBusy(true)
    try {
      const v = (await host.core.get([initial.id]))[0]?.blocks.view
      if (!v) throw new Error('视图已删除，可以将当前规则另存为新视图')
      setLayoutMemories({}); setDraft({ ...initial, ...v.data } as ViewDraft); setRevision(v.seq); setError('')
    } catch (e) { setError(String(e)) } finally { setBusy(false) }
  }
  const missing = [...(draft.query.has ?? []), ...(draft.query.lacks ?? []), ...(draft.query.where ?? []).map(c => c.kind)].filter(id => !kinds.some(k => k.id === id))
  return <QueryDialog title={initial.id ? '编辑视图规则' : '保存为新视图'} busy={busy} onClose={onClose}>
    <fieldset disabled={busy}><label className="query-name">视图名称<input autoFocus aria-label="视图名称" value={draft.title} maxLength={200} onChange={e => setDraft({ ...draft, title: e.target.value })} /></label>
      <RulesEditor key={revision} query={draft.query} onChange={query => setDraft({ ...draft, query })} host={host} onEditing={setEditingCondition} />
      <SortEditor value={draft.query} onChange={query => setDraft({ ...draft, query })} />
      <div className="query-layout">
        <LayoutPicker value={draft.layout} onChange={id => {
          setLayoutMemories(values => ({ ...values, [draft.layout]: draft.options }))
          setDraft({ ...draft, layout: id, options: layoutOptions(layoutList.find(l => l.id === id)!, layoutMemories[id]) })
        }} />
        {layout && <LayoutOptions layout={layout} options={layoutOptions(layout, draft.options)} host={host} setOptions={options => {
          try { setDraft({ ...draft, options: layoutRecord(options) }) } catch (e) { setError(String(e)) }
        }} />}
      </div>
      {!!missing.length && <p className="muted">部分定义暂不可用，原规则会保留，可在定义恢复后继续使用。</p>}
    </fieldset>
    {error && <div className="query-error" role="alert">{error}{initial.id && <div className="query-actions"><button disabled={busy} onClick={() => void reload()}>载入最新规则</button><button disabled={busy || editingCondition} onClick={() => void save(true)}>另存为新视图</button></div>}</div>}
    <footer><span className="muted">保存规则，不复制素材。</span><button disabled={busy} onClick={onClose}>取消</button><button className="primary" disabled={busy || editingCondition} title={editingCondition ? '请先确定或取消正在编辑的条件' : undefined} onClick={() => void save()}>{busy ? '保存中…' : '保存视图'}</button></footer>
  </QueryDialog>
}
