import { useEffect, useRef, useState } from 'react'
import type { ManagementSettings } from '../../../shared/application-management'
import type { ApplicationAccessChange } from '../../../shared/application-access'
import type { ApplicationMcpSettings } from '../../../plugins/mcp/settings'
import { clientConfig } from '../../../plugins/mcp/client-config'
import { SettingGroup, SettingRow } from './ui-primitives'

type Creation = NonNullable<ApplicationMcpSettings['creation']>
const modeDescriptions = {
  admin: '可装配已许可的插件、配置工作台和整理素材。',
  organize: '可导入、打标和填写字段，沿用已有库结构。',
  read: '可检索和查看素材。'
}
const firstRequest = '请先查看活页Huoye中我已授权的仓库、可用插件和建库位置，再告诉我你可以怎样帮我整理素材。'

function ClientConnection({ config }: { config: string }) {
  const [format, setFormat] = useState<'json' | 'toml'>('json')
  const [notice, setNotice] = useState('')
  const [manualCopy, setManualCopy] = useState<string>()
  const snippet = clientConfig(config, format)
  const copy = async (text: string, label: string) => {
    try { await navigator.clipboard.writeText(text); setManualCopy(undefined); setNotice('已复制' + label) }
    catch { setManualCopy(text); setNotice('请选择下方文字，手动复制' + label) }
  }
  return <SettingGroup title="连接外部 AI 客户端">
    <div className="launcher-ai-connect">
      <div className="launcher-ai-controls">
        <select className="select" aria-label="客户端配置格式" value={format} onChange={e => {
          setFormat(e.target.value as typeof format); setManualCopy(undefined); setNotice('')
        }}>
          <option value="json">Claude Code / Cursor · JSON</option><option value="toml">Codex · TOML</option>
        </select>
        <button className="small" onClick={() => void copy(snippet, '接入配置')}>复制接入配置</button>
      </div>
      <div className="launcher-ai-controls">
        <details><summary>查看配置</summary>
          <p className="muted">{format === 'toml' ? '将以下设置合并到 Codex 的 config.toml。' : '将 huoye 条目加入客户端的 mcpServers 配置。'}</p>
          <textarea className="launcher-ai-snippet" aria-label="客户端配置" readOnly value={snippet} onFocus={e => e.target.select()} />
        </details>
        <button className="small" onClick={() => void copy(firstRequest, '第一句指令')}>复制第一句指令</button>
      </div>
      {notice && <span role="status">{notice}</span>}
      {manualCopy && <textarea className="launcher-ai-snippet" aria-label="手动复制内容" value={manualCopy} readOnly onFocus={e => e.target.select()} />}
    </div>
  </SettingGroup>
}

function AllowedPlugins({ openSettings, settingsOpen }: { openSettings(): void; settingsOpen: boolean }) {
  const [state, setState] = useState<ManagementSettings>()
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const generation = useRef(0), changing = useRef(false)
  useEffect(() => {
    if (settingsOpen) return
    const load = async () => {
      if (changing.current) return
      const request = ++generation.current
      try {
        const next = await window.bridge.application.service('mcp', 'management', { action: 'list' }) as ManagementSettings
        if (request === generation.current) { setState(next); setError('') }
      } catch (e) { if (request === generation.current) setError(String(e)) }
    }
    void load()
    window.addEventListener('focus', load)
    return () => { generation.current++; window.removeEventListener('focus', load) }
  }, [settingsOpen])
  const approve = async (hashes: string[]) => {
    if (changing.current) return
    changing.current = true; setBusy(true); generation.current++
    try {
      const next = await window.bridge.application.service('mcp', 'management', { action: 'package-permissions', hashes, allowed: true }) as ManagementSettings
      setState(next); setError('')
    } catch (e) { setError(String(e)) }
    finally { changing.current = false; setBusy(false) }
  }
  const packages = state?.packages.filter(p => p.installed && p.allowed)
  return <div className="launcher-ai-permissions">
    {error && <p role="alert">{error}</p>}
    {state?.suites.map(suite => {
      const pending = state.packages.filter(p => p.installed && !p.allowed && suite.hashes.includes(p.hash))
      if (!pending.length) return null
      return <details key={suite.id}><summary>{suite.title} · {pending.length} 个版本待授权</summary>
        <p>{pending.map(p => p.manifest.title + ' ' + p.manifest.version).join('、')}</p>
        <button className="small" disabled={busy} onClick={() => void approve(pending.map(p => p.hash))}>允许 AI 使用上述版本</button>
      </details>
    })}
    <details><summary>已许可的插件包{packages && ' · ' + packages.length}</summary>
      <p>{packages?.map(p => p.manifest.title + ' ' + p.manifest.version).join('、') || (packages ? '尚无已安装且获准的插件包' : '正在读取…')}</p>
    </details>
    <button className="launcher-ai-link" onClick={openSettings}>管理仓库与插件许可</button>
  </div>
}

export function LauncherAi({ settings, busy, save, openSettings, settingsOpen }: {
  settings: ApplicationMcpSettings; busy: boolean; save(change: ApplicationAccessChange): Promise<boolean>
  openSettings(): void; settingsOpen: boolean
}) {
  const current = settings.creation
  const baseline = JSON.stringify([current?.parent, current?.mode, !!current?.autonomousDevelopment, settings.enabled])
  const [draft, setDraft] = useState<{ base: string; value: Creation }>()
  const [notice, setNotice] = useState('')
  const value = draft?.value ?? current ?? { parent: '', mode: 'admin' }
  const conflict = !!draft && draft.base !== baseline
  const canResume = !settings.enabled && !draft && (!!current || settings.libraries.some(l => l.mode !== 'off'))
  const edit = (patch: Partial<Creation>) => { setDraft({ base: draft?.base ?? baseline, value: { ...value, ...patch } }); setNotice('') }
  const pick = async () => {
    try { const parent = await window.bridge.vaults.pick('parent'); if (parent) edit({ parent }) }
    catch (e) { setNotice(String(e)) }
  }
  const submit = async () => {
    if (canResume) {
      if (await save({ enabled: true })) setNotice('AI 接入已恢复。')
      return
    }
    if (!value.parent || conflict) return
    if (await save({ enabled: true, creation: value })) { setDraft(undefined); setNotice('设置已保存，可以连接客户端。') }
  }
  return <section className="launcher-ai-page" aria-label="AI 托管">
    <header><h1 tabIndex={-1}>AI 托管</h1><p className="muted">从外部 AI 客户端发起任务，回到仓库查看和验收结果。</p></header>
    <SettingGroup>
      <SettingRow title="新仓库的位置" description={value.parent || '选择允许 AI 在其中新建仓库的文件夹。'}>
        <button className="small" disabled={busy} onClick={() => void pick()}>{value.parent ? '更换目录…' : '选择目录…'}</button>
      </SettingRow>
      <SettingRow title={<label htmlFor="launcher-ai-mode">新仓库的权限</label>} description={modeDescriptions[value.mode]}>
        <select className="select" id="launcher-ai-mode" value={value.mode} disabled={busy} onChange={e => edit({ mode: e.target.value as Creation['mode'], autonomousDevelopment: undefined })}>
          <option value="admin">标准托管</option><option value="organize">仅整理素材</option><option value="read">只读</option>
        </select>
      </SettingRow>
      {value.mode === 'admin' && <label className="launcher-ai-development"><input type="checkbox" checked={!!value.autonomousDevelopment} disabled={busy}
        onChange={e => edit({ autonomousDevelopment: e.target.checked || undefined })} /><span>允许 AI 自主开发插件<small className="muted">可为新库编写、构建并运行插件代码。</small></span></label>}
      <AllowedPlugins openSettings={openSettings} settingsOpen={settingsOpen} />
    </SettingGroup>
    <div className="launcher-ai-controls">
      <button className="primary" disabled={busy || conflict || (!canResume && !value.parent) || (settings.enabled && !draft && !!current)} onClick={() => void submit()}>
        {canResume ? '恢复 AI 接入' : settings.enabled ? '保存建库设置' : '保存并开启 AI 接入'}</button>
      {settings.enabled && <button className="small" disabled={busy} onClick={async () => {
        if (await save({ enabled: false })) { setDraft(undefined); setNotice('全部仓库的 AI 接入已暂停，授权已保留。') }
      }}>暂停全部 AI 接入</button>}
    </div>
    {conflict && <div role="alert">设置已在其他窗口更改。 <button className="small" onClick={() => { setDraft(undefined); setNotice('') }}>采用当前设置</button></div>}
    {notice && <div role="status">{notice}</div>}
    <ClientConnection config={settings.config} />
  </section>
}
