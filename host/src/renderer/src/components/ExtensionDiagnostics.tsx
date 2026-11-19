import { useSyncExternalStore } from 'react'
import type { UiHost } from '../plugin'

const phases = { resolve: '契约匹配', validate: '载荷校验', render: '界面渲染', action: '动作执行' }

/** 只在有问题时显示；按贡献来源定位，不把接收贡献的页面误认为故障插件。 */
export function ExtensionDiagnostics({ host }: { host: UiHost }) {
  const issues = useSyncExternalStore(host.extensions.subscribe, host.extensions.diagnostics)
  if (!issues.length) return null
  return <details className="ui-setting-group" data-extension-diagnostics>
    <summary>插件协作问题 · {issues.length}</summary>
    <p className="muted">本窗口的装配与运行问题；修正插件后应用并重新加载。</p>
    <ul>{issues.map((issue, i) => <li key={i}>
      <strong>{issue.pluginId}</strong> · {issue.id} → {issue.point} v{issue.version}（{phases[issue.phase]}）
      <p>{issue.message}</p>
    </li>)}</ul>
  </details>
}
