import { pluginTitle } from '../../../plugins/manifest'
import { useState } from 'react'
import { managementKind } from '../../../shared/blocks'
import type { BlockKind, EntityView, FieldDef } from '../../../shared/blocks'
import { summaryText } from '../../../shared/title'
import { useEntityState, useKinds } from '../../../plugin-api/ui/data'
import type { UiHost, ViewProps } from '../plugin'
import { FieldValue, formatDate } from '../widgets'

function ReferenceValue({ id, host }: { id: string; host: UiHost }) {
  const state = useEntityState(id)
  const view = state.view
  if (state.status === 'missing') return <span className="muted">记录已不存在 · {id}</span>
  return <button className="link data-reference" title={id} onClick={() => host.openData(id)}>
    {view ? host.title(view) : id}{view?.deletedAt ? '（回收站）' : ''}
  </button>
}

function OriginalFile({ id, kind, field, index, value, host }: {
  id: string; kind: string; field: string; index?: number; value: string; host: UiHost
}) {
  const [error, setError] = useState<string>()
  const reveal = async () => {
    setError(undefined)
    try { host.reveal(await host.core.locateOriginalFile({ id, kind, field, index })) }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }
  return <div className="data-file">
    <span className="data-value">{value}</span>
    <button className="link" onClick={() => void reveal()}>在访达中显示</button>
    {error && <span className="data-error" role="alert">{error}</span>}
  </div>
}

/** 完整字段值及引用／文件入口；详情和通用检查器共用，不调用专用插件组件。 */
export function DataFields({ view, kind, def, host }: { view: EntityView; kind: string; def?: BlockKind; host: UiHost }) {
  const render = (name: string, value: unknown, field?: FieldDef, index?: number) => {
    if (field?.type === 'ref' && typeof value === 'string') return <ReferenceValue id={value} host={host} />
    if (field?.file && !def?.rebuildable && typeof value === 'string') return <OriginalFile id={view.id} kind={kind} field={name} index={index} value={value} host={host} />
    if (!field || field.type === 'json') return <pre className="data-value">{JSON.stringify(value, null, 2)}</pre>
    return <span className="data-value"><FieldValue def={{ ...field, list: false }} value={value} /></span>
  }
  return <dl className="props data-fields">
    {Object.entries(view.blocks[kind].data).map(([name, value]) => {
      const field = def?.fields[name]
      return <div className="prop-row" key={name}>
        <dt title={name}>{field?.title ?? name}</dt>
        <dd>{field?.list && Array.isArray(value)
          ? <div className="data-list">{value.map((v, index) => <div key={index}>{render(name, v, field, index)}</div>)}</div>
          : render(name, value, field)}</dd>
      </div>
    })}
    {!Object.keys(view.blocks[kind].data).length && <div className="muted">暂无字段值</div>}
  </dl>
}

export function GenericCover({ view, host }: ViewProps) {
  return <div className="cover-data">
    <span className="cover-data-kind">{Object.keys(view.blocks).map(k => host.kind(k)?.title ?? k).join(' · ') || '记录'}</span>
    <div>{summaryText(view.blocks, host.kind)}</div>
  </div>
}

export function DataDetails({ view, host }: ViewProps) {
  useKinds()
  if (managementKind(view.blocks, host.kind)) return <ManagementDetails view={view} host={host} />
  return <article className="data-details">
    <header>
      <h1>{host.title(view)}</h1>
      <div className="muted data-identity">{view.id} · {formatDate(view.createdAt)}{view.deletedAt ? ' · 已移到回收站' : ''}</div>
      <button className="small" onClick={() => host.takeout([view.id], host.title(view))}>取回数据…</button>
    </header>
    {Object.entries(view.blocks).map(([kind, block]) => {
      const def = host.kind(kind)
      return <section className="section" key={kind}>
        <h2>{def?.title ?? kind} <span className="muted">{def?.dormant ? '插件未启用 · 只读' : def?.rebuildable ? '可重建数据' : '只读查看'}</span></h2>
        <details className="data-definition"><summary>数据标识</summary><code>{kind} · 版本 {block.ver} · 序号 {block.seq}</code></details>
        {def?.template && <p className="data-template muted">来自模板：<ReferenceValue id={def.template} host={host} /></p>}
        <DataFields view={view} kind={kind} def={def} host={host} />
      </section>
    })}
    {!Object.keys(view.blocks).length && <p className="muted">此记录尚无数据块。</p>}
  </article>
}

export function DataDetailsById({ id, host }: { id: string; host: UiHost }) {
  const state = useEntityState(id)
  if (!state.view) return <div className="data-details muted" role="status">{state.status === 'missing' ? `记录已不存在：${id}` : state.status === 'error' ? `读取失败：${state.error}` : '正在读取…'}</div>
  return <>{state.status === 'error' && <div className="data-error" role="alert">刷新失败：{state.error}</div>}<DataDetails view={state.view} host={host} /></>
}

/** 管理数据只呈现定义本身，不复用素材操作与附加数据的编辑器。 */
export function ManagementDetails({ view, host }: ViewProps) {
  const def = managementKind(view.blocks, host.kind)
  if (!def) return null
  return <article className="management-details">
    <h2>{host.title(view)}</h2>
    <p className="muted">{def.title} · {pluginTitle(def.plugin)} · {def.dormant ? '插件未启用' : '只读'}</p>
    {view.deletedAt && <p className="muted">旧版已移除的记录，可在所属插件中完成删除。</p>}
    <DataFields view={view} kind={def.id} def={def} host={host} />
  </article>
}
