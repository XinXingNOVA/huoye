import { PluginUpdater } from './PluginUpdater'
import { PluginSuites } from './PluginSuites'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { ExternalBinding, PackagePreview, PackageRef, PackageRow } from '../../../shared/external-plugins'
import type { PluginPlan } from '../../../shared/plugin-plan'
import { Overlay } from '../../../plugin-api/ui/widgets'
import { catalogGroup, matchesPlugin, pluginCategories } from '../../../shared/plugin-presentation'
import { DISTRIBUTION } from '../../../plugins/generated/distribution'
import { PluginDetails } from './PluginDetails'
import { useModalFocus } from './modal-focus'
import { SectionHeader } from './ui-primitives'

interface Props {
  scope?: 'application' | 'library'
  onInstalledPresets?(ids: string[]): void
  presetActionLabel?: string
  onPreviewPreset?(id: string): Promise<void>
  rows: PackageRow[]; draft: ExternalBinding[]; retries: Set<string>; plan: PluginPlan; disabled: boolean
  onRefresh(): Promise<void>
  onActivity(busy: boolean): void
  onSelect(ref: PackageRef, enabled: boolean): void
  onRetry(hash: string): void
  onUninstalled(hash: string): void
}
export function PluginPackages({ scope = 'library', rows, draft, retries, plan, disabled, onRefresh, onActivity, onSelect, onRetry, onUninstalled, onPreviewPreset, onInstalledPresets, presetActionLabel = '在当前仓库中预览此方案 →' }: Props) {
  const [updateHash, setUpdateHash] = useState<string>()
  const [updateState, setUpdateState] = useState({ busy: false, guard: false })
  const closeUpdate = useCallback(() => setUpdateHash(undefined), [])
  const updateActivity = useCallback((busy: boolean, guard: boolean) => { setUpdateState({ busy, guard }); onActivity(guard) }, [onActivity])
  const [preview, setPreview] = useState<PackagePreview | null>(null)
  const [choices, setChoices] = useState<Record<number, string | null>>({})
  const [attempted, setAttempted] = useState(false)
  const running = useRef(false)
  const [removal, setRemoval] = useState<{ row: PackageRow; users: string[] } | null>(null)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [query, setQuery] = useState(''), [category, setCategory] = useState('all')
  const titleId = useId()
  const dialogRoot = useRef<HTMLDivElement>(null)
  useModalFocus(dialogRoot, !!preview || !!removal)
  useEffect(() => { onActivity(busy || !!preview || !!removal || updateState.guard) }, [busy, preview, removal, updateState.guard, onActivity])
  useEffect(() => () => onActivity(false), [onActivity])
  const act = async (fn: () => Promise<void>) => {
    if (running.current) return
    running.current = true; setBusy(true); setError('')
    try { await fn() } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { running.current = false; setBusy(false) }
  }
  const token = preview?.token
  useEffect(() => () => { if (token) void window.bridge.packages.cancelInstall(token).catch(() => {}) }, [token])
  const installable = preview?.items.filter(row => row.status === 'ready' || row.status === 'failed').length ?? 0
  const registrable = preview?.suites?.filter(s => s.status === 'ready' || s.status === 'failed' || s.status === 'incomplete').length ?? 0
  const openPreset = async (id: string) => {
    setPreview(null); onActivity(false)
    try { await onPreviewPreset?.(id) } catch (e) { setError(String(e)) }
  }
  const install = () => act(async () => {
    const result = await window.bridge.packages.install(preview!.token, Object.entries(choices).map(([index, hash]) => ({ index: Number(index), hash })))
    setPreview(result); setAttempted(true)
    onInstalledPresets?.(result.suites?.filter(s => s.status === 'installed' || s.status === 'existing' || s.status === 'incomplete').flatMap(s => s.presets.map(p => p.id)) ?? [])
    try { await onRefresh() } catch (e) { throw new Error(`安装结果已保留，但插件列表刷新失败：${String(e)}`) }
  })
  const close = () => { if (!busy) { setPreview(null); setRemoval(null); setError('') } }
  const problem = error ? <p className="package-error" role="alert">{error}</p> : null
  const groups = [...pluginCategories, { id: 'support', title: '支持组件' }]
  const visible = rows.filter(r => matchesPlugin(r.manifest, query, DISTRIBUTION) && (category === 'all' || catalogGroup(r.manifest, DISTRIBUTION) === category))
  const title = (id: string) => rows.find(r => r.manifest.id === id)?.manifest.title ?? DISTRIBUTION.find(p => p.id === id)?.title ?? id
  return <section className="package-settings plugin-catalog">
    {scope === 'application' && <>
      <PluginUpdater hash={updateHash} onClose={closeUpdate} onRefresh={onRefresh} onState={updateActivity} />
      <PluginSuites disabled={disabled || busy || updateState.guard || updateState.busy || !!preview || !!removal}
        onInstall={() => void act(async () => { setAttempted(false); setChoices({}); setPreview(await window.bridge.packages.pick()) })}
        onUpdate={id => void act(async () => { setAttempted(false); setChoices({}); setPreview(await window.bridge.packages.pick(id)) })}
        onPreviewPreset={onPreviewPreset} />
    </>}
    <SectionHeader title={scope === 'application' ? '已安装插件包' : '本仓库的外部插件'} badge={rows.length ? `${rows.length} 项` : undefined} />
    {!preview && !removal && problem}
    {!rows.length && <p className="package-empty muted">本机还没有安装插件包。</p>}
    {!!rows.length && <div className="plugin-filters"><input type="search" aria-label="搜索安装包" placeholder="搜索功能、名称或关键词" value={query} onChange={e => setQuery(e.target.value)} /><select aria-label="安装包分类" value={category} onChange={e => setCategory(e.target.value)}><option value="all">全部分类</option>{groups.filter(g => rows.some(r => catalogGroup(r.manifest, DISTRIBUTION) === g.id)).map(g => <option key={g.id} value={g.id}>{g.title}</option>)}</select></div>}
    {!!rows.length && !visible.length && <div className="plugin-empty"><p className="muted">没有符合条件的插件包</p><button className="small" onClick={() => { setQuery(''); setCategory('all') }}>清除筛选</button></div>}
    {groups.map(group => {
      const items = visible.filter(row => catalogGroup(row.manifest, DISTRIBUTION) === group.id)
      return !items.length ? null : <div className="plugin-group" data-plugin-group={group.id} key={group.id}><h3>{group.title}<span className="plugin-group-count">{items.length}</span></h3><div className="plugin-group-card">{items.map(row => {
      const chosen = draft.find(b => b.manifest.id === row.manifest.id)
      const checked = chosen?.hash === row.hash && chosen.enabled
      const changed = !!checked !== row.enabled
      const reason = checked ? plan.off.get(row.manifest.id) : undefined
      return <div className="package-row plugin-row" key={row.hash} data-package-id={row.manifest.id} data-package-version={row.manifest.version}>
        <div className="plugin-main">
        <div className="package-choice">
          {scope === 'library' && <input type="checkbox" aria-label={`启用 ${row.manifest.title} ${row.manifest.version}`} checked={!!checked} disabled={disabled || busy || (!row.installed && !checked)} onChange={e => onSelect(row, e.target.checked)} />}
          <div className="package-info"><div className="package-name">{row.manifest.title}<span className="muted">{row.manifest.version}</span>{scope !== 'application' && <span className={`package-status${row.running ? ' running' : ''}`}>{row.running ? '本仓库已启用' : !row.installed ? '未安装' : row.enabled ? '未能启用' : '未启用'}</span>}
            {(changed || retries.has(row.hash)) && <span className="package-pending">{checked ? retries.has(row.hash) ? '待重试' : '待启用' : '待停用'}</span>}
          </div>
            <p className="plugin-description muted">{row.manifest.description}</p>
            {reason && <p className="package-error">应用后：{reason}</p>}
            {row.enabled && row.reason && <p className="package-error">当前：{row.reason}</p>}
          </div>
        </div>
        <PluginDetails info={row.manifest} version={row.manifest.version} author={row.manifest.author} source={row.bundled ? '应用附带 · 可卸载' : '本地安装 · 可卸载'} title={title} />
        </div>
        <div className="package-buttons">
          {checked && row.enabled && row.installed && !row.running && <button className="small" disabled={disabled || busy || updateState.busy} onClick={() => onRetry(row.hash)}>{retries.has(row.hash) ? '取消重试' : '重试启用'}</button>}
          {scope === 'application' && row.installed && <button className="small" disabled={disabled || busy || updateState.busy} onClick={() => setUpdateHash(row.hash)}>更新…</button>}
          {scope === 'application' && row.installed && <button className="small" disabled={disabled || busy || updateState.busy} onClick={() => void act(async () => setRemoval({ row, users: await window.bridge.packages.removal(row.hash) }))}>卸载…</button>}
        </div>
      </div>
    })}</div></div>})}
    {(preview || removal) && <Overlay onClose={close}><div className="package-dialog" data-package-id={preview?.items.length === 1 ? preview.items[0].manifest?.id : undefined} data-package-version={preview?.items.length === 1 ? preview.items[0].manifest?.version : undefined} role="dialog" aria-modal="true" aria-labelledby={titleId} ref={dialogRoot} tabIndex={-1}>
      <h2 id={titleId}>{preview ? attempted ? '安装结果' : '安装套件或插件包' : '卸载本地插件'}</h2>
      {preview ? <>
        <p className="package-batch-summary" role="status">{Object.entries(installStatus).flatMap(([status, label]) => {
          const count = preview.items.filter(row => row.status === status).length
          return count ? [`${label} ${count} 项`] : []
        }).join(' · ')}</p>
        <div className="package-install-list">
          {preview.suites?.map(s => <article className="package-install-row" key={s.id} data-suite-id={s.id} data-suite-status={s.status}>
            <strong>{s.title} · {s.version}</strong><p className="muted">{s.status === 'ready' ? '待登记方案' : s.status === 'installed' ? '方案已登记' : s.status === 'existing' ? '方案已存在' : s.status === 'incomplete' ? '方案已登记 · 插件待补齐' : '方案尚未登记'}</p>
            {s.previousVersion && s.previousVersion !== s.version && <p>更新 {s.previousVersion} → {s.version}；当前仓库与用户副本保持不变。</p>}
            {!!s.changes?.length && <ul>{s.changes.map((c, i) => <li key={i}>{c}</li>)}</ul>}
            {!!s.missing?.length && <p className="muted">待安装：{s.missing.join('、')}。补齐后重新预览方案。</p>}
            <ul>{s.presets.map(p => <li key={p.id}>{p.title} {onPreviewPreset && (s.status === 'installed' || s.status === 'existing' || s.status === 'incomplete') && <button className="small" disabled={busy} data-preview-preset={p.id} onClick={() => void openPreset(p.id)}>{presetActionLabel}</button>}</li>)}</ul>
            {s.error && <p className="package-error">{s.error}</p>}
          </article>)}
          {preview.items.map(row => <article className="package-install-row" key={row.index} data-install-index={row.index} data-install-status={row.status}>
            <div className="package-install-name"><strong>{row.manifest?.title ?? row.file}</strong>{row.manifest && <span className="muted">{row.manifest.version}</span>}<span className={`package-install-status ${row.status}`}>{installStatus[row.status]}</span></div>
            {row.manifest && <><div className="muted package-install-file">{row.file} · {row.manifest.id} · 作者声明：{row.manifest.author}</div>
              {!!row.manifest.description && <p>{row.manifest.description}</p>}
              {!!row.manifest.requires.length && <p className="muted">启用时需要：{row.manifest.requires.map(title).join('、')}</p>}
            </>}
            {row.alternatives && !['installed','existing','duplicate'].includes(row.status) && <label>准备方式
              <select aria-label={`${row.manifest?.id}安装方式`} disabled={busy} value={choices[row.index] === null ? 'skip' : choices[row.index] ?? row.reuseHash ?? row.hash} onChange={e => setChoices(old => ({ ...old, [row.index]: e.target.value === 'skip' ? null : e.target.value }))}>
                <option value={row.hash}>安装附带推荐版 {row.manifest?.version}</option>
                {row.alternatives.filter(a => a.hash !== row.hash).map(a => <option key={a.hash} value={a.hash}>使用已安装 {a.version}</option>)}
                <option value="skip">暂不安装，先登记方案</option>
              </select>
            </label>}
            {row.reuseHash && row.status === 'reused' && <p className="muted">已复用本机安装包；仓库启用版本由方案预览决定。</p>}
            {row.error && <p className="package-error">{row.error}</p>}
          </article>)}
        </div>
        <p className="muted">插件包含可执行代码，只安装你信任的来源。安装后到仓库设置勾选启用，统一应用并重新加载。</p>
      </> : removal && <>
        <div className="package-summary"><strong>{removal.row.manifest.title}</strong><span>{removal.row.manifest.version}</span><p>仅移除本机安装包。素材、原文件及插件已写入的数据保留。</p></div>
        {removal.users.length ? <p>以下仓库仍在使用，请先取消勾选并应用更改：{removal.users.join('、')}。</p> : <p>绑定此版本的仓库将显示插件缺失；重新安装兼容版本后可以继续使用。</p>}
      </>}
      {problem}
      <div className="package-dialog-actions"><button className="small" disabled={busy} onClick={close}>{preview ? attempted ? '完成' : installable || registrable ? '取消' : '关闭' : '取消'}</button>
        {preview ? (installable > 0 || registrable > 0) && <button className="small primary" data-action="install-packages" disabled={busy} onClick={() => void install()}>{busy ? '正在安装…' : attempted ? registrable ? '重试未完成项' : `重试失败的 ${installable} 项` : `安装${installable ? ` ${installable} 个插件` : ''}${registrable ? `并登记 ${registrable} 个套件` : ''}`}</button> : removal && <button className="small package-danger" disabled={busy || !!removal.users.length} onClick={() => void act(async () => { await window.bridge.packages.uninstall(removal.row.hash); onUninstalled(removal.row.hash); await onRefresh(); setRemoval(null) })}>卸载插件</button>}
      </div>
    </div></Overlay>}
  </section>
}

const installStatus = { ready: '待安装', existing: '已存在', duplicate: '重复包，跳过', invalid: '无法安装', installed: '安装成功', failed: '安装失败', reused: '复用已安装', skipped: '暂不安装' } as const
