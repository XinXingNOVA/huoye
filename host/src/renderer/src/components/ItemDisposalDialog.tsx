import { uiText, useUiLocale } from '../../../shared/i18n/interface-display'
import { useUiDocument } from '../../../plugin-api/ui/widgets'
import { useEffect, useRef, useState } from 'react'
import type { ItemDisposalPreview, ItemDisposalSelection, ItemDisposalTask } from '../../../shared/item-disposal'
import { formatBytes } from '../../../shared/format'

/** 一个确认入口；跨层顺序和接续均由应用流程负责，界面不拼接两层写接口。 */
export function ItemDisposalDialog({ ids, onClose }: { ids?: string[]; onClose(): void }) {
  useUiLocale()
  const document = useUiDocument()
  const [selection, setSelection] = useState<ItemDisposalSelection | undefined>(() => ids ? { ids } : undefined)
  const [preview, setPreview] = useState<ItemDisposalPreview>(), [result, setResult] = useState<ItemDisposalTask>()
  const [tasks, setTasks] = useState<ItemDisposalTask[]>([]), [revision, setRevision] = useState(0)
  const [loading, setLoading] = useState(true), [running, setRunning] = useState(false), [error, setError] = useState('')
  const requestId = useRef(''), lock = useRef(false), dialog = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    dialog.current?.focus({ preventScroll: true })
    return () => { if (previous?.isConnected) previous.focus({ preventScroll: true }) }
  }, [document])
  useEffect(() => {
    let alive = true
    setLoading(true); setPreview(undefined); setResult(undefined); setError(''); requestId.current = crypto.randomUUID()
    const read = async () => {
      if (selection) { const p = await window.bridge.itemDisposal.preview(selection); if (alive) setPreview(p) }
      else { const rows = await window.bridge.itemDisposal.list(); if (alive) setTasks(rows) }
    }
    void read().catch(e => { if (alive) setError(String(e)) }).finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [selection, revision])
  const close = () => { if (!lock.current) onClose() }
  const records = () => { setSelection(undefined); setRevision(v => v + 1) }
  const execute = async () => {
    if (lock.current || !preview || !selection) return
    lock.current = true; setRunning(true); setError('')
    try {
      const value = await window.bridge.itemDisposal.execute({ selection, previewToken: preview.previewToken, requestId: requestId.current })
      setResult(value); setPreview(undefined); dialog.current?.focus({ preventScroll: true })
    } catch (e) { setError(String(e)); setPreview(undefined) }
    finally { lock.current = false; setRunning(false) }
  }
  return <div className="qa-backdrop item-disposal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) close() }}>
    <div className="quick-attach item-disposal-dialog" role="dialog" aria-modal="true" aria-label={selection ? uiText("连同原件移到系统废纸篓") : uiText("组合删除记录")} ref={dialog} tabIndex={-1}
      onKeyDown={e => {
        e.stopPropagation()
        if (e.key === 'Escape') { e.preventDefault(); close() }
        if (e.key !== 'Tab') return
        const buttons = [...(dialog.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
        if (!buttons.length) { e.preventDefault(); return }
        if (!buttons.includes(document.activeElement as HTMLButtonElement) || (!e.shiftKey && document.activeElement === buttons.at(-1))) { e.preventDefault(); buttons[0].focus() }
        else if (e.shiftKey && document.activeElement === buttons[0]) { e.preventDefault(); buttons.at(-1)?.focus() }
      }}>
      <h2>{selection ? uiText("连同原件移到系统废纸篓") : uiText("组合删除记录")}</h2>
      <div className="item-disposal-body">
      {loading && <p role="status">{uiText("正在核对处理范围…")}</p>}
      {preview && <>
        <div className="item-disposal-scope">
          <section><h3>{uiText("文件空间 · 原件")}</h3><p>{preview.spaces.reduce((n, s) => n + s.files.length, 0)}{' '}{uiText("个原件待处置")}{preview.completed ? uiText("，{completed} 个已完成", { completed: String(preview.completed) }) : ''}{uiText("（含全部已发布版本）。")}</p></section>
          <section><h3>{uiText("当前仓库 · 素材记录")}</h3><p>{uiText("所选")}{' '}{preview.selected}{' '}{uiText("项，共涉及")}{' '}{preview.affected}{' '}{uiText("项（含附属内容）；原件全部处置完成后移入仓库回收站，保留标签与笔记。")}</p></section>
        </div>
        <p className="item-disposal-warning">{uiText("原件及历史版本移入系统废纸篓（Windows 为回收站）后，所有引用它的仓库将无法读取。撤销素材回收不会还原原件；需先从系统废纸篓还原完整文件包，再到空间“记录管理”核验。")}</p>
        {preview.spaces.map(space => <section className="item-disposal-space" key={space.id}>
          <h3>{space.name}<span className="muted"> · {space.mode === 'shared' ? uiText("共享") : uiText("独享")}</span></h3>
          <p className="muted">{uiText("关联")}{' '}{space.members}{' '}{uiText("个仓库 · 本库另有")}{' '}{space.otherReferences}{' '}{uiText("项未选中素材引用这些原件；其他仓库的引用未检查。")}</p>
          {space.files.length > 0 ? <ul>{space.files.map(f => <li key={f.id}><strong>{f.name}</strong><span>{f.versions}{' '}{uiText("个版本 ·")}{' '}{formatBytes(f.bytes)}</span></li>)}</ul> : <p className="muted">{uiText("此空间的原件步骤已完成。")}</p>}
        </section>)}
        {preview.blocked.length > 0 && <ul className="package-error" role="alert">{preview.blocked.map((text, i) => <li key={i}>{text}</li>)}</ul>}
      </>}
      {result && <TaskResult task={result} />}
      {!selection && !loading && <>
        {tasks.length === 0 && !error && <p className="muted">{uiText("暂无组合删除记录。")}</p>}
        {tasks.map(task => <section className="item-disposal-task" key={task.id}>
          <p><strong>{task.state === 'complete' ? uiText("已完成") : task.running ? uiText("处理中") : uiText("待处理")} · {task.selected}{' '}{uiText("项素材")}</strong><span className="muted">{new Date(task.updatedAt).toLocaleString()}</span></p>
          <TaskResult task={task} />
          {task.state !== 'complete' && <button className="small" disabled={task.running} onClick={() => setSelection({ taskId: task.id })}>{uiText("预览剩余操作…")}</button>}
        </section>)}
      </>}
      {error && <p className="package-error" role="alert">{error}</p>}
      </div>
      <footer>
        <button className="small" disabled={running} onClick={close}>{result ? uiText("关闭") : uiText("取消")}</button>
        {!selection && <button className="small" disabled={loading} onClick={() => setRevision(v => v + 1)}>{uiText("刷新记录")}</button>}
        {selection && <button className="small" disabled={running} onClick={records}>{uiText("查看处理记录")}</button>}
        {selection && !result && !loading && <button className="small" disabled={running} onClick={() => setRevision(v => v + 1)}>{uiText("重新预览")}</button>}
        {result?.state === 'pending' && <button className="primary" onClick={() => setSelection({ taskId: result.id })}>{uiText("预览剩余操作…")}</button>}
        {preview && <button className="small danger-fill" disabled={running || preview.blocked.length > 0} onClick={() => void execute()}>{running ? uiText("正在处理…") : uiText("确认处置并回收素材")}</button>}
      </footer>
    </div>
  </div>
}
function TaskResult({ task }: { task: ItemDisposalTask }) {
  useUiLocale()
  return <div className="item-disposal-result" role="status">
    <p>{uiText("原件：")}{task.completed} / {task.originals}{' '}{uiText("个完成。仓库素材：")}{task.library === 'done' ? uiText("已移入回收站") : uiText("尚未确认完成")}。</p>
    {task.state === 'complete' && <p className="muted">{uiText("这是处理结果记录，后续撤销或恢复不会改写它。")}</p>}
    {task.message && <p className="package-error">{task.message}</p>}
    {task.files.filter(f => f.outcome === 'failed').map(f => <p className="package-error" key={f.spaceId + f.id}>{f.name}：{f.message}</p>)}
  </div>
}
