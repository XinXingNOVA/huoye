import { kindTitle, scopeTitle } from '../schema-labels'
import { t, useLanguage, displayDate } from '../language'
import { useEffect, useState } from 'react'
import type { EntityView } from '../../../shared/blocks'
import { useEntity } from '../entity-cache'
import type { UiHost } from '../plugin'
import { actionsFor, blockSectionFor, coverFor, genericKindsFor, kindOf, renamerFor, titleProviderFor, sectionsFor, titleFor, useKinds } from '../ui-registry'
import { BlockEditor, editable } from '../fields'
import { acceleratorLabel, formatBytes } from '../widgets'
import { DataFields, ManagementDetails } from './DataDetails'
import { isContainer, managementKind } from '../../../shared/blocks'
import { InspectorSections, type InspectorEntry } from './InspectorSections'
import { EditPencilIcon } from './icons'
import { InspectorActions, InspectorAction } from './InspectorActions'
import type { PageAccess } from '../app/page-access'

type SummaryFact = { id: 'type' | 'size' | 'spec' | 'added'; label: string; value: string; fields?: { kind: string; field: string }[] }

function summaryFacts(view: EntityView): SummaryFact[] {
  const file = view.blocks.file?.data
  const image = view.blocks.image?.data
  const video = view.blocks.video?.data
  const pdf = view.blocks.pdf?.data
  const text = view.blocks.text?.data
  const anchor = view.blocks.anchor?.data
  const status = view.blocks.status?.data

  const typeValue = file?.ext
    ? String(file.ext).toUpperCase()
    : text
      ? t('workbench.typeText')
      : anchor
        ? String(anchor.type ?? t('workbench.annotation'))
        : (Object.keys(view.blocks).map(id => scopeTitle({ kind: id }))[0] ?? t('workbench.item'))

  const sizeValue = file?.size != null
    ? formatBytes(Number(file.size))
    : text?.content != null
      ? t('workbench.chars', { count: String(text.content).length })
      : '—'

  const spec: Omit<SummaryFact, 'id' | 'label'> = image?.width && image?.height
    ? { value: `${String(image.width)} × ${String(image.height)}`, fields: [{ kind: 'image', field: 'width' }, { kind: 'image', field: 'height' }] }
    : video?.width && video?.height
      ? { value: `${String(video.width)} × ${String(video.height)}`, fields: [{ kind: 'video', field: 'width' }, { kind: 'video', field: 'height' }] }
      : pdf?.pages != null
        ? { value: t('workbench.pages', { count: String(pdf.pages) }), fields: [{ kind: 'pdf', field: 'pages' }] }
        : status?.value
          ? { value: String(status.value), fields: [{ kind: 'status', field: 'value' }] }
          : { value: t('workbench.properties', { count: Object.keys(view.blocks).length }) }

  const dateValue = displayDate(view.createdAt)

  return [
    { id: 'type', label: t('workbench.type'), value: typeValue, fields: file?.ext ? [{ kind: 'file', field: 'ext' }] : [] },
    { id: 'size', label: t('workbench.size'), value: sizeValue, fields: file?.size != null ? [{ kind: 'file', field: 'size' }] : [] },
    { id: 'spec', label: t('workbench.spec'), ...spec },
    { id: 'added', label: t('workbench.added'), value: dateValue }
  ]
}

export function Inspector({ selection, host, pages, onLocate }: { selection: string[]; host: UiHost; pages: PageAccess; onLocate(id: string): void }) {
  useLanguage()
  if (selection.length === 0) {
    return (
      <aside className="inspector empty-inspector">
        <div className="empty-inspector-card">
          <div className="empty-inspector-icon" aria-hidden="true">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="4" width="18" height="16" rx="2.5" />
              <path d="M15 4v16M7 9h5m-5 4h3" />
            </svg>
          </div>
          <div className="empty-inspector-title">{t('workbench.noSelection')}</div>
          <div className="empty-inspector-hints muted">
            <span>{t('workbench.infoHint')}</span>
            <span><kbd>Space</kbd> {t('start.preview')} · <kbd>{acceleratorLabel('CmdOrCtrl+P')}</kbd> {t('palette.title')}</span>
          </div>
        </div>
      </aside>
    )
  }
  if (selection.length > 1) return <Many ids={selection} host={host} />
  return <Single key={selection[0]} id={selection[0]} host={host} pages={pages} onLocate={onLocate} />
}

/** 这些身份的数据，它们变了就重新取。 */
function useViews(host: UiHost, ids: string[]): EntityView[] {
  const [views, setViews] = useState<EntityView[]>([])
  const key = ids.join(',')
  useEffect(() => {
    let alive = true
    const load = () => void host.core.get(ids).then((v) => alive && setViews(v))
    load()
    const set = new Set(ids)
    const off = host.core.on('changed', ({ ids: changed }) => {
      if (changed.some((id) => set.has(id))) load()
    })
    return () => {
      alive = false
      off()
    }
    // ids 按内容比较（key）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host, key])
  return views
}

/** 选中了好几项：能对它们做什么（和右键菜单同一份，来自操作扩展点）。 */
function Many({ ids, host }: { ids: string[]; host: UiHost }) {
  const views = useViews(host, ids)
  return (
    <aside className="inspector">
      <div className="inspector-hero-card many-hero">
        <div className="inspector-many-badge" aria-hidden="true">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <rect x="6" y="6" width="14" height="14" rx="2" />
            <path d="M4 16V5a2 2 0 0 1 2-2h11" />
          </svg>
        </div>
        <div className="inspector-many-text">
          <h2 className="inspector-title">{t('workbench.selectedCount', { count: ids.length })}</h2>
          <span className="inspector-many-sub muted">{t('workbench.selectionHint')}</span>
        </div>
      </div>
      <InspectorActions views={views.length === ids.length ? views : []} host={host} />
    </aside>
  )
}

function Single({ id, host, pages, onLocate }: { id: string; host: UiHost; pages: PageAccess; onLocate(id: string): void }) {
  useLanguage()
  const view = useEntity(id)
  const [renaming, setRenaming] = useState(false)
  // 用户改了模板（新字段、改名）时跟着重绘
  useKinds()
  if (!view) return <aside className="inspector" />
  if (managementKind(view.blocks, host.kind)) return <aside className="inspector"><ManagementDetails view={view} host={host} /></aside>
  const cover = coverFor(view)
  const facts = summaryFacts(view)
  const TitleEditor = titleProviderFor(view)?.TitleEditor
  // 去重依据与摘要同源，仅标记实际呈现的字段。
  const summarizedFields = facts.flatMap(fact => fact.fields ?? [])
  if (view.blocks.file && titleFor(view) === view.blocks.file.data.name) summarizedFields.push({ kind: 'file', field: 'name' })
  const actions = actionsFor([view]).byId
  const entries: InspectorEntry[] = sectionsFor(view).map(s => ({
    id: `section:${s.id}`, title: s.id === 'file' ? t('schema.file') : s.id === 'image' ? t('schema.image') : s.title, order: s.order,
    actions: s.actions?.map(id => actions.get(id)).filter(a => !!a).filter(a => !a.danger).map(action => <InspectorAction key={action.id} action={action} views={[view]} host={host} />),
    content: <s.Component key={view.id} view={view} host={host} summarizedFields={summarizedFields} />
  }))
  const container = isContainer(view.blocks, host.kind)
  for (const kind of genericKindsFor(view)) {
    const def = kindOf(kind), legacy = container && !def?.container && !def?.allowOnContainer
    const provider = def && !legacy ? blockSectionFor(def) : undefined
    entries.push({ id: `block:${kind}`, title: def ? kindTitle(def) : kind, order: provider?.order ?? 1000,
      inactive: !def || !!def.dormant || legacy,
      hint: !def ? t('inspect.unknown') : def.dormant ? t('inspect.dormant') : legacy ? t('inspect.legacy') : undefined,
      content: provider && def ? <provider.Component key={view.id} view={view} host={host} kind={def} summarizedFields={summarizedFields} />
        : def && !legacy && editable(def) ? <BlockEditor key={view.id} kind={def} view={view} host={host} />
        : <DataFields key={view.id} kind={kind} view={view} host={host} def={def} /> })
  }

  return (
    <aside className="inspector">
      <div className="inspector-hero-card">
        <div className="inspector-cover">{cover && <cover.Component view={view} host={host} />}</div>
        {renaming && TitleEditor && !view.deletedAt ? <TitleEditor view={view} host={host} onDone={() => setRenaming(false)} /> : !view.deletedAt && (TitleEditor || renamerFor([view])) ? (
          <h2 className="inspector-title renamable"><button title={t('inspect.rename')} aria-label={t('inspect.renameItem')} onClick={() => TitleEditor ? setRenaming(true) : host.rename([view.id])}>
            {titleFor(view)}<EditPencilIcon className="inspector-rename-icon" />
          </button></h2>
        ) : (
          <h2 className="inspector-title">{titleFor(view)}</h2>
        )}
        <div className="inspector-meta-grid">
          {facts.map((fact) => (
            <div key={fact.id} data-fact={fact.id} className="inspector-meta-cell">
              <span className="inspector-meta-label">{fact.label}</span>
              <span className="inspector-meta-value" title={fact.value}>{fact.id === 'type' && view.blocks.file?.data.ext ? <button className="link" onClick={() => host.toggleFilter({ op: 'eq', kind: 'file', field: 'ext', value: String(view.blocks.file.data.ext) })}>{fact.value}</button> : fact.value}</span>
            </div>
          ))}
        </div>
      </div>

      <InspectorActions views={[view]} host={host} pages={pages} onLocate={onLocate} />

      <Failures view={view} host={host} />
      <InspectorSections key={host.root} entries={entries} host={host} />

      <div className="inspector-foot muted">
        <span>{view.deletedAt ? t('workbench.trashedOn', { date: displayDate(view.deletedAt, true) }) : t('workbench.addedOn', { date: displayDate(view.createdAt, true) })}</span>
      </div>
    </aside>
  )
}

function Failures({ view, host }: { view: EntityView; host: UiHost }) {
  const entries = Object.entries(view.failures)
  if (!entries.length) return null
  return (
    <section className="section failures">
      <h3>{t('inspect.processingFailed')}</h3>
      {entries.map(([system, error]) => (
        <div key={system} className="failure">
          <code>{system}</code> {error}
        </div>
      ))}
      <button className="small" onClick={() => host.core.regenerate([view.id])}>
        {t('inspect.regenerate')}
      </button>
    </section>
  )
}
