import { useState } from 'react'
import type { ApplicationSettingsProps } from '../../plugin-api/ui/application'
import { SettingGroup, SettingRow } from '../../plugin-api/ui/widgets'
import type { ApplicationAccessChange } from '../../shared/application-access'
import { McpManagement } from './McpManagement'
import { McpConnection } from './McpConnection'
import { McpLibraryPermissions } from './McpLibraryPermissions'
import { useMcpSettings } from './use-mcp-settings'

const tabs = [
  { id: 'libraries', title: '仓库与建库授权' },
  { id: 'packages', title: '插件包授信' },
  { id: 'development', title: '自主开发与验收' }
] as const

export function McpSettings({ host, windowLibrary }: ApplicationSettingsProps) {
  const { settings, busy, error, setError, save, refresh } = useMcpSettings(host.service)
  const [tab, setTab] = useState<typeof tabs[number]['id']>('libraries')
  const change = async (input: ApplicationAccessChange) => { await save(input) }
  const pick = async (makeChange: (path: string) => ApplicationAccessChange) => {
    try {
      const path = await host.pickDirectory()
      if (path) await change(makeChange(path))
    } catch (e) { setError(String(e)) }
  }
  if (!settings) return error ? <p role="alert">{error} <button className="small" onClick={() => void refresh()}>重新读取</button></p>
    : <p className="muted" role="status">正在读取 AI 接入设置…</p>

  const current = settings.libraries.find(l => l.libraryId === windowLibrary?.libraryId && l.root === windowLibrary.root)
  const others = settings.libraries.filter(l => l.key !== current?.key)
  const row = (library: typeof settings.libraries[number]) => <McpLibraryPermissions key={library.key}
    host={host} library={library} current={library.key === current?.key} enabled={settings.enabled} busy={busy} change={change} refresh={refresh} />
  const creation = settings.creation
  return <section className="mcp-settings" aria-label="AI 接入设置">
    <McpConnection settings={settings} busy={busy} toggle={enabled => void change({ enabled })} />
    {error && <p className="plugin-warn" role="alert">{error}</p>}
    <div className="settings-subnav" role="group" aria-label="AI 接入分类">
      {tabs.map(t => <button type="button" key={t.id} aria-pressed={tab === t.id} onClick={() => setTab(t.id)}>{t.title}</button>)}
    </div>
    <div className="mcp-panel" hidden={tab !== 'libraries'}>
      {current && <SettingGroup title="本窗口的仓库">{row(current)}</SettingGroup>}
      <SettingGroup title="允许 AI 新建仓库">
        <SettingRow title="建库位置" description={creation?.parent ?? '选择一个文件夹，允许 AI 在其中新建仓库。'}>
          <button className="small" disabled={busy} onClick={() => void pick(parent => ({
            creation: { ...creation, parent, mode: creation?.mode ?? 'organize' }
          }))}>{creation ? '更换位置…' : '选择允许的位置…'}</button>
          {creation && <button className="small" disabled={busy} onClick={() => void change({ creation: null })}>取消新建权限</button>}
        </SettingRow>
        {creation && <SettingRow title="新仓库的默认权限" description="仅影响以后新建的仓库。">
          <select className="select" aria-label="新建仓库的 MCP 权限" disabled={busy} value={creation.mode}
            onChange={e => void change({ creation: { parent: creation.parent, mode: e.target.value as typeof creation.mode } })}>
            <option value="read">新仓库只读</option><option value="organize">新仓库可整理</option><option value="admin">新仓库由 AI 托管</option>
          </select>
        </SettingRow>}
      </SettingGroup>
      {(others.length > 0 || !current) && <SettingGroup title={current ? '其他仓库' : '已登记仓库'}>
        {others.length ? others.map(row) : <p className="muted">尚无已登记仓库。</p>}
      </SettingGroup>}
    </div>
    {tab === 'development' && <>
      <SettingGroup title="自主开发插件">
        <SettingRow title="开发工具工程" description={settings.projectToolchain ?? '源码版使用宿主工具链。发行版可指定已安装开发依赖的工程。'}>
          <button className="small" disabled={busy} onClick={() => void pick(projectToolchain => ({ projectToolchain }))}>选择开发工具工程…</button>
        </SettingRow>
        <SettingRow title="新托管库允许自主开发插件" description={creation?.mode === 'admin'
          ? '以后新建的托管库可创建插件工程，并在本机运行构建和插件代码。'
          : '先在「仓库与建库授权」选择建库位置，并将默认权限设为管理仓库。'}>
          <label className="ob-switch"><input type="checkbox" aria-label="允许 AI 自主开发插件" disabled={busy || creation?.mode !== 'admin'}
            checked={!!creation?.autonomousDevelopment} onChange={e => creation?.mode === 'admin' && void change({
              creation: { ...creation, autonomousDevelopment: e.target.checked || undefined }
            })} /><span className="ob-switch-slider" aria-hidden="true" /></label>
        </SettingRow>
      </SettingGroup>
      <SettingGroup title="开发验收工具">
        <SettingRow title="开启开发与验收模式" description="让客户端发现开发来源、仓库重载和窗口截图工具。切换后请刷新工具列表或重连。">
          <label className="ob-switch"><input type="checkbox" aria-label="开启开发验收工具" checked={settings.developmentMode}
            disabled={busy} onChange={e => void change({ developmentMode: e.target.checked })} /><span className="ob-switch-slider" aria-hidden="true" /></label>
        </SettingRow>
        <SettingRow title="逐库许可" description="在仓库的细项授权中设置自主开发、允许的源码与验收截图。">
          <button className="small" onClick={() => setTab('libraries')}>管理仓库授权</button>
        </SettingRow>
      </SettingGroup>
    </>}
    <McpManagement host={host} section={tab} />
  </section>
}
