import { useEffect, useState } from 'react'
import type { TakeoutPreview, TakeoutResult } from '../../../shared/rpc'
import type { UiHost } from '../plugin'
import { formatBytes } from '../widgets'

export function TakeoutDialog({ ids, name: initial, host, onClose }: { ids: string[]; name: string; host: UiHost; onClose(): void }) {
  const [preview, setPreview] = useState<TakeoutPreview>()
  const [name, setName] = useState(initial)
  const [parent, setParent] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<TakeoutResult>()
  const [error, setError] = useState<string>()
  useEffect(() => {
    let alive = true
    void Promise.all([host.core.takeoutPreview(ids), window.bridge.downloadsPath()]).then(([p, dir]) => {
      if (alive) { setPreview(p); setParent(dir) }
    }).catch(e => { if (alive) setError(e instanceof Error ? e.message : String(e)) })
    return () => { alive = false }
  }, [host, ids])
  const run = async () => {
    if (!parent || !name.trim() || busy) return
    setBusy(true); setError(undefined)
    try { setResult(await host.core.takeoutRun({ ids, parent, name: name.trim() })) }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }
  const close = () => { if (!busy) onClose() }
  return <div className="qa-backdrop" onMouseDown={e => e.target === e.currentTarget && close()}>
    <div className="quick-attach export-dialog takeout-dialog" role="dialog" aria-modal="true" aria-label="取回数据"
      onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); close() } }}>
      <div className="export-title">{result ? `已取回 ${result.items} 条记录、${result.files} 个原文件` : `取回 ${ids.length} 项数据`}</div>
      {result ? <>
        <p className="data-value muted">{result.dir}</p>
        {result.problems.length > 0 && <div className="export-failed" role="alert"><p>以下内容需要检查：</p><ul>{result.problems.map((p, i) => <li key={i}>{p}</li>)}</ul></div>}
        <div className="export-actions"><button className="small" onClick={() => host.reveal(`${result.dir}/records.json`)}>在访达中显示</button><button className="small primary" onClick={onClose} autoFocus>完成</button></div>
      </> : <>
        {preview ? <ul className="export-summary">
          <li>{preview.items} 条选中记录{preview.related ? `，连同 ${preview.related} 条依附记录及模板` : ''}</li>
          <li>{preview.files} 个原文件{preview.bytes ? `，${formatBytes(preview.bytes)}` : ''}</li>
          <li>保留完整字段、定义和引用关系；数据块按原样保存。</li>
          {preview.externalReferences > 0 && <li>另有 {preview.externalReferences} 个关联对象只保留引用，不复制其内容。</li>}
        </ul> : <p className="muted">正在检查记录和文件…</p>}
        {!!preview?.problems.length && <div className="export-failed"><p>这些内容无法完整取回：</p><ul>{preview.problems.map((p, i) => <li key={i}>{p}</li>)}</ul></div>}
        <label className="export-row"><span className="muted">名称</span><input className="field-text" autoFocus value={name} disabled={busy} onChange={e => setName(e.target.value)} /></label>
        <div className="export-row"><span className="muted">位置</span><span className="export-parent" title={parent}>{parent ?? '…'}</span>
          <button className="small" disabled={busy} onClick={() => void window.bridge.pickExportFolder(parent).then(p => { if (p) setParent(p) }).catch(e => setError(String(e)))}>选择…</button></div>
        <p className="export-hint muted">新建文件夹保存原文件和 JSON 记录，同名文件夹不会覆盖。此包供独立读取和处理，不含操作历史与仓库设置，不能直接作为仓库打开。</p>
        {error && <div className="export-failed" role="alert">{error}</div>}
        <div className="export-actions"><button className="small" disabled={busy} onClick={close}>取消</button><button className="small primary" disabled={busy || !preview || !parent || !name.trim()} onClick={() => void run()}>{busy ? '正在取回…' : '取回'}</button></div>
      </>}
    </div>
  </div>
}
