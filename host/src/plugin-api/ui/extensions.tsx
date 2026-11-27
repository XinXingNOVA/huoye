import { uiText } from '../../shared/i18n/interface-display'
import { Component, type ReactNode } from 'react'
import type { UiExtension, UiExtensions } from './extension-types'
export type { UiExtension, UiExtensionPoint, UiExtensionContribution, UiExtensionDiagnostic, UiExtensions } from './extension-types'

/** host.saved-view-actions v1。宿主在用户选择时重新检查保存视图身份。 */
export interface SavedViewAction {
  readonly label: string
  run(context: { viewId: string; host: import('./contracts').UiHost }): void | Promise<void>
}

interface Props { extensions: UiExtensions; extension: UiExtension; children: ReactNode; fallback?: ReactNode }
class Boundary extends Component<Props, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch(error: Error) { this.props.extensions.reportFailure(this.props.extension, error, 'render') }
  render() {
    return this.state.failed ? (this.props.fallback ?? <p role="alert">{uiText("附加内容无法显示（")}{this.props.extension.pluginId}{uiText("）；可在插件设置查看原因。")}</p>) : this.props.children
  }
}
/** 每个贡献自己的渲染边界。动作错误另外使用 extensions.invoke；不会撤下提供方页面。 */
export function ExtensionBoundary(props: Props) {
  return <Boundary key={`${props.extension.pluginId}:${props.extension.id}:${props.extension.point}:${props.extension.version}`} {...props}/>
}
