import { uiText } from '../../../shared/i18n/interface-display'
import { useLanguage } from '../language'
import { packageText } from '../../../shared/package-locales'
import { PluginUpdater } from './PluginUpdater'
import { PluginSuites } from './PluginSuites'
import type { SuiteRegistration } from '../../../shared/plugin-suites'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { PackageManifest, PackagePreview, PackageRef, PackageRow } from '../../../shared/external-plugins'
import { canCleanVersion, comparePackageVersions, groupPackages, type PackageInventory } from '../../../shared/package-catalog'
import { Overlay } from '../../../plugin-api/ui/widgets'
import { DISTRIBUTION } from '../../../plugins/generated/distribution'
import { PluginChoices } from './PluginChoices'
import { InstallDifferences, installStatus } from './InstallDifferences'
import { PackageCleanup } from './PackageCleanup'
import { useModalFocus } from './modal-focus'
import { SectionHeader } from './ui-primitives'

interface Props {
  active: boolean
  onStagePackages?(refs: PackageRef[]): Promise<void>
  onInstalledPresets?(ids: string[]): void
  presetActionLabel?: string
  onPreviewPreset?(id: string): Promise<void>
  rows: PackageRow[]; disabled: boolean
  onRefresh(): Promise<void>
  onActivity(busy: boolean): void
}
export function PluginPackages({ active, rows, disabled, onRefresh, onActivity, onStagePackages, onPreviewPreset, onInstalledPresets, presetActionLabel = uiText("在当前仓库中预览此方案 →") }: Props) {
  const { locale } = useLanguage()
  const label = (m: PackageManifest, field: 'title' | 'description' = 'title') => packageText(m.locales, locale, m[field])
  const [update, setUpdate] = useState<{ hash: string; target?: string }>()
  const [inventory, setInventory] = useState<PackageInventory>()
  const [suiteId, setSuiteId] = useState<string>()
  const [registered, setRegistered] = useState<SuiteRegistration[]>([])
  const suite = registered.find(s => s.manifest.id === suiteId)?.manifest
  const suiteFilter = suite && { title: packageText(suite.locales, locale, suite.title), ids: suite.packages.map(p => p.id) }
  const [cleanup, setCleanup] = useState<PackageRow[]>()
  const [baseline, setBaseline] = useState<PackageRow[]>([])
  const [dropping, setDropping] = useState(false)
  const [inventoryError, setInventoryError] = useState('')
  useEffect(() => {
    if (!active) return
    let live = true
    void window.bridge.packages.inventory().then(result => {
      if (live) { setInventory(result); setInventoryError('') }
    }, error => { if (live) { setInventory(undefined); setInventoryError(String(error)) } })
    return () => { live = false }
  }, [active, rows])
  const [updateState, setUpdateState] = useState({ busy: false, guard: false })
  const closeUpdate = useCallback(() => setUpdate(undefined), [])
  const updateActivity = useCallback((busy: boolean, guard: boolean) => { setUpdateState({ busy, guard }); onActivity(guard) }, [onActivity])
  const [preview, setPreview] = useState<PackagePreview | null>(null)
  const [choices, setChoices] = useState<Record<number, string | null>>({})
  const [attempted, setAttempted] = useState(false)
  const running = useRef(false)
  const [removal, setRemoval] = useState<{ row: PackageRow; users: string[] } | null>(null)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const titleId = useId()
  const installedRegion = useRef<HTMLDivElement>(null)
  const dialogRoot = useRef<HTMLDivElement>(null)
  useModalFocus(dialogRoot, !!preview || !!removal)
  useEffect(() => { onActivity(busy || !!preview || !!removal || !!cleanup || updateState.guard) }, [busy, preview, removal, cleanup, updateState.guard, onActivity])
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
    try { await onRefresh() } catch (e) { throw new Error(uiText("安装结果已保留，但插件列表刷新失败：{value1}", { value1: String(String(e)) })) }
  })
  const close = () => { if (!busy) { setPreview(null); setRemoval(null); setError('') } }
  const problem = error ? <p className="package-error" role="alert">{error}</p> : null
  const title = (id: string) => {
    const row = rows.find(r => r.manifest.id === id)
    return row ? label(row.manifest) : DISTRIBUTION.find(p => p.id === id)?.title ?? id
  }
  function begin(files?: string[], suite?: string) {
    void act(async () => {
      const before = await window.bridge.packages.installed()
      const result = files ? await window.bridge.packages.previewFiles(files) : await window.bridge.packages.pick(suite)
      if (result) { setBaseline(before); setChoices({}); setAttempted(false); setPreview(result) }
    })
  }
  const blocked = disabled || busy || updateState.busy || updateState.guard || !!preview || !!removal || !!cleanup
  const installedBefore = groupPackages(baseline)
  const available = rows.filter(r => inventory && canCleanVersion(inventory, r.hash))
  const newer = preview?.items.filter(r => r.status === 'installed' && r.manifest) ?? []
  const fromInstall = available.filter(r => installedBefore.get(r.manifest.id)?.[0]?.manifest.version === r.manifest.version && newer.some(n =>
    n.manifest!.id === r.manifest.id && comparePackageVersions(n.manifest!.version, r.manifest.version) > 0))
  const stageable = newer.flatMap(r => r.hash && r.manifest ? [{ hash: r.hash, manifest: r.manifest }] : [])
  const canStage = stageable.length > 0 && groupPackages(stageable).size === stageable.length
  const startCleanup = (items: PackageRow[]) => { setPreview(null); setCleanup(items) }
  return <section className="package-settings plugin-catalog" data-dropping={dropping || undefined}
    onDragOver={e => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); e.stopPropagation(); setDropping(!blocked); e.dataTransfer.dropEffect = blocked ? 'none' : 'copy' } }}
    onDragLeave={e => { if (!e.relatedTarget || !(e.relatedTarget as Node).nodeType || !e.currentTarget.contains(e.relatedTarget as Node)) setDropping(false) }}
    onDrop={e => {
      if (!e.dataTransfer.types.includes('Files')) return
      e.preventDefault(); e.stopPropagation(); setDropping(false)
      if (!blocked) begin(Array.from(e.dataTransfer.files, f => window.bridge.pathForFile(f)))
    }}>
      {dropping && <div className="plugin-drop-hint" role="status">{uiText("拖放套件或插件包以预览")}</div>}
      <PluginUpdater hash={update?.hash} target={update?.target} onClose={closeUpdate} onRefresh={onRefresh} onState={updateActivity} />
      <PluginSuites disabled={blocked} onInstall={() => begin()} onUpdate={id => begin(undefined, id)} onPreviewPreset={onPreviewPreset}
        onRegistrations={setRegistered} onMembers={s => {
          setSuiteId(s.manifest.id)
          installedRegion.current?.focus({ preventScroll: true })
          installedRegion.current?.scrollIntoView({ block: 'start' })
        }} />
    {!!available.length && <div className="package-cleanup-bar">{uiText("{n} 个闲置旧版", { n: available.length })}<button className="small" disabled={blocked} onClick={() => startCleanup(available)}>{uiText("查看并清理…")}</button></div>}
    {inventoryError && <p role="alert" className="package-error">{inventoryError}</p>}
    {!!inventory?.unchecked.length && <details><summary>{uiText("部分仓库未能核对")}</summary>{inventory.unchecked.map(root => <p key={root}>{root}</p>)}</details>}
    <div ref={installedRegion} tabIndex={-1}><SectionHeader title={uiText("已安装插件包")} badge={String(groupPackages(rows).size)} /></div>
    {!preview && !removal && problem}
    <PluginChoices key={suite?.id ?? 'all'} rows={rows} busy={blocked} suite={suiteFilter} clearSuite={() => setSuiteId(undefined)} inventory={inventory} actions={{
      update: (r, target) => setUpdate({ hash: r.hash, target: target?.hash }),
      remove: r => void act(async () => setRemoval({ row: r, users: await window.bridge.packages.removal(r.hash) })),
      clean: startCleanup
    }} />
    {cleanup && <PackageCleanup candidates={cleanup} rows={rows} inventory={inventory ?? { versions: {}, unchecked: [] }} onClose={() => setCleanup(undefined)} onRefresh={onRefresh} />}
    {(preview || removal) && <Overlay onClose={close}><div className="package-dialog" data-package-id={preview?.items.length === 1 ? preview.items[0].manifest?.id : undefined} data-package-version={preview?.items.length === 1 ? preview.items[0].manifest?.version : undefined} role="dialog" aria-modal="true" aria-labelledby={titleId} ref={dialogRoot} tabIndex={-1}>
      <h2 id={titleId}>{preview ? attempted ? uiText("安装结果") : uiText("安装套件或插件包") : uiText("卸载本地插件")}</h2>
      {preview ? <>
        <p className="package-batch-summary" role="status">{Object.entries(installStatus).flatMap(([status, label]) => {
          const count = preview.items.filter(row => row.status === status).length
          return count ? [uiText("{label} {count} 项", { label, count })] : []
        }).join(' · ')}</p>
        <div className="package-install-list">
          {preview.suites?.map(s => <article className="package-install-row" key={s.id} data-suite-id={s.id} data-suite-status={s.status}>
            <strong>{s.title} · {s.version}</strong><p className="muted">{s.status === 'ready' ? uiText("待登记方案") : s.status === 'installed' ? uiText("方案已登记") : s.status === 'existing' ? uiText("方案已存在") : s.status === 'incomplete' ? uiText("方案已登记 · 插件待补齐") : uiText("方案尚未登记")}</p>
            {s.previousVersion && s.previousVersion !== s.version && <p>{uiText("更新")}{' '}{s.previousVersion} → {s.version}{uiText("；当前仓库与用户副本保持不变。")}</p>}
            {!!s.changes?.length && <ul>{s.changes.map((c, i) => <li key={i}>{c}</li>)}</ul>}
            {!!s.missing?.length && <p className="muted">{uiText("待安装：")}{s.missing.join('、')}{uiText("。补齐后重新预览方案。")}</p>}
            <ul>{s.presets.map(p => <li key={p.id}>{p.title} {onPreviewPreset && (s.status === 'installed' || s.status === 'existing' || s.status === 'incomplete') && <button className="small" disabled={busy} data-preview-preset={p.id} onClick={() => void openPreset(p.id)}>{presetActionLabel}</button>}</li>)}</ul>
            {s.error && <p className="package-error">{s.error}</p>}
          </article>)}
          <InstallDifferences items={preview.items} baseline={installedBefore} choices={choices} busy={busy} title={title}
            onChoice={(index, hash) => setChoices(old => ({ ...old, [index]: hash }))} />
        </div>
        {attempted && onStagePackages && canStage && <button data-action="stage-installed" className="small primary" disabled={busy} onClick={async () => {
          onActivity(false)
          try { await onStagePackages(stageable); setPreview(null) } catch (e) { onActivity(true); setError(String(e)) }
        }}>{uiText("在本库预选这 {n} 个版本…", { n: stageable.length })}</button>}
        {attempted && onStagePackages && stageable.length > 0 && !canStage && <p>{uiText("已安装同一插件的多个版本，请在本库功能与方案中选择。")}</p>}
        {attempted && !!fromInstall.length && <button className="small" disabled={busy} onClick={() => startCleanup(fromInstall)}>{uiText("清理本次安装涉及的旧版…")}</button>}
        <p className="muted">{uiText("插件包含可执行代码，只安装你信任的来源。安装后到仓库设置勾选启用，统一应用并重新加载。")}</p>
      </> : removal && <>
        <div className="package-summary"><strong>{label(removal.row.manifest)}</strong><span>{removal.row.manifest.version}</span><p>{uiText("仅移除本机安装包。素材、原文件及插件已写入的数据保留。")}</p></div>
        {removal.users.length ? <p>{uiText("受以下绑定或任务保护")}{' · '}{removal.users.join('、')}。</p> : <p>{uiText("绑定此版本的仓库将显示插件缺失；重新安装兼容版本后可以继续使用。")}</p>}
      </>}
      {problem}
      <div className="package-dialog-actions"><button className="small" disabled={busy} onClick={close}>{preview ? attempted ? uiText("完成") : installable || registrable ? uiText("取消") : uiText("关闭") : uiText("取消")}</button>
        {preview ? (installable > 0 || registrable > 0) && <button className="small primary" data-action="install-packages" disabled={busy} onClick={() => void install()}>{busy ? uiText("正在安装…") : attempted ? registrable ? uiText("重试未完成项") : uiText("重试失败的 {installable} 项", { installable }) : uiText("安装{value1}{value2}", { value1: String(installable ? uiText(" {installable} 个插件", { installable }) : ''), value2: String(registrable ? uiText("并登记 {registrable} 个套件", { registrable }) : '') })}</button> : removal && <button className="small package-danger" disabled={busy || !!removal.users.length} onClick={() => void act(async () => { await window.bridge.packages.uninstall(removal.row.hash); await onRefresh(); setRemoval(null) })}>{uiText("卸载插件")}</button>}
      </div>
    </div></Overlay>}
  </section>
}
