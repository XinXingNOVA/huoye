import { useState } from 'react'
import { useDevelopmentPlugins } from '../development-plugins'
import { DevelopmentDirectory } from './DevelopmentDirectory'

export function DevelopmentNotice({ onOpen }: { onOpen(): void }) {
  const { directory, blocked } = useDevelopmentPlugins()
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const failed = !!directory.problem || directory.rows.some(r => r.problem || r.build?.state === 'error' || r.reason)
  const applied = directory.rows.filter(r => r.appliedHash)
  const changed = applied.some(r => r.availableHash && r.availableHash !== r.appliedHash)
  const ready = !directory.problem && applied.every(r => r.availableHash && !r.problem && r.build?.state === 'ready')
  return failed || changed || error ? <div className="development-notices">
    <button className="development-notice" onClick={onOpen} title={error || undefined}>{error || failed ? '开发插件需要处理' : '插件有新构建'}</button>
    {changed && <button className="development-notice" disabled={blocked || busy || !ready} title={blocked ? '请先处理设置页的未应用更改' : '重载当前仓库，中断播放并重置会话撤销'} onClick={async () => {
      setBusy(true); setError('')
      try { await window.bridge.packages.applyDevelopmentDirectory(applied.map(r => ({ source: r.source, hash: r.availableHash! }))); await window.bridge.vaults.reload() }
      catch (e) { setError(String(e)); setBusy(false) }
    }}>{busy ? '正在应用…' : '应用并重载'}</button>}
  </div> : null
}

export function DevelopmentPlugins({ disabled, dirty, onActivity, onDraftChange }: { disabled: boolean; dirty: boolean; onActivity(busy: boolean): void; onDraftChange(dirty: boolean): void }) {
  return <section className="development-plugins" aria-label="插件开发">
    <DevelopmentDirectory disabled={disabled} dirty={dirty} onActivity={onActivity} onDraftChange={onDraftChange} />
  </section>
}
