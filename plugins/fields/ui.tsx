import { pluginMessages as packageMessages, useLocale as useUiLocale } from '@resource-manager/plugin-api/ui/locale'
import { acceleratorLabel } from '@resource-manager/plugin-api/ui/widgets'
// 自定义字段插件的界面：检查器里的模板分区（挂上的模板、添加模板），筛选面板里的模板分面（按模板筛选、管理模板与打开表格视图）。
// 填字段用的是宿主的值类型编辑器；模板的"表"是一个表格视图：有这个模板，布局为表格。

import { useEffect, useId, useMemo, useState, type MouseEvent } from 'react'
import type { BlockKind } from '@resource-manager/plugin-api/blocks'
import type { Query } from '@resource-manager/plugin-api/query'
import { BlockEditor } from '@resource-manager/plugin-api/ui/fields'
import { useKinds } from '@resource-manager/plugin-api/ui/data'
import type { BlockSectionProps, CollectionOpen, FacetProps, UiHost, UiPlugin, ViewProps } from '@resource-manager/plugin-api/ui/contracts'
import { addOption, createTemplate, promoteTag, renameTemplate } from './edit'
import { templateTableTools } from './table'
import { editTemplate } from './template-editor'
import { isEnter } from '@resource-manager/plugin-api/ui/widgets'
import './dialog.css'
import './styles.css'

const uiText = packageMessages('fields')


/** 没进回收站的模板身份。模板移到回收站后，定义仍然有效（已经填的数据照样能显示），只是不再列出。 */
function useTemplates(host: UiHost, removed = false): string[] {
  const [ids, setIds] = useState<string[]>([])
  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const run = () => host.core.query({ scope: removed ? 'trash' : 'all', role: 'management', has: ['template'], dir: 'asc' }).then((r) => alive && setIds(r.ids))
    run()
    const off = host.core.on('listChanged', () => {
      clearTimeout(timer)
      timer = setTimeout(run, 150)
    })
    return () => {
      alive = false
      clearTimeout(timer)
      off()
    }
  }, [host, removed])
  return ids
}

const isTemplate = (k: BlockKind) => k.plugin === 'fields' && k.template !== undefined

/** 打开一个模板的"表"：有这个模板的身份，用表格布局。 */
export const templateTable = (k: BlockKind): CollectionOpen => ({
  title: k.title,
  query: { has: [k.id] },
  layout: 'table',
  presetId: k.id,
  base: { layout: 'table' }
})

function TemplateBlockSection({ view, host, kind }: BlockSectionProps) {
  useUiLocale()
  return <div className="template-block">
    <div className="template-head">
      <button className="link" onClick={() => host.openTab('collection', templateTable(kind) as unknown as Record<string, unknown>)}>{uiText("打开模板视图")}</button>
      <button className="link" onClick={() => editTemplate(host, kind.template!)}>{uiText("编辑模板")}</button>
      <button className="nav-x" title={uiText("从这个素材上移除这个模板")} aria-label={uiText("移除模板：{title}", { title: String(kind.title) })} onClick={() => host.core.remove(view.id, kind.id)}>×</button>
    </div>
    <BlockEditor kind={kind} view={view} host={host} onAddOption={(field, option) => addOption(host, kind.template!, field, option)} />
  </div>
}

function AddTemplateSection({ view, host }: ViewProps) {
  useUiLocale()
  const kinds = useKinds()
  const live = useTemplates(host)
  const available = kinds.filter((k) => isTemplate(k) && live.includes(k.template!) && !view.blocks[k.id])

  return (
    <>
      {available.length > 0 && (
        <select
          className="select add-template"
          value=""
          onChange={(e) => {
            if (e.target.value) void host.core.put(view.id, e.target.value, {})
          }}
        >
          <option value="">{uiText("＋ 添加模板…")}</option>
          {available.map((k) => (
            <option key={k.id} value={k.id}>
              {k.title}
            </option>
          ))}
        </select>
      )}
    </>
  )
}

function TemplatesFacet({ host, facet, api, active = true }: FacetProps) {
  useUiLocale()
  const kinds = useKinds()
  const live = useTemplates(host)
  const removed = useTemplates(host, true)
  const [manage, setManage] = useState(false)
  const [naming, setNaming] = useState<string>()
  /** ＋ 打开的小菜单：新建，或者从标签升级（列出已有的标签）。 */
  const [adding, setAdding] = useState<'menu' | 'tags'>()
  const [tags, setTags] = useState<{ value: string; count: number }[]>([])
  const [renaming, setRenaming] = useState<{ id: string; title: string }>()
  const [recentIds, setRecentIds] = useState<string[]>([])
  const [countState, setCountState] = useState<{ key: string; values: Record<string, number>; error?: string }>()
  const [countRevision, setCountRevision] = useState(0)

  const list = useMemo(
    () => [...live, ...removed].map((id) => kinds.find((k) => k.template === id)).filter((k): k is BlockKind => !!k),
    [live, removed, kinds]
  )
  const tplIds = useMemo(() => list.map((k) => k.id), [list])
  const tplIdsKey = JSON.stringify(tplIds)
  const baseQuery = manage ? ({ scope: 'all', role: 'material' } satisfies Query) : api.blockFacetQuery?.(tplIds)
  const scopeKey = JSON.stringify({ manage, tplIdsKey, query: baseQuery })

  const counts = countState?.key === scopeKey ? countState.values : {}
  const countsReady = countState?.key === scopeKey
  const countError = countsReady ? countState?.error : undefined

  useEffect(() => {
    let alive = true, generation = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    if (!active) return
    const parsed = JSON.parse(scopeKey) as { query?: Query }
    const ids = JSON.parse(tplIdsKey) as string[]
    if (!ids.length) {
      setCountState({ key: scopeKey, values: {} })
      return
    }
    const load = async () => {
      const ticket = ++generation
      try {
        const values = await host.core.kindCounts(ids, parsed.query)
        if (alive && ticket === generation) setCountState({ key: scopeKey, values })
      } catch (error) {
        if (alive && ticket === generation) setCountState({ key: scopeKey, values: {}, error: String(error) })
      }
    }

    const schedule = () => {
      ++generation
      clearTimeout(timer)
      timer = setTimeout(() => void load(), 120)
    }
    void load()
    const offChanged = host.core.on('changed', schedule)
    const offList = host.core.on('listChanged', schedule)
    return () => {
      alive = false
      clearTimeout(timer)
      offChanged()
      offList()
    }
  }, [host, scopeKey, tplIdsKey, countRevision, active])

  // 从标签升级要用标签插件的数据：它没有启用就不提供
  const tagsOn = kinds.some((k) => k.id === 'tags' && !k.dormant)
  const selectedTplIds = useMemo(() => (api.has ?? []).filter((id) => tplIds.includes(id)), [api.has, tplIds])
  const isActive = (id: string) => selectedTplIds.includes(id)

  const openTable = (k: BlockKind) => {
    host.openTab('collection', templateTable(k) as unknown as Record<string, unknown>)
  }

  const pickTemplate = (e: MouseEvent, k: BlockKind) => {
    if (!api.setHasFilters) { openTable(k); return }
    const next = e.metaKey || e.ctrlKey
      ? isActive(k.id) ? selectedTplIds.filter(id => id !== k.id) : [...selectedTplIds, k.id]
      : selectedTplIds.length === 1 && isActive(k.id) ? [] : [k.id]
    api.setHasFilters(tplIds, next)
  }

  const submit = async () => {
    const title = naming?.trim()
    setNaming(undefined)
    if (!title) return
    try {
      const kind = await createTemplate(host, title)
      setRecentIds((prev) => (prev.includes(kind) ? prev : [...prev, kind]))
      editTemplate(host, kind.slice('tpl:'.length))
    } catch (e) { host.notify(String(e)) }
  }

  const shown = manage
    ? list
    : list.filter((k) => !removed.includes(k.template!) && ((counts[k.id] ?? 0) > 0 || isActive(k.id) || recentIds.includes(k.id)))

  return (
    <div
      className="nav-group fields-facet"
      onKeyDown={(e) => {
        if ((e.target as Element).matches('input')) e.stopPropagation()
      }}
    >
      <div className="nav-title">
        <span>{facet.title}</span>
        <div className="fields-facet-tools">
          {list.length > 0 && (
            <button
              type="button"
              className="nav-add"
              aria-label={uiText("整理模板")}
              aria-pressed={manage}
              title={manage ? uiText("完成整理") : uiText("管理全部模板与字段")}
              onClick={() => {
                setManage(!manage)
                setRenaming(undefined)
              }}
            >
              {manage ? uiText("完成") : uiText("整理")}
            </button>
          )}
          <button
            type="button"
            className="nav-add"
            title={uiText("新建模板")}
            aria-label={uiText("新建模板")}
            onClick={() => setAdding(adding ? undefined : 'menu')}
          >
            ＋
          </button>
        </div>
      </div>
      {adding === 'menu' && (
        <div className="nav-menu">
          <button
            className="nav-item"
            onClick={() => {
              setAdding(undefined)
              setNaming('')
            }}
          >{uiText("新建模板")}{' '}</button>
          {tagsOn && (
            <button
              className="nav-item"
              title={uiText("带这个标签的素材都挂上同名模板，标签去掉；以后可以给模板加字段")}
              onClick={async () => {
                setTags(await host.core.facet('tags', 'values'))
                setAdding('tags')
              }}
            >{uiText("从标签升级…")}{' '}</button>
          )}
        </div>
      )}
      {adding === 'tags' && (
        <div className="nav-menu">
          <div className="nav-hint muted">{uiText("选一个标签升级为模板")}</div>
          {tags.map((t) => (
            <button
              key={t.value}
              className="nav-item"
              onClick={async () => {
                setAdding(undefined)
                const r = await promoteTag(host, t.value)
                setRecentIds((prev) => (prev.includes(r.kind) ? prev : [...prev, r.kind]))
                host.notify(uiText("已把标签「{value}」升级为模板（{count} 项），可以撤销（{value3}）", { value: String(t.value), count: String(r.count), value3: String(acceleratorLabel('CmdOrCtrl+Z')) }))
                openTable({ id: r.kind, title: t.value } as BlockKind)
              }}
            >
              <span className="nav-label">{t.value}</span>
              <span className="nav-count">{t.count}</span>
            </button>
          ))}
          {!tags.length && <div className="nav-hint muted">{uiText("还没有标签")}</div>}
        </div>
      )}
      {shown.map((k) =>
        manage && renaming?.id === k.id ? (
          <input
            key={k.id}
            className="name-input nav-input"
            autoFocus
            value={renaming.title}
            onChange={(e) => setRenaming({ id: k.id, title: e.target.value })}
            onKeyDown={(e) => {
              if (isEnter(e) && renaming.title.trim()) {
                void renameTemplate(host, k.template!, renaming.title.trim())
                setRenaming(undefined)
              } else if (e.key === 'Escape') setRenaming(undefined)
            }}
            onBlur={() => setRenaming(undefined)}
          />
        ) : manage ? (
          <div key={k.id} className="nav-item view-item fields-facet-row" data-template-facet={k.id}>
            <button
              type="button"
              className="nav-label"
              title={uiText("双击改名，点击打开模板表格视图")}
              onClick={() => openTable(k)}
              onDoubleClick={() => setRenaming({ id: k.id, title: k.title })}
            >
              {k.title}{removed.includes(k.template!) ? uiText("（旧版已移除）") : ''}
            </button>
            <span className="nav-count">{countsReady && !countError ? counts[k.id] ?? 0 : '—'}</span>
            <button
              type="button"
              className="nav-x"
              aria-label={uiText("打开模板表格视图：{title}", { title: String(k.title) })}
              title={uiText("打开「{title}」表格视图", { title: String(k.title) })}
              onClick={() => openTable(k)}
            >
              ⊞
            </button>
            <button
              type="button"
              className="nav-x"
              aria-label={uiText("编辑模板：{title}", { title: String(k.title) })}
              title={uiText("编辑模板")}
              onClick={() => editTemplate(host, k.template!)}
            >
              ✎
            </button>
            <button
              type="button"
              className="nav-x"
              title={uiText("删除模板与对应字段（可撤销）")}
              onClick={() => host.showDialog(close => <DeleteTemplateDialog host={host} template={k.template!} title={k.title} close={close} />)}
            >
              ×
            </button>
          </div>
        ) : (
          <div key={k.id} className={`nav-item view-item fields-facet-row${isActive(k.id) ? ' active' : ''}`} data-template-facet={k.id}>
            <button
              type="button"
              className="nav-label"
              aria-pressed={isActive(k.id)}
              title={uiText("按模板「{title}」筛选当前列表；⌘/Ctrl 点击叠加筛选", { title: String(k.title) })}
              onClick={(e) => pickTemplate(e, k)}
            >
              {k.title}
            </button>
            <span className="nav-count">{countsReady && !countError ? counts[k.id] ?? 0 : '—'}</span>
            <button
              type="button"
              className="nav-x fields-open-table"
              aria-label={uiText("打开模板表格视图：{title}", { title: String(k.title) })}
              title={uiText("打开「{title}」表格视图", { title: String(k.title) })}
              onClick={(e) => {
                e.stopPropagation()
                openTable(k)
              }}
            >
              ⊞
            </button>
          </div>
        )
      )}
      {naming !== undefined ? (
        <input
          className="name-input nav-input"
          autoFocus
          value={naming}
          placeholder={uiText("模板名称，回车新建")}
          onChange={(e) => setNaming(e.target.value)}
          onKeyDown={(e) => {
            if (isEnter(e)) void submit()
            else if (e.key === 'Escape') setNaming(undefined)
          }}
          onBlur={() => setNaming(undefined)}
        />
      ) : countError ? (
        <div className="nav-hint" role="alert">{uiText("模板计数读取失败")}{' '}<button className="link" title={countError} onClick={() => setCountRevision(n => n + 1)}>{uiText("重试")}</button></div>
      ) : !list.length ? (
        <button className="nav-item muted" onClick={() => setNaming('')}>{uiText("新建模板…")}{' '}</button>
      ) : !manage && !shown.length && countsReady ? (
        <div className="nav-hint muted fields-empty-hint">
          <span>{uiText("当前范围无模板素材")}</span>
          <button type="button" className="link" onClick={() => setManage(true)}>{uiText("全部（")}{live.length}）
          </button>
        </div>
      ) : null}
    </div>
  )
}

export const fieldsUi: UiPlugin = {
  id: 'fields',
  extensions: [{ id: 'fields.template', point: 'table.tools', version: 1, order: 10, value: templateTableTools }],
  sections: [
    {
      id: 'templates',
      get title() { return uiText("添加模板") },
      order: 41,
      kinds: [],
      match: (_view, definitions) => definitions.kinds().some(isTemplate),
      Component: AddTemplateSection
    }
  ],
  blockSections: [{ id: 'fields.template', priority: 10, order: 40, match: isTemplate, Component: TemplateBlockSection }],
  facets: [{ id: 'fields.templates', get title() { return uiText("模板") }, source: 'blocks', order: 40, Component: TemplatesFacet }],
  // 模板里的单选、多选：取值有限，适合在侧栏按值筛选
  facetsFor: (kinds) =>
    kinds.filter(isTemplate).flatMap((k) =>
      Object.entries(k.fields)
        .filter(([, f]) => f.type === 'enum')
        .map(([field, f]) => ({ title: `${k.title} · ${f.title}`, kind: k.id, field, order: 50 }))
    )
}

export { fieldsUi as plugin }

function DeleteTemplateDialog({ host, template, title, close }: { host: UiHost; template: string; title: string; close(): void }) {
  useUiLocale()
  const titleId = useId()
  const descriptionId = useId()
  const [affected, setAffected] = useState<number>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let alive = true
    void host.core.preview('fields', 'deleteTemplate', { template }).then(result => {
      if (alive) setAffected((result as { affected: number }).affected)
    }).catch(e => { if (alive) setError(String(e)) })
    return () => { alive = false }
  }, [host, template])
  const remove = async () => {
    setBusy(true)
    try {
      const result = await host.core.run('fields', 'deleteTemplate', { template, expectedAffected: affected }) as { affected: number }
      close()
      host.notify(uiText("已删除模板及 {affected} 项上的对应字段，可以撤销（{value2}）", { affected: String(result.affected), value2: String(acceleratorLabel('CmdOrCtrl+Z')) }))
    } catch (e) { setError(String(e)); setBusy(false) }
  }
  return <div className="management-delete fields-delete-dialog" role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId}>
    <h2 id={titleId}>{uiText("删除模板「")}{title}」</h2>
    <div id={descriptionId}>
      <div className="fields-delete-impact" aria-live="polite">
        <div className="fields-delete-label">{uiText("删除范围")}</div>
        <p>{affected === undefined
          ? error ? uiText("未能确认使用情况，暂时无法删除。") : uiText("正在检查使用情况…")
          : affected === 0 ? uiText("仅删除模板定义，目前没有记录使用此模板。")
            : <>{uiText("删除模板，并移除")}{' '}<strong>{affected}{' '}{uiText("项")}</strong>{uiText("上的对应字段及已填写内容。")}</>}</p>
        {affected !== undefined && affected > 0 && <p className="fields-delete-caption">{uiText("包含回收站中的记录。")}</p>}
      </div>
      <p className="fields-delete-preserved">{uiText("素材、原文件和其他数据保留。")}</p>
    </div>
    {error && <p className="data-error" role="alert">{error}</p>}
    <div className="fields-delete-actions">
      <span className="fields-delete-undo">{uiText("本次删除可整体撤销")}</span>
      <button className="small" autoFocus onClick={close} disabled={busy}>{uiText("取消")}</button>
      <button className="small fields-delete-confirm" disabled={affected === undefined || !!error || busy} onClick={() => void remove()}>{busy ? uiText("正在删除…") : uiText("删除模板与字段")}</button>
    </div>
  </div>
}
