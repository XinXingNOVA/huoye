import { uiText, useUiLocale } from '../../../shared/i18n/interface-display'
import { useEffect, useRef, useState } from 'react'
import type { SpaceInfo } from '../../../shared/file-spaces'
import type { DiskApplyInput, DiskChange, DiskPage, DiskPreview, DiskProgress } from '../../../shared/space-disk'
import { SectionHeader } from './ui-primitives'

const states = { get modified() { return uiText("内容改变") }, get missing() { return uiText("文件缺失") }, get unreadable() { return uiText("无法读取") }, get unstable() { return uiText("仍在写入") }, get unchanged() { return uiText("内容相同") } }
export function SpaceDiskCheck({ space, refresh }: { space: SpaceInfo; refresh(): Promise<void> }) {
  useUiLocale()
  const [page, setPage] = useState<DiskPage>(), [offset, setOffset] = useState(0), [revision, setRevision] = useState(0)
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [progress, setProgress] = useState<DiskProgress>()
  const [confirmation, setConfirmation] = useState<{ preview: DiskPreview; input: DiskApplyInput }>()
  const active = useRef<string | undefined>(undefined), locked = useRef(false)
  const confirmationRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let alive = true
    setPage(undefined)
    void window.bridge.spaces.disk.page(space.root, { spaceId: space.id, offset }).then(value => { if (alive) setPage(value) }, e => { if (alive) setError(String(e)) })
    return () => { alive = false }
  }, [space.root, space.id, offset, revision])
  useEffect(() => {
    const off = window.bridge.spaces.disk.onProgress(p => { if (p.requestId === active.current) setProgress(p) })
    return () => { off(); if (active.current) void window.bridge.spaces.disk.cancel(active.current) }
  }, [])
  useEffect(() => { if (confirmation) confirmationRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }) }, [confirmation])
  const reload = () => { setOffset(0); setRevision(v => v + 1) }
  const run = async (fn: () => Promise<void>, requestId: string = crypto.randomUUID()) => {
    if (locked.current) return
    locked.current = true; active.current = requestId; setBusy(true); setError(''); setNotice(''); setProgress(undefined)
    try { await fn() } catch (e) { setError(String(e)) }
    finally { locked.current = false; active.current = undefined; setBusy(false) }
  }
  const check = (deep: boolean) => {
    const requestId = crypto.randomUUID()
    void run(async () => {
      setConfirmation(undefined)
      const result = await window.bridge.spaces.disk.check(space.root, { spaceId: space.id, requestId, deep })
      reload(); await refresh(); setNotice(uiText("{value1}：已检查 {checked} / {total} 个登记版本。", { value1: String(result.cancelled ? uiText("已停止") : uiText("检查完成")), checked: String(result.checked), total: String(result.total) }))
    }, requestId)
  }
  const preview = async (row: DiskChange, locate: boolean) => {
    let source: string | undefined
    if (locate) {
      const picked = await window.bridge.pickImport()
      if (!picked.length) return
      if (picked.length !== 1) throw new Error(uiText("重新定位时请选择一个文件"))
      source = picked[0]
    }
    const input = { spaceId: space.id, versionId: row.versionId, ...(source ? { source } : {}) }
    const result = await window.bridge.spaces.disk.preview(space.root, input)
    setConfirmation({ preview: result, input: { ...input, token: result.token, requestId: crypto.randomUUID() } })
  }
  return <section className="space-disk-check" aria-label={uiText("磁盘检查")}>
    <SectionHeader
      title={uiText("检查登记文件的磁盘变化")}
      subtitle={uiText("快速检查核对文件元信息，完整检查重新读取字节以校验内容完整性")}
      actions={
        <div className="space-actions">
          <button className="small primary" disabled={busy} onClick={() => check(false)}>{uiText("快速检查")}</button>
          <button className="small" disabled={busy} onClick={() => check(true)}>{uiText("完整检查")}</button>
          <button className="small" disabled={busy} onClick={reload}>{uiText("刷新变化清单")}</button>
          {busy && active.current && <button className="small" onClick={() => void window.bridge.spaces.disk.cancel(active.current!).catch(e => setError(String(e)))}>{uiText("停止处理")}</button>}
          {busy && <span role="status">{progress ? uiText("正在检查 {checked} / {total}", { checked: String(progress.checked), total: String(progress.total) }) : uiText("正在核对内容…")}</span>}
        </div>
      }
    />
    {error && <p className="package-error" role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {page?.pending.map(job => <div className="space-confirm" key={job.requestId}>
      <p>{uiText("未完成的处理：")}{job.name}。</p>
      <div className="space-actions"><button className="small" disabled={busy} onClick={() => void run(async () => {
        const result = await window.bridge.spaces.disk.resume(space.root, space.id, job.requestId); setConfirmation(undefined); reload(); await refresh(); setNotice(result.action === 'abandoned' ? uiText("该任务已放弃，没有执行新的登记。") : uiText("处理已完成。"))
      }, job.requestId)}>{uiText("继续处理")}</button><button className="small" disabled={busy} onClick={() => void run(async () => {
        await window.bridge.spaces.disk.abandon(space.root, space.id, job.requestId); setConfirmation(undefined); reload()
      }, job.requestId)}>{uiText("放弃未登记任务")}</button></div>
    </div>)}
    {!page && !error && <p className="muted">{uiText("读取变化清单…")}</p>}
    {page && <>
      <p className="muted">{page.total ? uiText("{total} 个版本存在变化或历史失配", { total: String(page.total) }) : uiText("暂无已发现的差异；可点击检查核对当前磁盘。")}</p>
      <div className="ui-setting-group-card">
        <ol className="space-disk-list">{page.items.map(row => <li key={row.versionId} className="ui-setting-row">
          <div className="ui-setting-info">
            <div><strong>{row.name}</strong><span className="space-badge">V{row.ordinal} · {row.current ? uiText("当前版") : uiText("历史版")} · {states[row.state]}</span></div>
            <details className="space-disk-location"><summary>{uiText("存储位置")}</summary><p className="space-path">{row.path}</p></details>
            {row.replacement && <p className="muted">{uiText("已登记新的有效内容；此历史版本原有字节仍未恢复。")}</p>}
            {row.error && <p className="muted">{row.state === 'missing' ? uiText("登记位置未找到文件，可选择移动后的位置。") : row.error}</p>}
          </div>
          <div className="ui-setting-control space-actions">
            <button className="small" disabled={busy || page.pending.some(p => p.versionId === row.versionId)} onClick={() => void run(() => preview(row, true), row.versionId)}>{uiText("重新定位…")}</button>
            {row.current && row.state === 'modified' && !row.replacement && <button className="small primary" disabled={busy || page.pending.some(p => p.versionId === row.versionId)} onClick={() => void run(() => preview(row, false), row.versionId)}>{uiText("确认修改…")}</button>}
          </div>
        </li>)}</ol>
      </div>
      <div className="space-actions" style={{ marginTop: 12 }}><button className="small" disabled={busy || offset === 0} onClick={() => setOffset(v => Math.max(0, v - 50))}>{uiText("上一页")}</button><button className="small" disabled={busy || page.nextOffset === undefined} onClick={() => setOffset(page.nextOffset!)}>{uiText("下一页")}</button></div>
    </>}
    {confirmation && <div ref={confirmationRef} className="space-confirm" role="group" aria-label={uiText("确认磁盘变化处理")}>
      <h3>{confirmation.preview.action === 'repair' ? uiText("修复存储位置") : uiText("确认外部修改")}：{confirmation.preview.name}</h3>
      <details className="space-disk-location"><summary>{uiText("来源位置")}</summary><p className="space-path">{confirmation.preview.source}</p></details>
      <p>{confirmation.preview.action === 'repair'
        ? uiText("所选文件内容与登记版本一致，将复制到空间并恢复原版本引用可读。")
        : uiText("将当前磁盘内容保存为新版本，原版本登记与失配记录保留；已丢失的旧字节无法恢复。")}</p>
      <p className="muted">{uiText("此空间关联")}{' '}{confirmation.preview.members}{' '}{uiText("个仓库 · 待确认内容：")}{(confirmation.preview.size / 1024).toFixed(1)} KB</p>
      <p className="muted">{confirmation.preview.action === 'accept'
        ? uiText("各仓库按原规则自动接纳或等待确认，标签与笔记保留。")
        : uiText("所有引用该版本的仓库恢复读取；来源文件保留。")}</p>
      {confirmation.preview.blocked && <p className="package-error">{confirmation.preview.blocked}</p>}
      <div className="space-actions"><button className="small" disabled={busy} onClick={() => setConfirmation(undefined)}>{uiText("暂不处理")}</button><button className="primary" disabled={busy || !!confirmation.preview.blocked} onClick={() => void run(async () => {
        try {
          const result = await window.bridge.spaces.disk.apply(space.root, confirmation.input)
          setConfirmation(undefined); await refresh(); setNotice(result.action === 'abandoned' ? uiText("该任务已放弃，没有执行新的登记。") : result.action === 'repair' ? uiText("位置已修复，原版本引用继续可用。") : uiText("外部修改已登记，可在文件列表预览并接纳新版。"))
        } finally { reload() }
      }, confirmation.input.requestId)}>{uiText("确认处理")}</button></div>
    </div>}
  </section>
}
