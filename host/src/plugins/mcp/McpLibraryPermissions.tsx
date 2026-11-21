import { uiText, useUiLocale } from '../../shared/i18n/interface-display'
import { useState } from 'react'
import { SettingRow } from '../../plugin-api/ui/widgets'
import type { ApplicationUiHost } from '../../plugin-api/ui/application'
import type { ApplicationAccessChange } from '../../shared/application-access'
import type { ApplicationMcpSettings, McpMode } from './settings'
import { McpSpacePermissions } from './McpSpacePermissions'
import { McpDevelopment } from './McpDevelopment'

const modeDescription: Record<McpMode, string> = {
  get off() { return uiText("外部 AI 无法访问此库。") },
  get read() { return uiText("可检索素材、看预览、读取工作台选区与验收单。") },
  get organize() { return uiText("可入库、编辑内容、推送结果，以及创建、确认和撤回验收单。") },
  get admin() { return uiText("可整理素材、配置分类与字段模板、启用获准插件并调整工作台布局。") }
}

export function McpLibraryPermissions({ host, library, current, enabled, busy, change, refresh }: {
  host: ApplicationUiHost; library: ApplicationMcpSettings['libraries'][number]; current?: boolean
  enabled: boolean; busy: boolean; change(input: ApplicationAccessChange): Promise<void>; refresh(): Promise<void>
}) {
  useUiLocale()
  const [expanded, setExpanded] = useState(false)
  return <div className={current ? 'mcp-grant is-current' : 'mcp-grant'} data-library-key={library.key}>
    <SettingRow title={<span className="mcp-grant-title"><strong>{library.name}</strong>
      {current && <span className="mcp-current-badge">{uiText("当前仓库")}</span>}
      <small className="muted">{library.open ? uiText("已打开") : uiText("未打开")}</small></span>}
      description={library.root}>
      <select className="select" aria-label={uiText("{name} 的 MCP 权限", { name: String(library.name) })} value={library.mode} disabled={busy}
        onChange={e => void change({ grant: { key: library.key, mode: e.target.value as McpMode } })}>
        <option value="off">{uiText("不允许访问")}</option><option value="read">{uiText("只读")}</option>
        <option value="organize">{uiText("整理素材")}</option><option value="admin">{uiText("管理仓库")}</option>
      </select>
      <button className="small" aria-label={uiText("{name} 的细项授权", { name: String(library.name) })} aria-expanded={expanded} onClick={() => setExpanded(v => !v)}>
        {expanded ? uiText("收起授权") : uiText("细项授权")}
      </button>
    </SettingRow>
    <div className="mcp-grant-details" hidden={!expanded}>
      <p className="muted">{modeDescription[library.mode]}</p>
      <h4>{uiText("文件空间授权")}</h4>
      <McpSpacePermissions host={host} library={library} expanded={expanded} enabled={enabled} busy={busy} change={change} />
      <h4>{uiText("本库开发与验收")}</h4>
      {(library.mode === 'admin' || library.projectToolchain) &&
        <label className="mcp-check"><input type="checkbox" aria-label={library.name + uiText(" 允许自主开发插件")}
          checked={!!library.projectToolchain} disabled={busy}
          onChange={e => void change({ grant: { key: library.key, mode: library.mode, autonomousDevelopment: e.target.checked } })} />{uiText("允许 AI 在此库创建、构建并运行插件")}</label>}
      <McpDevelopment host={host} library={library} disabled={busy} refresh={refresh} />
    </div>
  </div>
}
