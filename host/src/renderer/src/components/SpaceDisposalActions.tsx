import { useUiDocument } from '../../../plugin-api/ui/widgets'
import { createPortal } from 'react-dom'
import { formatBytes } from '../../../shared/format'
import { useEffect, useRef, useState } from 'react'
import type { SpaceCandidate, SpaceInfo, SpaceReferences } from '../../../shared/file-spaces'
import type { DisposalAction, DisposalInput, DisposalPreview, DisposalResult, PendingDisposal } from '../../../shared/space-disposal'
import type { UiHost } from '../plugin'

const labels: Record<DisposalAction, string> = {
  trash: '移到系统废纸篓', verify: '核验还原的文件', archive: '归档记录', unarchive: '取消归档', clean: '清理版本明细'
}
const descriptions: Record<DisposalAction, string> = {
  trash: '将原件及全部历史版本移入系统废纸篓（Windows 为回收站），所有引用它的仓库停止读取，素材标签与笔记保留。',
  verify: '在系统废纸篓将完整文件包还原至原位置后核验全部版本，通过后恢复原身份读取；不恢复仓库回收状态或取消记录归档。',
  archive: '将记录从常规列表归档到“记录管理”，不改变文件内容与仓库素材。',
  unarchive: '取消记录归档，已移走的文件仍留在“记录管理”中。',
  clean: '清除已移走文件的版本明细与恢复清单并归档，保留文件名与仓库数据；此后不可沿原身份核验恢复，系统废纸篓中的文件包保留。'
}
export function SpaceDisposalActions({ space, choices, host, busy, blocked, revision, run, refresh, records, onPlanning }:
  { space: SpaceInfo; choices: SpaceCandidate[]; host?: UiHost; busy: boolean; blocked: boolean; revision: number;
    run(fn: () => Promise<void>): void; refresh(): Promise<void>; records(): void; onPlanning(value: boolean): void }) {
  const document = useUiDocument()
  const [plan, setPlan] = useState<{ input: DisposalInput; preview: DisposalPreview; references?: SpaceReferences }>()
  const [planError, setPlanError] = useState('')
  const [result, setResult] = useState<DisposalResult>()
  const [pending, setPending] = useState<PendingDisposal[]>([]), [pendingError, setPendingError] = useState('')
  const [tick, setTick] = useState(0)
  const confirm = useRef<HTMLDivElement>(null)
  const signature = JSON.stringify(choices.map(f => [f.id, f.revision]))
  useEffect(() => { setPlan(undefined); onPlanning(false) }, [space.id, signature, onPlanning])
  useEffect(() => {
    let alive = true
    void window.bridge.spaces.disposal.pending(space.root, space.id).then(rows => { if (alive) { setPending(rows); setPendingError('') } },
      e => { if (alive) setPendingError(String(e)) })
    return () => { alive = false }
  }, [space.id, space.root, space.revision, revision, tick])
  useEffect(() => {
    if (!plan) return
    const previous = document.activeElement as HTMLElement | null
    confirm.current?.querySelector('button')?.focus({ preventScroll: true })
    return () => { if (previous?.isConnected) previous.focus({ preventScroll: true }) }
  }, [!!plan, document])
  const preview = (action: DisposalAction) => run(async () => {
    const input = { spaceId: space.id, action, files: choices.map(f => ({ id: f.id, revision: f.revision })) }
    const [value, references] = await Promise.all([
      window.bridge.spaces.disposal.preview(space.root, input),
      host ? host.core.previewSpaceMutation({ spaceId: space.id, action: 'recycle', files: input.files }).then(r => r.references) : undefined
    ])
    setResult(undefined); setPlanError(''); setPlan({ input: { ...input, previewToken: value.previewToken, requestId: crypto.randomUUID() }, preview: value, references }); onPlanning(true)
  })
  const finish = async (value: DisposalResult) => {
    setResult(value); setPlan(undefined); onPlanning(false); setTick(v => v + 1); await refresh()
  }
  const disabled = busy || blocked || !choices.length || !!plan
  return <section className="space-disposal" aria-label="文件处置与记录管理">
    {pending.map(task => <div className="space-confirm" key={task.requestId}>
      <strong>未完成：{labels[task.action]}</strong>
      <p>已记录 {task.completed} / {task.total} 项结果。{task.running ? '任务仍在运行，可稍后刷新。' : '可以继续未完成的步骤；已完成项不会重复执行。'}</p>
      <button className="small" disabled={busy || task.running} onClick={() => run(async () => finish(await window.bridge.spaces.disposal.resume(space.root, space.id, task.requestId)))}>继续处理</button>
      <button className="small" disabled={busy} onClick={() => setTick(v => v + 1)}>刷新任务</button>
    </div>)}
    {pendingError && <p role="alert" className="package-error">处置任务读取失败：{pendingError}</p>}
    <div className="space-actions">
      {choices.some(f => !f.cleanedAt && f.lifecycle !== 'disposed') && <button className="small danger" disabled={disabled} onClick={() => preview('trash')}>移到系统废纸篓…</button>}
      {choices.some(f => !f.cleanedAt && (f.lifecycle === 'disposing' || f.lifecycle === 'disposed')) && <button className="small" disabled={disabled} onClick={() => preview('verify')}>核验还原的文件…</button>}
      {choices.length > 0 && <details><summary>记录操作</summary><div className="space-actions">
        <button className="small" disabled={disabled} onClick={() => preview('archive')}>归档记录…</button>
        <button className="small" disabled={disabled} onClick={() => preview('unarchive')}>取消归档…</button>
        <button className="small" disabled={disabled} onClick={() => preview('clean')}>清理版本明细…</button>
      </div></details>}
    </div>
    {plan && createPortal(<div className="qa-backdrop" onMouseDown={e => { if (!busy && e.target === e.currentTarget) { setPlan(undefined); onPlanning(false) } }}>
      <div className="quick-attach space-disposal-dialog" role="dialog" aria-modal="true" aria-label="确认文件处置" ref={confirm} tabIndex={-1}
        onKeyDown={e => {
          e.stopPropagation()
          if (e.key === 'Escape' && !busy) { setPlan(undefined); onPlanning(false) }
          if (e.key === 'Tab') {
            const buttons = [...(confirm.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
            if (!buttons.length) { e.preventDefault(); return }
            if (e.shiftKey && document.activeElement === buttons[0]) { e.preventDefault(); buttons.at(-1)?.focus() }
            else if (!e.shiftKey && document.activeElement === buttons.at(-1)) { e.preventDefault(); buttons[0].focus() }
          }
        }}>
      <h3>{labels[plan.input.action]} · {plan.preview.files.length} 个文件</h3>
      <p>{descriptions[plan.input.action]}</p>
      {(plan.input.action === 'trash' || plan.input.action === 'verify') && <p className="muted">
        共 {plan.preview.files.reduce((n, f) => n + f.versions, 0)} 个已发布版本，约 {formatBytes(plan.preview.files.reduce((n, f) => n + f.bytes, 0))} · 空间关联 {plan.preview.members} 个仓库。
      </p>}
      {plan.input.action === 'trash' && <p className="muted">{plan.references?.scope === 'current-library'
        ? `本库有 ${plan.references.active} 项活跃素材、${plan.references.trashed} 项回收站素材引用这些文件；其他仓库的引用未检查。`
        : '未检查各仓库的引用，不能据此判断文件无人使用。'}</p>}
      <ul>{plan.preview.files.map(f => <li key={f.id}><strong>{f.name}</strong>{f.reason && <p className="package-error">{f.reason}</p>}
        {f.recoveryPath && plan.input.action === 'verify' && <p className="space-path">还原位置：{f.recoveryPath}</p>}</li>)}</ul>
      <div className="space-actions">
        <button className="small" disabled={busy} onClick={() => { setPlan(undefined); onPlanning(false) }}>取消</button>
        <button className={'small ' + (plan.input.action === 'trash' || plan.input.action === 'clean' ? 'danger-fill' : 'primary')}
          disabled={busy || plan.preview.files.some(f => !!f.reason)}
          onClick={() => run(async () => { try { setPlanError(''); await finish(await window.bridge.spaces.disposal.execute(space.root, plan.input)) } catch (e) { setPlanError(String(e)) } })}>
          {busy ? '处理中…' : '确认' + labels[plan.input.action]}
        </button>
      </div>
      {planError && <p className="package-error" role="alert">{planError}。可取消后重新预览；未完成任务可在记录管理中继续。</p>}
    </div></div>, document.body)}
    {result && <div className="space-confirm" role="status">
      <h3>{labels[result.action]}：{result.items.filter(i => i.outcome === 'done').length} 项完成，{result.items.filter(i => i.outcome === 'failed').length} 项未完成</h3>
      <ul>{result.items.filter(i => i.outcome === 'failed').map(i => <li className="package-error" key={i.id}>{i.name}：{i.message}</li>)}</ul>
      <p className="muted">仓库素材和数据块保留。已完成的文件处置不会因为其他项失败而回退。</p>
      <div className="space-actions"><button className="small" disabled={busy} onClick={records}>查看记录管理</button><button className="small" onClick={() => setResult(undefined)}>关闭结果</button></div>
    </div>}
  </section>
}
