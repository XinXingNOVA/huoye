import { uiText, useUiLocale } from '../../../shared/i18n/interface-display'
import { useEffect, useId, useRef, useState } from 'react'
import type { PackageUpdateJob, PackageUpdatePreview } from '../../../shared/plugin-updates'
import { Overlay } from '../../../plugin-api/ui/widgets'
import { useModalFocus } from './modal-focus'

export function PluginUpdater({ hash, target, onClose, onRefresh, onState }: {
  hash?: string; target?: string; onClose(): void; onRefresh(): Promise<void>
  onState(busy: boolean, guard: boolean): void
}) {
  useUiLocale()
  const [preview, setPreview] = useState<PackageUpdatePreview>()
  const [job, setJob] = useState<PackageUpdateJob>()
  const [ending, setEnding] = useState(false)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const submitted = useRef<string | undefined>(undefined)
  const running = useRef(false), root = useRef<HTMLDivElement>(null), title = useId()
  useModalFocus(root, !!preview)
  const previewToken = preview?.token
  useEffect(() => () => { if (previewToken && submitted.current !== previewToken) void window.bridge.packages.cancelUpdate(previewToken).catch(() => {}) }, [previewToken])
  useEffect(() => {
    let active = true
    const load = () => { void window.bridge.packages.pendingUpdate().then(j => { if (active) setJob(j ?? undefined) }, e => { if (active) setError(String(e)) }) }
    load(); const off = window.bridge.packages.onChanged(load)
    return () => { active = false; off() }
  }, [])
  useEffect(() => {
    if (!hash) return
    let active = true
    setBusy(true); setError(''); onState(true, true)
    void window.bridge.packages.pickUpdate(hash, target).then(p => {
      if (!active) return
      setPreview(p ?? undefined); onState(false, !!p)
      if (!p) onClose()
    }, e => { if (active) { setError(String(e)); onState(false, false); onClose() } })
      .finally(() => { if (active) setBusy(false) })
    return () => { active = false }
  }, [hash, target, onClose, onState])
  useEffect(() => () => onState(false, false), [onState])
  const close = () => { if (!busy) { setPreview(undefined); onState(false, false); onClose() } }
  const apply = async (token: string, start: boolean) => {
    if (running.current) return
    if (start) submitted.current = token
    running.current = true; setBusy(true); setEnding(false); setError(''); setPreview(undefined)
    // 已确认的任务由主进程持久保存，允许它通过页面收尾并重载本窗口。
    onState(true, false)
    try {
      const result = await (start ? window.bridge.packages.startUpdate(token) : window.bridge.packages.resumeUpdate(token))
      setJob(result); await onRefresh()
    } catch (e) {
      setError(String(e))
      try { setJob(await window.bridge.packages.pendingUpdate() ?? undefined) } catch { /* 保留首次错误，重开设置后再次读取持久任务。 */ }
    } finally { running.current = false; setBusy(false); onState(false, false); onClose() }
  }
  const dismiss = async () => {
    if (!job || busy) return
    try { await window.bridge.packages.cancelUpdate(job.token); setJob(undefined); setEnding(false) } catch (e) { setError(String(e)) }
  }
  return <>
    {error && <p className="package-error" role="alert">{error}</p>}
    {busy && !preview && <p role="status">{uiText("正在检查并更新插件，关联仓库可能重新加载…")}</p>}
    {job && <div className="ui-card" data-plugin-update-phase={job.phase}>
      <strong>{job.next.manifest.title} · {job.previous.manifest.version} → {job.next.manifest.version}</strong>
      <p>{job.phase === 'complete' ? uiText("更新完成，旧包已删除，各仓库启停选择保持。") : uiText("更新尚未完成。继续更新会核对已完成的步骤，并完成旧包清理。")}</p>
      {job.error && <p className="package-error" role="alert">{job.error}</p>}
      {job.phase !== 'complete' && <button className="small primary" disabled={busy} onClick={() => void apply(job.token, false)}>{uiText("继续更新")}</button>}
      {job.phase === 'switching' && !ending && <button className="small" disabled={busy} onClick={() => setEnding(true)}>{uiText("结束更新并保留两版…")}</button>}
      {ending && <div role="alert"><p>{uiText("已更新的仓库保持新版，尚未更新的保持旧版，两份包都保留。之后可添加修正版或自行调整各库选择；这不会撤销新版已经产生的数据变化。")}</p><button className="small" disabled={busy} onClick={() => setEnding(false)}>{uiText("继续保留任务")}</button><button className="small danger" disabled={busy} onClick={() => void dismiss()}>{uiText("确认结束本次更新")}</button></div>}
      {(job.phase === 'prepared' || job.phase === 'complete') && <button className="small" disabled={busy} onClick={() => void dismiss()}>{job.phase === 'complete' ? uiText("知道了") : uiText("取消更新")}</button>}
    </div>}
    {preview && <Overlay onClose={close}><div className="package-dialog" role="dialog" aria-modal="true" aria-labelledby={title} ref={root} tabIndex={-1}>
      <h2 id={title}>{uiText("更新")}{' '}{preview.previous.manifest.title}</h2>
      <p>{preview.previous.manifest.version} → {preview.next.manifest.version}{' '}{uiText("· 作者声明：")}{preview.next.manifest.author}</p>
      <p>{uiText("替换此旧版本在本机已登记仓库中的绑定，保留各仓库启停状态、数据和设置。成功后删除旧包。需要保留多个版本，请取消并使用“添加插件”。")}</p>
      <p className="muted">{uiText("已打开的关联仓库会保存页面并重新加载；未打开的仓库只更新版本绑定。不会扫描磁盘上未登记的仓库副本。")}</p>
      {preview.libraries.length ? <ul>{preview.libraries.map(l => <li key={l.root}>{l.name} · {l.binding.enabled ? uiText("保持启用") : uiText("保持停用")}<div className="muted">{l.root}</div></li>)}</ul> : <p>{uiText("没有登记仓库绑定此版本。")}</p>}
      {!!preview.blockers.length && <div role="alert"><strong>{uiText("暂不能更新")}</strong><ul>{preview.blockers.map((b,i) => <li key={i}>{b}</li>)}</ul></div>}
      <div className="package-dialog-actions"><button className="small" disabled={busy} onClick={close}>{uiText("取消")}</button><button className="small primary" data-action="update-package" disabled={busy || !!preview.blockers.length} onClick={() => void apply(preview.token, true)}>{uiText("更新并重载关联仓库")}</button></div>
    </div></Overlay>}
  </>
}
