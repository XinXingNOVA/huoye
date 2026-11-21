import { uiText, useUiLocale } from '../../shared/i18n/interface-display'
import { useState } from 'react'
import { SettingGroup, SettingRow, useUiDocument } from '../../plugin-api/ui/widgets'
import { clientConfig } from './client-config'
import type { ApplicationMcpSettings } from './settings'

export function McpConnection({ settings, busy, toggle }: {
  settings: ApplicationMcpSettings; busy: boolean; toggle(enabled: boolean): void
}) {
  useUiLocale()
  const doc = useUiDocument()
  const [format, setFormat] = useState<'json' | 'toml'>('json')
  const [expanded, setExpanded] = useState(false)
  const [notice, setNotice] = useState('')
  const snippet = clientConfig(settings.config, format)
  const projects = settings.creation?.autonomousDevelopment || settings.libraries.some(l => l.mode === 'admin' && l.projectToolchain)
  const tools = settings.developmentMode ? uiText("日常、插件开发与验收") : projects ? uiText("日常与插件开发") : uiText("日常")
  const copy = async () => {
    try {
      await doc.defaultView!.navigator.clipboard.writeText(snippet)
      setNotice(uiText("配置已复制"))
    } catch {
      setExpanded(true)
      setNotice(uiText("请在下方选中并复制配置"))
    }
  }
  return <SettingGroup className="mcp-connection">
    <SettingRow title={uiText("应用 MCP 接入")} description={settings.enabled ? uiText("已开启 · 可用工具：{tools}", { tools }) : uiText("已暂停 · 已保存的授权可在恢复接入后使用")}>
      <label className="ob-switch"><input type="checkbox" aria-label={uiText("启用应用 MCP")} checked={settings.enabled} disabled={busy}
        onChange={e => toggle(e.target.checked)} /><span className="ob-switch-slider" aria-hidden="true" /></label>
    </SettingRow>
    <SettingRow title={uiText("客户端连接配置")} description={uiText("将配置添加到外部 AI 客户端。")}>
      <select className="select" aria-label={uiText("连接配置格式")} value={format} onChange={e => {
        setFormat(e.target.value === 'toml' ? 'toml' : 'json')
        setNotice('')
      }}>
        <option value="json">{uiText("通用 JSON")}</option><option value="toml">Codex TOML</option>
      </select>
      <button className="small" onClick={() => void copy()}>{uiText("复制配置")}</button>
      <button className="small" aria-expanded={expanded} onClick={() => setExpanded(v => !v)}>{expanded ? uiText("收起配置") : uiText("查看配置")}</button>
    </SettingRow>
    {notice && <p className="mcp-feedback muted" role="status">{notice}</p>}
    {expanded && <textarea className="mcp-config" aria-label={uiText("MCP 客户端配置")} readOnly value={snippet} spellCheck={false} onFocus={e => e.target.select()} />}
  </SettingGroup>
}
