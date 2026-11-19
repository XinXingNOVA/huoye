import { useState } from 'react'
import { SettingGroup, SettingRow, useUiDocument } from '../../plugin-api/ui/widgets'
import { clientConfig } from './client-config'
import type { ApplicationMcpSettings } from './settings'

export function McpConnection({ settings, busy, toggle }: {
  settings: ApplicationMcpSettings; busy: boolean; toggle(enabled: boolean): void
}) {
  const doc = useUiDocument()
  const [format, setFormat] = useState<'json' | 'toml'>('json')
  const [expanded, setExpanded] = useState(false)
  const [notice, setNotice] = useState('')
  const snippet = clientConfig(settings.config, format)
  const projects = settings.creation?.autonomousDevelopment || settings.libraries.some(l => l.mode === 'admin' && l.projectToolchain)
  const tools = settings.developmentMode ? '日常、插件开发与验收' : projects ? '日常与插件开发' : '日常'
  const copy = async () => {
    try {
      await doc.defaultView!.navigator.clipboard.writeText(snippet)
      setNotice('配置已复制')
    } catch {
      setExpanded(true)
      setNotice('请在下方选中并复制配置')
    }
  }
  return <SettingGroup className="mcp-connection">
    <SettingRow title="应用 MCP 接入" description={settings.enabled ? `已开启 · 可用工具：${tools}` : '已暂停 · 已保存的授权可在恢复接入后使用'}>
      <label className="ob-switch"><input type="checkbox" aria-label="启用应用 MCP" checked={settings.enabled} disabled={busy}
        onChange={e => toggle(e.target.checked)} /><span className="ob-switch-slider" aria-hidden="true" /></label>
    </SettingRow>
    <SettingRow title="客户端连接配置" description="将配置添加到外部 AI 客户端。">
      <select className="select" aria-label="连接配置格式" value={format} onChange={e => {
        setFormat(e.target.value === 'toml' ? 'toml' : 'json')
        setNotice('')
      }}>
        <option value="json">通用 JSON</option><option value="toml">Codex TOML</option>
      </select>
      <button className="small" onClick={() => void copy()}>复制配置</button>
      <button className="small" aria-expanded={expanded} onClick={() => setExpanded(v => !v)}>{expanded ? '收起配置' : '查看配置'}</button>
    </SettingRow>
    {notice && <p className="mcp-feedback muted" role="status">{notice}</p>}
    {expanded && <textarea className="mcp-config" aria-label="MCP 客户端配置" readOnly value={snippet} spellCheck={false} onFocus={e => e.target.select()} />}
  </SettingGroup>
}
