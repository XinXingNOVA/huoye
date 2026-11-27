import { useId, useRef, useState } from 'react'
import { Overlay } from '../../../plugin-api/ui/widgets'
import { uiText, useUiLocale } from '../../../shared/i18n/interface-display'
import { canCleanVersion, type PackageInventory } from '../../../shared/package-catalog'
import type { PackageRow } from '../../../shared/external-plugins'
import { packageText } from '../../../shared/package-locales'
import { useModalFocus } from './modal-focus'

export function PackageCleanup({ candidates, rows, inventory, onClose, onRefresh }: {
  candidates: PackageRow[]; rows: PackageRow[]; inventory: PackageInventory; onClose(): void; onRefresh(): Promise<void>
}) {
  const locale = useUiLocale()
  const [chosen, setChosen] = useState(new Set(candidates.map(r => r.hash)))
  const [outcome, setOutcome] = useState<Awaited<ReturnType<typeof window.bridge.packages.cleanup>>>()
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const lock = useRef(false), root = useRef<HTMLDivElement>(null), title = useId()
  useModalFocus(root)
  const eligible = candidates.filter(r => canCleanVersion(inventory, r.hash))
  const hashes = eligible.map(r => r.hash).filter(h => chosen.has(h))
  const archiveKiB = Math.ceil(hashes.reduce((total, h) => total + (inventory.versions[h]?.bytes ?? 0), 0) / 1024)
  const protectedRows = rows.filter(r => inventory.versions[r.hash]?.newer && !canCleanVersion(inventory, r.hash))
  const name = (r: PackageRow) => packageText(r.manifest.locales, locale, r.manifest.title) + ' ' + r.manifest.version
  const close = () => { if (!lock.current) onClose() }
  async function confirm() {
    if (lock.current || !hashes.length) return
    lock.current = true; setBusy(true); setError('')
    try { setOutcome(await window.bridge.packages.cleanup(hashes)); await onRefresh() }
    catch (e) { setError(String(e)) }
    finally { lock.current = false; setBusy(false) }
  }
  return <Overlay onClose={close}><div className="package-dialog" role="dialog" aria-modal="true" aria-labelledby={title} ref={root} tabIndex={-1}>
    <h2 id={title}>{uiText("清理闲置旧版")}</h2>
    {outcome ? <div role="status">{uiText("已清理 {n} 个版本", { n: outcome.removed.length })}{outcome.skipped.map(s => <p key={s.hash}>{candidates.find(r => r.hash === s.hash)?.manifest.title} · {s.reason}</p>)}</div> :
      <><p className="muted">{uiText("所选安装包文件合计约 {n} KiB", { n: archiveKiB })}</p>{eligible.map(r => <label className="package-clean-row" key={r.hash}><input type="checkbox" checked={chosen.has(r.hash)} disabled={busy} onChange={e => {
        const next = new Set(chosen); if (e.target.checked) next.add(r.hash); else next.delete(r.hash); setChosen(next)
      }} />{name(r)} → {inventory.versions[r.hash].newer}</label>)}
      {!!protectedRows.length && <details><summary>{uiText("受保护的旧版")} · {protectedRows.length}</summary>{protectedRows.map(r => {
        const u = inventory.versions[r.hash]
        return <p key={r.hash}>{name(r)} · {[...u.libraries.map(l => l.name), ...u.tasks.map(() => uiText("未完成任务")), ...(u.bundledDefault ? [uiText("建库默认版本")] : []), ...(inventory.unchecked.length ? [uiText("部分仓库未能核对")] : [])].join('、')}</p>
      })}</details>}</>}
    {error && <p role="alert">{error}</p>}
    <div className="package-dialog-actions"><button className="small" disabled={busy} onClick={close}>{outcome ? uiText("完成") : uiText("取消")}</button>
      {!outcome && <button className="small danger" disabled={busy || !hashes.length} onClick={() => void confirm()}>{uiText("确认清理 {n} 个版本", { n: hashes.length })}</button>}</div>
  </div></Overlay>
}
