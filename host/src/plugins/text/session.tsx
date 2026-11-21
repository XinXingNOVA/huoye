import { uiText, useUiLocale } from '../../shared/i18n/interface-display'
import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import type { EntityView } from '../../shared/blocks'
import type { UiHost } from '../../plugin-api/ui/contracts'
import type { EditCommit, EditSession } from '../../plugin-api/ui/editing'

export const textSessionKey = (id: string) => `text:content:${id}`
export function openTextSession(view: EntityView, host: UiHost) {
  const block = view.blocks.text
  if (!block) return host.editing.get(textSessionKey(view.id))
  return host.editing.open(textSessionKey(view.id), { text: String(block.data.content ?? ''), revision: block.seq },
    async (base, text) => await host.core.run('text', 'save', { id: view.id, revision: base.revision, text }) as Awaited<ReturnType<EditCommit>>)
}
export function useTextSession(view: EntityView, host: UiHost) {
  const block = view.blocks.text
  const session = useMemo(() => openTextSession(view, host), [host.editing, host.core, view.id, !!block])
  useEffect(() => { if (block) session?.observe({ text: String(block.data.content ?? ''), revision: block.seq }) }, [session, block])
  const snapshot = useSyncExternalStore(session?.subscribe ?? noopSubscribe, session?.snapshot ?? empty)
  return { session, snapshot }
}
const noopSubscribe = () => () => {}
const empty = () => undefined

/** 自动保存不占版面；仅需用户介入时提供不挤动正文的处理入口。 */
export function DraftStatus({ session, unavailable = false }: { session: EditSession; unavailable?: boolean }) {
  useUiLocale()
  const state = useSyncExternalStore(session.subscribe, session.snapshot)
  const lastError = useRef<string | undefined>(undefined)
  if (state.error) lastError.current = state.error
  else if (!state.dirty && !state.saving) lastError.current = undefined
  const error = lastError.current
  if (!state.conflict && !error && !(unavailable && state.dirty)) return null
  const title = state.conflict ? uiText("草稿与仓库内容冲突") : error ? uiText("保存失败，草稿保留") : uiText("此处无法保存，草稿保留")
  return <details className="text-draft-status">
    <summary><span role="status">{title}</span><span className="muted">{uiText("查看处理")}</span></summary>
    <div className="text-draft-actions">
      {error && !state.conflict && <p>{error}</p>}
      <details><summary>{uiText("查看未保存草稿")}</summary><pre>{state.text}</pre></details>
      {state.conflict ? <>
        <details><summary>{uiText("查看仓库中的内容")}</summary><pre>{state.conflict.text}</pre></details>
        <button className="small" disabled={state.saving} onClick={() => session.resolve('remote')}>{uiText("丢弃草稿，采用仓库内容")}</button>
        <button className="small" disabled={state.saving} onClick={() => session.resolve('draft')}>{uiText("保留草稿，替换已查看的版本")}</button>
      </> : <>
        <button className="small" disabled={state.saving} onClick={() => { void session.save().catch(() => {}) }}>{state.saving ? uiText("正在重试…") : uiText("重试保存")}</button>
        <button className="small" disabled={state.saving} onClick={() => session.discard()}>{uiText("丢弃未保存草稿")}</button>
      </>}
    </div>
  </details>
}
