import { useCallback, useRef, useState } from 'react'
import { SettingGroup, SettingRow } from '../../plugin-api/ui/widgets'
import { useUiEffect } from '../../plugin-api/ui/hooks'
import type { ApplicationUiHost } from '../../plugin-api/ui/application'
import type { ManagementSettings } from '../../shared/application-management'

export function McpManagement({ host, section }: { host: ApplicationUiHost; section: 'libraries' | 'packages' | 'development' }) {
  const [state, setState] = useState<ManagementSettings>(), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const changing = useRef(false), generation = useRef(0)
  const load = useCallback(() => host.service('mcp', 'management', { action: 'list' }) as Promise<ManagementSettings>, [host])
  useUiEffect(display => {
    if (section === 'development') return
    let active = true
    const refresh = () => {
      if (changing.current) return
      const request = ++generation.current
      void load().then(s => { if (active && request === generation.current) { setState(s); setError('') } }, e => { if (active && request === generation.current) setError(String(e)) })
    }
    refresh(); display.onWindow('focus', refresh)
    return () => { active = false }
  }, [load, section])
  const change = async (input: object) => {
    if (changing.current) return
    changing.current = true; generation.current++; setBusy(true); setError('')
    try { setState(await host.service('mcp', 'management', input) as ManagementSettings) }
    catch (e) { setError(String(e)) }
    finally { changing.current = false; setBusy(false) }
  }
  if (section === 'development') return null
  const problem = error && <p className="plugin-warn" role="alert">{error}</p>
  if (!state) return <div>{problem || <p className="muted" role="status">正在读取许可…</p>}
    {error && <button className="small" disabled={busy} onClick={() => void change({ action: 'list' })}>重新读取</button>}</div>
  if (section === 'libraries') return <SettingGroup title="允许 AI 关联的文件空间">
    <SettingRow title="关联许可" description="AI 可将所选空间关联到仓库。原件更新和回收在各库的细项授权中设置。">
      <button className="small" disabled={busy} onClick={async () => {
        try { const root = await host.pickDirectory(); if (root) await change({ action: 'allow-space', root }) }
        catch (e) { setError(String(e)) }
      }}>选择已有空间…</button>
    </SettingRow>
    {state.spaces.map(s => <SettingRow key={s.id} title={s.name} description={s.root}>
      <button className="small" disabled={busy} onClick={() => void change({ action: 'remove-space', spaceId: s.id })}>取消关联许可</button>
    </SettingRow>)}
    {problem}
  </SettingGroup>
  const installed = state.packages.filter(p => p.installed)
  const pending = installed.filter(p => !p.allowed)
  return <>
    {problem}
    <SettingGroup title="AI 使用插件的许可" description="授信绑定到确切版本。AI 可以安装获准的包，并在有管理权限的仓库运行其代码。">
      <SettingRow title="本机已安装插件" description={`${installed.length - pending.length} / ${installed.length} 个版本已授信。新安装的版本单独授权。`}>
        <button className="small" disabled={busy || !pending.length}
          onClick={() => void change({ action: 'package-permissions', hashes: pending.map(p => p.hash), allowed: true })}>允许 AI 使用当前全部已安装版本</button>
      </SettingRow>
      {state.suites.map(suite => {
        const packages = installed.filter(p => suite.hashes.includes(p.hash))
        const missing = packages.filter(p => !p.allowed)
        return <SettingRow key={suite.id} title={suite.title + ' · ' + suite.version}
          description={packages.length ? `${packages.length - missing.length} / ${packages.length} 个已安装版本已授信。` : '尚无已安装版本。'}>
          <button className="small" aria-label={`允许 AI 使用${suite.title}的已安装版本`} disabled={busy || !missing.length}
            onClick={() => void change({ action: 'package-permissions', hashes: missing.map(p => p.hash), allowed: true })}>授信此套件</button>
        </SettingRow>
      })}
      <details className="mcp-versions">
        <summary>按插件版本授权<small className="muted">{state.packages.length} 个版本</small></summary>
        {!state.packages.length && <p className="muted">尚无已登记的插件包。</p>}
        {state.packages.map(p => <SettingRow key={p.hash} title={`${p.manifest.title} · ${p.manifest.version}`}
          description={<span title={p.hash}>
            {p.manifest.id} · {p.hash.slice(0, 12)}{p.bundled && ' · 应用随附'}{!p.installed && ' · 尚未安装'}
            {state.suites.filter(s => s.hashes.includes(p.hash)).map(s => ' · ' + s.title).join('')}
          </span>}>
          <label className="mcp-check"><input type="checkbox" aria-label={`允许 AI 使用 ${p.manifest.id} ${p.manifest.version}`}
            checked={p.allowed} disabled={busy || p.bundled}
            onChange={e => void change({ action: 'package-permission', hash: p.hash, allowed: e.target.checked })} />允许跨库使用</label>
        </SettingRow>)}
      </details>
    </SettingGroup>
    <SettingGroup title="安装请求" action={<button className="small" disabled={busy} onClick={() => void change({ action: 'list' })}>刷新待处理请求</button>}>
      {!state.installations.length && <p className="muted">没有待处理的安装请求。</p>}
      {state.installations.map(task => <div className="mcp-request" key={task.requestId}>
        <strong>{task.requestId}</strong>
        {task.preview.items.map(row => <p key={row.index} className="muted" title={row.hash}>{row.manifest?.title ?? row.file} {row.manifest?.version}{row.manifest?.author ? ` · ${row.manifest.author}` : ''} · {row.hash?.slice(0, 12)}{row.error ? ` · ${row.error}` : ''}</p>)}
        {task.error && <p className="plugin-warn">{task.error.includes('PACKAGE_APPROVAL_REQUIRED') ? '等待你批准本批插件，批准后 AI 可继续安装。' : task.error}</p>}
        <div className="mcp-actions"><button className="small" disabled={busy || !task.approvalRequired.length}
          onClick={() => void change({ action: 'approve-installation', requestId: task.requestId })}>{task.approvalRequired.length ? '允许安装并用于托管仓库' : '已许可，等待 AI 继续'}</button>
          <button className="small" disabled={busy} onClick={() => void change({ action: 'cancel-installation', requestId: task.requestId })}>取消请求</button></div>
      </div>)}
    </SettingGroup>
    {!!state.configurations.length && <SettingGroup title="未完成的插件调整">
      {state.configurations.map(task => <SettingRow key={task.requestId} title={task.requestId}
        description={`${task.root} · ${task.saved ? '配置已保存' : '待继续'}${task.error ? ' · ' + task.error : ''}`}>
        <button className="small" disabled={busy} onClick={() => void change({ action: 'cancel-configuration', requestId: task.requestId })}>取消后续调整</button>
      </SettingRow>)}
    </SettingGroup>}
  </>
}
