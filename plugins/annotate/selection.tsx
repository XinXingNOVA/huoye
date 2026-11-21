import { pluginMessages as packageMessages, useLocale as useUiLocale } from '@resource-manager/plugin-api/ui/locale'
import { useEffect, useRef, useState } from 'react'
import { useEntity } from '@resource-manager/plugin-api/ui/data'
import type { SelectionAction, SelectionActionContext, SelectionSurfaceProps } from '@resource-manager/plugin-api/ui/selection'
import { isContentLocator, type ContentReference } from '@resource-manager/plugin-api/content-selection'
import { annotationBlocks, isContentQuote, labelOf, useLocals } from './common'
import './selection.css'

const uiText = packageMessages('annotate')

export function contentReference(view: import('@resource-manager/plugin-api/blocks').EntityView): ContentReference | undefined {
  const a = view.blocks.anchor?.data
  return isContentQuote(view) && isContentLocator(a.locator) ? { sourceId: String(a.target), text: String(a.quote), locator: a.locator } : undefined
}
async function save(ctx: SelectionActionContext, text: string) {
  if (!ctx.valid()) throw new Error(uiText("来源已切换或内容已变化，请重新选择文字"))
  const s = ctx.selection
  const id = await ctx.host.core.create({ anchor: { target: s.sourceId, type: '内容摘录', quote: s.text, locator: s.locator, aspect: s.text.length <= 60 ? 2 : 1.4 }, ...annotationBlocks(ctx.host, text) })
  ctx.select(id); window.getSelection()?.removeAllRanges()
}
function NoteDialog({ ctx, close }: { ctx: SelectionActionContext; close(): void }) {
  useUiLocale()
  const [text, setText] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const saving = useRef(false)
  const submit = async () => { if (saving.current) return; saving.current = true; setBusy(true); try { await save(ctx, text); close() } catch (e) { setError(String(e)) } finally { saving.current = false; setBusy(false) } }
  return <div className="selection-note-dialog" data-content-selection-ui><h3>{uiText("添加批注")}</h3><blockquote>{ctx.selection.text}</blockquote>
    <textarea autoFocus aria-label={uiText("摘录批注")} placeholder={uiText("写点什么，#标签")} value={text} onChange={e => setText(e.target.value)} disabled={busy} />
    {error && <p role="alert">{error}</p>}<div><button className="small" onClick={close} disabled={busy}>{uiText("取消")}</button><button className="small primary" onClick={() => void submit()} disabled={busy}>{uiText("保存批注")}</button></div></div>
}
export const selectionActions: SelectionAction[] = [
  { id: 'annotate.mark', get title() { return uiText("标记摘录") }, order: 10, run: ctx => save(ctx, '') },
  { id: 'annotate.note', get title() { return uiText("添加批注") }, order: 20, run: ctx => ctx.host.showDialog(close => <NoteDialog ctx={ctx} close={close} />) }
]
export function ContentMarks(p: SelectionSurfaceProps) {
  const ids = useLocals(p.host, p.source.id)
  return <>{ids.map(id => <ContentMark key={id} {...p} id={id} />)}</>
}
function ContentMark(p: SelectionSurfaceProps & { id: string }) {
  useUiLocale()
  const view = useEntity(p.id), ref = view && contentReference(view), last = useRef<string | undefined>(undefined)
  const position = ref ? p.locate(ref) : undefined
  const key = `${p.revealKey}:${p.source.id}`
  useEffect(() => {
    if (ref && p.revealId === p.id && last.current !== key) { last.current = key; p.reveal(ref) }
  }, [ref, p.revealId, p.id, key, p.reveal])
  useEffect(() => {
    if (!position || position.status !== 'found') return
    const click = (e: MouseEvent) => {
      if ((e.target as Element)?.closest('[data-content-selection-ui],a') || !window.getSelection()?.isCollapsed) return
      if (position.rects.some(r => e.clientX >= r.left && e.clientX <= r.left + r.width && e.clientY >= r.top && e.clientY <= r.top + r.height)) p.select(p.id)
    }; p.root.addEventListener('click', click); return () => p.root.removeEventListener('click', click)
  }, [position, p.root, p.select, p.id])
  if (!view || !ref || !position) return null
  const chosen = p.selected === p.id, rect = position.rects.at(-1)
  return <>
    {position.rects.map((r, i) => <div key={i} data-content-mark={p.id} className={`content-quote-mark${chosen ? ' selected' : ''}${view.blocks.note ? ' noted' : ''}`} style={r} />)}
    {chosen && rect && <div className="content-quote-chip" style={{ left: Math.max(8, Math.min(rect.left, innerWidth - 300)), top: rect.top + rect.height + 5 }}>
      <span>{labelOf(view, 40) || uiText("已标记摘录")}</span><button onClick={() => p.select(undefined)}>{uiText("收起")}</button><button onClick={() => { p.host.trash([p.id]); p.select(undefined) }}>{uiText("删除")}</button></div>}
    {chosen && ['missing', 'unsupported'].includes(position.status) && <div className="content-quote-chip missing" style={{ left: p.root.getBoundingClientRect().left + 12, top: p.root.getBoundingClientRect().top + 12 }}>{uiText("原文位置已失效或暂不支持，摘录和批注仍保留。")}</div>}
  </>
}
