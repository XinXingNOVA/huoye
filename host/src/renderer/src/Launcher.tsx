import { AuxiliarySurface, blurAuxiliaryInputs } from './auxiliary-surface'
import { StartingPreset } from './components/StartingPreset'
import { LauncherCreate } from './components/LauncherCreate'
import { LauncherAi } from './components/LauncherAi'
import { useMcpSettings } from '../../plugins/mcp/use-mcp-settings'
import type { ApplicationMcpSettings } from '../../plugins/mcp/settings'
import { defaultStartingChoice, useStartingPreset } from './components/use-starting-preset'
import { SettingGroup, SettingRow } from './components/ui-primitives'
import type { CreationRecovery } from '../../shared/library-creation'
// 仓库管理（设计文档 13.5）：最近的仓库、新建仓库、打开文件夹作为仓库。像 Obsidian 的仓库管理。
// 一个仓库就是一个文件夹；仓库是托管的，所以只能在空文件夹里新建，不把已有的文件夹原地变成仓库。

import { SettingsController } from './settings-controller'
import { applicationSettingsPages } from './application-settings-catalog'
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { ApplicationSettings } from './components/ApplicationSettings'
import { useModalFocus } from './components/modal-focus'
import { CloseIcon, SettingsIcon, SparklesIcon, VaultIcon } from './components/icons'

const grantLabels = { read: 'AI 只读', organize: 'AI 可整理', admin: 'AI 托管' }

function libraryGrant(settings: ApplicationMcpSettings | undefined, vault: VaultInfo) {
  if (!vault.exists || !settings?.enabled) return
  const matches = settings.libraries.filter(l => l.root === vault.path)
  // 更换目录里的仓库后可能留有旧登记。身份不明确时不展示旧授权。
  const grant = matches.find(l => l.open) ?? (matches.length === 1 ? matches[0] : undefined)
  if (!grant || grant.mode === 'off' || settings.libraries.some(l => l !== grant && l.libraryId === grant.libraryId && l.mode !== 'off')) return
  return grantLabels[grant.mode]
}

export function Launcher() {
  const [settingsOpen, setSettingsOpen] = useState(false)
  const ai = useMcpSettings(window.bridge.application.service)
  const aiSettings = ai.settings
  const creation = aiSettings?.creation
  const aiDescription = creation
    ? <span className="launcher-ai-directory"><span>{aiSettings.enabled ? '建库目录' : 'AI 接入已暂停'}</span>
        <span className="launcher-location-path" title={creation.parent}>{'\u200e' + creation.parent}</span></span>
    : aiSettings?.enabled ? 'AI 已可访问获准的仓库，可在此设置建库位置。' : '用自己的 AI 客户端建库、整理素材，再回到这里验收。'
  const settingsRoot = useRef<HTMLDivElement>(null)
  useModalFocus(settingsRoot, settingsOpen)
  const [settingsService] = useState(
    () => new SettingsController(applicationSettingsPages, () => { setSettingsOpen(true); void window.bridge.auxiliary.focus('settings') }, 'application')
  )
  const snapshot = useSyncExternalStore(settingsService.subscribe, settingsService.getSnapshot)
  useEffect(() => () => settingsService.dispose(), [settingsService])
  useEffect(() => window.bridge.lifecycle.onPrepare(async reason => {
    blurAuxiliaryInputs()
    if (!await settingsService.beforeLeave({ reason })) {
      void window.bridge.auxiliary.focus('settings')
      throw new Error(settingsService.getSnapshot().blockedReason ?? '请先处理未保存的设置')
    }
  }, () => {}), [settingsService])

  const [recent, setRecent] = useState<VaultInfo[]>([])
  const [name, setName] = useState('')
  const [parent, setParent] = useState('')
  const [error, setError] = useState<string>()
  const [space, setSpace] = useState<import('../../shared/file-spaces').SpaceInfo>()
  const [busy, setBusy] = useState(false)
  const [page, setPage] = useState<'home' | 'create' | 'preset' | 'ai'>('home')
  const [choice, setChoice] = useState(defaultStartingChoice)
  const [draft, setDraft] = useState(defaultStartingChoice)
  const model = useStartingPreset(page === 'preset' ? draft : choice)
  const [recoveries, setRecoveries] = useState<CreationRecovery[]>([])
  const stage = useRef<HTMLElement>(null)
  useEffect(() => {
    const focus = stage.current?.querySelector<HTMLElement>(page === 'create' ? 'input' : 'h1')
    focus?.focus()
  }, [page])
  const browsePreset = (id?: string) => {
    setDraft(id ? { id, versions: [], layout: true } : choice)
    setPage('preset')
  }

  const openSettings = useCallback((section?: string) => {
    void settingsService
      .open(section ? { scope: 'application', section } : undefined)
      .then(ok => {
        if (!ok) setError(settingsService.getSnapshot().blockedReason ?? '设置正在处理，请稍候')
      })
      .catch(e => setError(String(e)))
  }, [settingsService])

  const { refresh: refreshAi } = ai
  const settingsClosed = useCallback(() => { setSettingsOpen(false); void refreshAi() }, [refreshAi])
  const closeSettings = useCallback(async () => {
    try {
      blurAuxiliaryInputs()
      const ok = await settingsService.beforeLeave({ reason: 'close' })
      if (ok) {
        settingsClosed()
        setError(undefined)
        return true
      }
      setError(settingsService.getSnapshot().blockedReason ?? '设置正在处理，请稍候')
      return false
    } catch (e) {
      setError(String(e))
      return false
    }
  }, [settingsService, settingsClosed])

  const refresh = useCallback(() => {
    void Promise.all([window.bridge.vaults.list(), window.bridge.creation.pending()]).then(([d, pending]) => {
      setRecent(d.recent); setRecoveries(pending)
      setParent((p) => p || d.defaultParent)
    }).catch(e => setError(String(e)))
  }, [])

  useEffect(() => {
    refresh()
    // 别的窗口里开关了仓库：回到这里时刷新
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [refresh])

  useEffect(() => window.bridge.onMenuCommand(command => { if (command === 'settings') openSettings() }), [openSettings])

  const run = async (fn: () => Promise<VaultResult>) => {
    setBusy(true)
    setError(undefined)
    try { const r = await fn(); if ('error' in r) setError(r.error) }
    catch (e) { setError(String(e)) }
    finally { setBusy(false); refresh() }
  }

  const create = () => {
    const preview = model.preview
    if (name.trim() && parent.trim() && !busy && preview && !preview.issues.length) void run(() => window.bridge.creation.create({
      parent, name, spaceRoot: space?.root, spaceId: space?.id, preset: model.preset, plugins: model.preset ? undefined : [], previewRevision: preview.revision
    }))
  }

  return (
    <div className="launcher" data-page={page}>
      <aside className="launcher-recent">
        <div className="launcher-recent-top">
          <div className="launcher-drag" />
          <div className="launcher-brand">
            <div className="launcher-brand-icon" aria-hidden="true">
              <VaultIcon size={16} />
            </div>
            <span>仓库列表</span>
          </div>
          <div className="nav-title">最近的仓库</div>
          <div className="launcher-recent-list">
            {recent.map((v) => {
              const badge = libraryGrant(aiSettings, v)
              return (
                <div key={v.path} className={`vault-item${v.exists ? '' : ' missing'}${v.open ? ' is-open' : ''}`}>
                  <button className="vault-open" disabled={!v.exists || busy} onClick={() => void run(() => window.bridge.vaults.open(v.path))}>
                    <span className="vault-title">
                      <span className="vault-name" title={v.name}>{v.name}</span>
                      {badge && <span className="launcher-ai-badge">{badge}</span>}
                      {v.open && <span className="muted"> · 已打开</span>}
                    </span>
                    {/* 路径太长时省略开头；前面加一个从左到右的标记，免得开头的 / 被排到末尾 */}
                    <span className="vault-path">{'\u200e' + (v.exists ? v.path : `找不到了：${v.path}`)}</span>
                  </button>
                  <button className="nav-x" title="从列表里移除（不会删除文件）" disabled={busy} onClick={() => void window.bridge.vaults.forget(v.path).then(refresh).catch(e => setError(String(e)))}>
                    ×
                  </button>
                </div>
              )
            })}
          </div>
          {!recent.length && (
            <div className="launcher-empty-recent muted launcher-hint">
              <span>还没有打开过仓库</span>
              <small>在右侧新建或打开本地仓库</small>
            </div>
          )}
        </div>
        <button className="launcher-settings-entry" title="应用与插件设置" aria-label="应用与插件设置" onClick={() => openSettings()}>
          <SettingsIcon size={15} />设置
        </button>
      </aside>

      <main className="launcher-main" ref={stage}>
        <div className="launcher-drag" />
        <div className="launcher-shell">
          {page !== 'home' && <nav className="launcher-back"><button disabled={busy} onClick={() => setPage(page === 'preset' ? 'create' : 'home')}>
            {page === 'preset' ? '← 返回新建仓库' : '← 返回'}
          </button></nav>}
          {error && !settingsOpen && <div role="alert" className="launcher-error">{error}{page !== 'home' && !!recoveries.length && <button className="small" onClick={() => setPage('home')}>查看未完成的创建</button>}</div>}
          {page === 'home' && <>
          <header className="launcher-hero">
            <div className="launcher-logo" aria-hidden="true" />
            <h1 tabIndex={-1}>活页Huoye</h1>
            <p className="muted">收集资料，组织内容，搭建自己的工作台。</p>
          </header>
          <SettingGroup className="launcher-home-actions">
            <SettingRow title="新建仓库" description="创建一个仓库，可选择起始方案。">
              <button className="primary" disabled={busy} onClick={() => setPage('create')}>创建</button>
            </SettingRow>
            <SettingRow title="打开本地仓库" description="选择已有仓库，或初始化一个空文件夹。">
              <button className="small" disabled={busy} onClick={async () => {
                try { const p = await window.bridge.vaults.pick('folder'); if (p) void run(() => window.bridge.vaults.open(p)) }
                catch (e) { setError(String(e)) }
              }}>打开</button>
            </SettingRow>
            <SettingRow title={<span className="launcher-ai-title"><SparklesIcon size={15} />交给 AI</span>} description={aiDescription}>
              <button className="small" disabled={busy} onClick={() => { setPage('ai'); void refreshAi() }}>
                {creation || aiSettings?.enabled ? '连接与配置' : '设置…'}
              </button>
            </SettingRow>
          </SettingGroup>
          {!!recoveries.length && <details className="launcher-recoveries" aria-label="未完成的创建">
            <summary>有 {recoveries.length} 个仓库尚未完成创建 · 继续处理</summary>
            {recoveries.map(job => <article key={job.id} data-creation-id={job.id}>
              <div className="launcher-recovery-head">
                <strong>{job.name}{job.title ? ' · ' + job.title : ''}</strong>
                <span className="muted">{job.root}</span>
              </div>
              {job.error && <p className="package-error">{job.error}</p>}
              <div className="launcher-space-actions">
                <button className="small primary" disabled={busy} onClick={() => void run(() => window.bridge.creation.resume(job.id))}>继续创建</button>
                <button className="small" disabled={busy} onClick={() => void run(() => window.bridge.creation.openBasic(job.id))}>先打开仓库</button>
                <button className="small" disabled={busy} onClick={() => void run(async () => { await window.bridge.creation.dismiss(job.id); return { ok: true } })}>取消接续</button>
              </div>
              <small className="muted">取消接续保留目录和已有数据；“先打开仓库”暂缓方案插件及空间关联，可稍后在设置中处理。</small>
            </article>)}
          </details>}
          </>}

          {page === 'ai' && <>
            {ai.error && <div role="alert" className="launcher-error">{ai.error} <button className="small" onClick={() => void refreshAi()}>重新读取</button>
              {' '}<button className="small" onClick={() => openSettings('mcp.connection')}>打开 AI 接入设置</button></div>}
            {aiSettings ? <LauncherAi settings={aiSettings} busy={ai.busy} save={ai.save} settingsOpen={settingsOpen}
              openSettings={() => openSettings('mcp.connection')} /> : !ai.error && <p role="status">正在读取 AI 配置…</p>}
          </>}
          {page === 'create' && <LauncherCreate name={name} parent={parent} space={space} model={model} busy={busy}
            onName={setName} onParent={setParent} onSpace={setSpace} onError={setError} onBrowse={() => browsePreset()} onSelect={id => setChoice({ id, versions: [], layout: true })} onCreate={create} />}
          {page === 'preset' && <section className="launcher-preset-page" aria-label="选择起始方案">
            <h1 tabIndex={-1}>选择起始方案</h1>
            <StartingPreset model={model} value={draft} disabled={busy} onChange={setDraft} onInstall={() => {
              void settingsService.open({ scope: 'application', section: 'packages' }).catch(e => setError(String(e)))
            }} />
            <footer className="launcher-create-footer">
              <span className="muted">安装到本机，创建时为这个仓库启用。</span>
              <button className="primary" disabled={busy || !model.preview || !!model.preview.issues.length} onClick={() => { setChoice(draft); setPage('create') }}>确认选择此方案</button>
            </footer>
          </section>}
        </div>
      </main>

      {settingsOpen && (
        <AuxiliarySurface kind="settings" title="应用设置" onClose={closeSettings} onLost={settingsClosed}>
          <div
            className="launcher-settings settings settings-modal launcher-settings-modal settings-window-content"
            ref={settingsRoot}
            tabIndex={-1}
            role="dialog"
            aria-modal="false"
            aria-label="应用设置"
            onKeyDown={e => {
              if ((e.target as Element).closest('[role="dialog"]') !== e.currentTarget) return
              if (e.nativeEvent.isComposing || e.keyCode === 229) return
              if (e.key === 'Escape') {
                e.preventDefault()
                e.stopPropagation()
                void closeSettings()
              }
            }}
          >
            <header className="settings-modal-header launcher-settings-header">
              <div className="settings-modal-heading">
                <h1>应用设置</h1>
                <span className="settings-scope-pill">全局应用 · 保存在本机</span>
              </div>
              <div className="settings-modal-actions">
                <button className="small" onClick={() => void closeSettings()}>
                  返回仓库管理
                </button>
                <button
                  type="button"
                  className="settings-close-btn"
                  aria-label="关闭设置"
                  title="关闭设置 (Esc)"
                  onClick={() => void closeSettings()}
                >
                  <CloseIcon size={16} />
                </button>
              </div>
            </header>
            {error && <p role="alert" className="launcher-error">{error}</p>}
            <ApplicationSettings settings={settingsService} section={snapshot.target?.section} presetActionLabel="用此方案新建仓库 →" onInstalledPresets={ids => { if (ids.length === 1) browsePreset(ids[0]) }} onPreviewPreset={async id => {
              if (await closeSettings()) browsePreset(id)
            }} />
          </div>
        </AuxiliarySurface>
      )}
    </div>
  )
}
