import { useEffect, useState } from 'react'
import { blockDevelopmentReload, refreshDevelopmentStatus, useDevelopmentPlugins } from '../development-plugins'
import { SectionHeader, SettingGroup, SettingRow } from './ui-primitives'

export function DevelopmentDirectory({ disabled, dirty, onActivity, onDraftChange }: { disabled: boolean; dirty: boolean; onActivity(busy: boolean): void; onDraftChange(dirty: boolean): void }) {
  const { directory, error: loadError } = useDevelopmentPlugins()
  const [draft, setDraft] = useState<string[] | null>(null)
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [query, setQuery] = useState('')
  const applied = directory.rows.filter(r => r.appliedHash).map(r => r.source)
  const selected = draft ?? applied
  const changed = applied.length !== selected.length || applied.some(s => !selected.includes(s))
  const rows = directory.rows.filter(r => selected.includes(r.source))
  const pending = changed || rows.some(r => r.availableHash && r.availableHash !== r.appliedHash)
  const invalid = rows.some(r => r.problem || r.build?.state !== 'ready' || !r.availableHash) || selected.some(s => !rows.some(r => r.source === s))
  const blocked = busy || disabled || dirty
  useEffect(() => () => { void window.bridge.packages.prepareDevelopmentSources([]).catch(() => {}) }, [])
  useEffect(() => { onActivity(busy); return () => onActivity(false) }, [busy, onActivity])
  useEffect(() => { onDraftChange(changed); return () => onDraftChange(false) }, [changed, onDraftChange])
  useEffect(() => { blockDevelopmentReload('directory', changed || busy); return () => blockDevelopmentReload('directory', false) }, [changed, busy])
  const act = async (fn: () => Promise<void>) => {
    setBusy(true); setError('')
    try { await fn(); await refreshDevelopmentStatus() } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }
  const toggle = (source: string) => {
    const next = selected.includes(source) ? selected.filter(s => s !== source) : [...selected, source]
    setDraft(next); void act(() => window.bridge.packages.prepareDevelopmentSources(next))
  }
  const folders = directory.directories ?? (directory.directory ? [directory.directory] : [])
  return (
    <div className="development-directory" data-development-directory>
      <SectionHeader
        title="插件开发"
        subtitle="关联本地插件源码目录，实时构建并覆盖运行"
        actions={
          <>
            <button className="small primary" disabled={blocked} onClick={() => void act(async () => {
              if (await window.bridge.packages.pickDevelopmentDirectory()) setDraft(null)
            })}>{directory.directory ? '添加目录…' : '选择开发目录…'}</button>
            {directory.directory && (
              <button className="small" disabled={blocked} onClick={() => void act(async () => {
                await window.bridge.packages.clearDevelopmentDirectory(); await window.bridge.vaults.reload()
              })}>移除全部目录并退出开发</button>
            )}
          </>
        }
      />
      {folders.length > 0 && (
        <SettingGroup>
          {folders.map(path => (
            <SettingRow key={path} className="development-folder" title="开发目录" description={path}>
              <button className="small" disabled={blocked} onClick={() => void act(async () => { await window.bridge.packages.removeDevelopmentDirectory(path); setDraft(null) })}>移除来源</button>
            </SettingRow>
          ))}
        </SettingGroup>
      )}
      {dirty && <p className="plugin-warn">请先应用或还原正式插件更改，再操作开发插件。</p>}
      {(error || loadError || directory.problem) && <p className="package-error" role="alert">{error || loadError || directory.problem}</p>}
      {directory.directory && <>
        <details className="development-toolchain"><summary>开发工具与检测</summary>
          <p className="development-path">{directory.toolchain || '尚未选择开发工具工程'}</p>
          <button className="small" disabled={blocked} onClick={() => void act(async () => { await window.bridge.packages.pickDevelopmentToolchain() })}>选择工具工程…</button>
          <button className="small" disabled={blocked} onClick={() => void act(() => window.bridge.packages.prepareDevelopmentSources(selected, true))}>重新检测</button>
        </details>
        {!!directory.rows.length && <input className="development-search" type="search" aria-label="搜索开发插件" placeholder="搜索目录中的插件" value={query} onChange={e => setQuery(e.target.value)} />}
        {!directory.rows.length && <p className="muted">目录中未发现包含 plugin.json 的插件。</p>}
      </>}
      {directory.rows.filter(r => `${r.title} ${r.id ?? ''} ${r.source}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())).map(row => {
        const checked = selected.includes(row.source), changedBuild = row.availableHash && row.availableHash !== row.appliedHash
        const status = row.problem || (checked && row.build?.state === 'error' ? '构建失败，当前运行版本保留' : checked && row.build?.state === 'building' ? '正在检查并构建…' : checked && !row.availableHash ? '等待构建' : !checked && row.appliedHash ? '待退出开发，恢复原正式选择' : checked && !row.appliedHash ? '待启用' : checked && changedBuild ? '有新构建，待应用' : row.appliedHash ? row.reason || (row.running ? '正在使用此构建' : '等待重载或重试') : '未启用')
        return <div className="development-source-row" key={row.source} data-development-source={row.id ?? row.source}>
          <label className="development-source-choice"><input type="checkbox" aria-label={`开发启用 ${row.title}`} checked={checked} disabled={blocked || (!checked && !!row.problem)} onChange={() => toggle(row.source)} />
            <span><span className="development-summary"><strong>{row.title}</strong><span className="muted">{row.version}</span>{row.appliedHash && <span className="package-status">开发中</span>}</span>
            {row.description && <span className="muted">{row.description}</span>}</span></label>
          <div className="development-source-info"><p className="development-path">{row.source}</p>
            <p className={row.problem || checked && row.build?.state === 'error' || row.appliedHash && row.reason ? 'package-error' : 'muted'}>{status}</p>
            {checked && row.build?.state === 'error' && <details className="development-diagnostics"><summary>构建错误详情</summary><pre>{row.build.message}</pre></details>}
            {row.appliedHash && <span className="muted">当前 {row.appliedHash.slice(0, 8)}{changedBuild ? ` → 新构建 ${row.availableHash!.slice(0, 8)}` : ''}</span>}
          </div>
        </div>
      })}
      {(directory.directory || applied.length > 0) && <div className="development-actions">
        <span className="muted">已勾选 {selected.length} 项</span>
        {changed && <button className="small" disabled={blocked} onClick={() => { setDraft(null); void act(() => window.bridge.packages.prepareDevelopmentSources(applied)) }}>还原选择</button>}
        <button className="primary" disabled={blocked || invalid || (selected.length > 0 && !!directory.problem) || (!pending && !applied.length)} onClick={() => void act(async () => {
          await window.bridge.packages.applyDevelopmentDirectory(rows.map(r => ({ source: r.source, hash: r.availableHash! })))
          await window.bridge.vaults.reload()
        })}>{busy ? '正在处理…' : '应用并重载'}</button>
      </div>}
    </div>
  )
}
