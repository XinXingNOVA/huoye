import { useEffect, useRef, useState } from 'react'
import type { PurgePreview, PurgeResult } from '../../../shared/rpc'
import type { UiHost } from '../plugin'
import { titleFor } from '../ui-registry'
import type { ItemLifecyclePreview } from '../../../shared/item-lifecycle'

/** 不删的、没删成的：带上标题给人看。 */
async function titled(host: UiHost, list: { id: string; reason: string }[]) {
  const views = await host.core.get(list.map((x) => x.id))
  const title = new Map(views.map((v) => [v.id, titleFor(v)]))
  return list.map((x) => ({ title: title.get(x.id) ?? x.id, reason: x.reason }))
}

export function PurgeDialog({ ids, host, onClose, onDone }: { ids: string[]; host: UiHost; onClose(): void; onDone(ids: string[]): void }) {
  const [plan, setPlan] = useState<ItemLifecyclePreview>()
  const preview: PurgePreview | undefined = plan?.purge
  const [revision, setRevision] = useState(0)
  const requestId = useRef(crypto.randomUUID())
  const [skipped, setSkipped] = useState<{ title: string; reason: string }[]>([])
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<PurgeResult>()
  const [failed, setFailed] = useState<{ title: string; reason: string }[]>([])
  const [error, setError] = useState<string>()
  const done = useRef<HTMLButtonElement>(null)
  // 删完：焦点到"完成"上（按下的按钮已经没了），回车、Esc 都能关
  useEffect(() => {
    if (result) done.current?.focus()
  }, [result])

  useEffect(() => {
    let alive = true
    setPlan(undefined); setError(undefined); requestId.current = crypto.randomUUID()
    void host.core.previewItemLifecycle({ action: 'purge', ids }).then(async p => {
      const rows = await titled(host, p.purge!.skipped)
      if (alive) { setPlan(p); setSkipped(rows) }
    }).catch(e => { if (alive) setError(String(e)) })
    return () => { alive = false }
  }, [host, ids, revision])

  const run = async () => {
    setRunning(true)
    try {
      const applied = await host.core.applyItemLifecycle({ action: 'purge', ids, previewToken: plan!.previewToken, requestId: requestId.current })
      const r = applied.purge!
      setFailed(await titled(host, r.failed))
      setResult(r)
      onDone(r.ids)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setRunning(false)
    }
  }

  const close = () => {
    if (!running) onClose()
  }

  const reasons = (list: { title: string; reason: string }[]) => (
    <ul>
      {list.map((f, i) => (
        <li key={i}>
          {f.title}：{f.reason}
        </li>
      ))}
    </ul>
  )

  return (
    <div className="qa-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="quick-attach export-dialog purge-dialog" onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), close())}>
        {result ? (
          <>
            <div className="export-title">已彻底删除 {result.purged} 项</div>
            <ul className="export-summary">
              {result.locals > 0 && <li>连同它们的 {result.locals} 条批注</li>}
              <li>原件保留在文件空间，仍可重新收录；已删除的标签、笔记和批注不会恢复。</li>
            </ul>
            {failed.length > 0 && (
              <div className="export-failed">
                <div>{failed.length} 项没有删：</div>
                {reasons(failed)}
              </div>
            )}
            <div className="export-actions">
              <button ref={done} className="small primary" onClick={onClose}>
                完成
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="export-title">{preview && preview.items === 0 ? '没有可以彻底删除的' : `彻底删除 ${preview?.items ?? ids.length} 项`}</div>
            {preview ? (
              <>
                {preview.items > 0 && (
                  <ul className="export-summary">
                    {preview.locals > 0 && <li>连同依附在它们上面的 {preview.locals} 条批注</li>}
                    <li>只清除本仓库的身份与数据块，文件空间中的原件全部保留{preview.retainedFiles ? `（涉及 ${preview.retainedFiles} 个原文件引用）` : ''}</li>
                    <li>别处提到它们的链接留着，显示为找不到</li>
                  </ul>
                )}
                {skipped.length > 0 && (
                  <div className="export-failed">
                    <div>{skipped.length} 项不删：</div>
                    {reasons(skipped)}
                  </div>
                )}
                {preview.items > 0 && <div className="purge-warning">仓库数据删除后不能撤销。此操作不回收原件，也不释放原件磁盘空间。原件需到“文件空间”单独管理。</div>}
              </>
            ) : (
              <ul className="export-summary">
                <li className="muted">正在看看会删掉什么…</li>
              </ul>
            )}
            {error && <div className="export-failed">{error}<button className="small" disabled={running} onClick={() => setRevision(v => v + 1)}>重新预览</button></div>}
            <div className="export-actions">
              <button className="small" autoFocus disabled={running} onClick={close}>
                {preview && preview.items === 0 ? '关闭' : '取消'}
              </button>
              {preview && preview.items > 0 && (
                <button className="small danger-fill" disabled={running} onClick={() => void run()}>
                  {running ? '正在删除…' : '彻底删除'}
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
