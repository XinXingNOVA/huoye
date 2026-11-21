import { QueryInputError, queryErrorText } from '../query-labels'
import { t, useLanguage } from '../language'
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
  useLanguage()
  const [draft, setDraft] = useState(() => structuredClone(initial))
  const [layoutMemories, setLayoutMemories] = useState<Record<string, Record<string, unknown>>>({})
  const layout = layoutList.find(l => l.id === draft.layout)
  const [editingCondition, setEditingCondition] = useState(false)
  const [busy, setBusy] = useState(false), [error, setError] = useState<unknown>()
  const [revision, setRevision] = useState(initial.expectedSeq)
  const kinds = useKinds()
  const save = async (copy = false) => {
    setError(undefined)
    const parsed = querySchema.safeParse(draft.query)
    if (!draft.title.trim()) { setError(new QueryInputError('view.nameRequired')); return }
    if (!parsed.success) { setError(parsed.error.issues.map(i => i.message).join(t('query.separator'))); return }
    setBusy(true)
    try {
      const submitted = { ...draft, options: layout ? layoutOptions(layout, draft.options) : draft.options, title: draft.title.trim(), query: parsed.data, id: copy ? undefined : draft.id, expectedSeq: revision }
      const result = await host.core.run('view', 'saveView', submitted) as { id: string }
      onSaved(result.id, submitted)
    } catch (e) { setError(e); setBusy(false) }
  }
  const reload = async () => {
    if (!initial.id) return
    setBusy(true)
    try {
      const v = (await host.core.get([initial.id]))[0]?.blocks.view
      if (!v) throw new QueryInputError('view.gone')
      setLayoutMemories({}); setDraft({ ...initial, ...v.data } as ViewDraft); setRevision(v.seq); setError(undefined)
    } catch (e) { setError(e) } finally { setBusy(false) }
  }
  const missing = [...(draft.query.has ?? []), ...(draft.query.lacks ?? []), ...(draft.query.where ?? []).map(c => c.kind)].filter(id => !kinds.some(k => k.id === id))
  return <QueryDialog title={initial.id ? t('view.editRules') : t('view.saveNew')} busy={busy} onClose={onClose}>
    <fieldset disabled={busy}><label className="query-name">{t('view.name')}<input autoFocus aria-label={t('view.name')} value={draft.title} maxLength={200} onChange={e => setDraft({ ...draft, title: e.target.value })} /></label>
      <RulesEditor key={revision} query={draft.query} onChange={query => setDraft({ ...draft, query })} host={host} onEditing={setEditingCondition} />
      <SortEditor value={draft.query} onChange={query => setDraft({ ...draft, query })} />
      <div className="query-layout">
        <LayoutPicker value={draft.layout} onChange={id => {
          setLayoutMemories(values => ({ ...values, [draft.layout]: draft.options }))
          setDraft({ ...draft, layout: id, options: layoutOptions(layoutList.find(l => l.id === id)!, layoutMemories[id]) })
        }} />
        {layout && <LayoutOptions layout={layout} options={layoutOptions(layout, draft.options)} host={host} setOptions={options => {
          try { setDraft({ ...draft, options: layoutRecord(options) }) } catch (e) { setError(e) }
        }} />}
      </div>
      {!!missing.length && <p className="muted">{t('view.missing')}</p>}
    </fieldset>
    {error != null && <div className="query-error" role="alert">{queryErrorText(error)}{initial.id && <div className="query-actions"><button disabled={busy} onClick={() => void reload()}>{t('view.reload')}</button><button disabled={busy || editingCondition} onClick={() => void save(true)}>{t('view.copy')}</button></div>}</div>}
    <footer><span className="muted">{t('view.help')}</span><button disabled={busy} onClick={onClose}>{t('common.cancel')}</button><button className="primary" disabled={busy || editingCondition} title={editingCondition ? t('view.finishEditing') : undefined} onClick={() => void save()}>{busy ? t('view.saving') : t('view.save')}</button></footer>
  </QueryDialog>
}
