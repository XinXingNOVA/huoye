import { uiText } from '../../../shared/i18n/interface-display'
import { Component, type ContextType, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { UiDocumentContext } from '../../../plugin-api/ui/internal/document'
import { SurfaceSlotsContext } from '../surface-slots'

interface Props {
  slot?: string
  visible: boolean
  /** 明确保活的后台页面需在重开时提供能力；普通工具仍首次显示才挂载。 */
  mountWhenHidden?: boolean
  className: string
  children: ReactNode
}
/** 稳定 Portal 持有内容；插槽仅决定位置，失去插槽时转入隐藏停放区。 */
export class RetainedSurface extends Component<Props, { visited: boolean; doc: Document }> {
  static contextType = SurfaceSlotsContext
  declare context: ContextType<typeof SurfaceSlotsContext>
  state = { visited: this.props.visible || !!this.props.mountWhenHidden, doc: document }
  private node = document.createElement('div')
  private scroll = new Map<Element, [number, number]>()
  private pendingScroll = false
  private unsubscribe?: () => void
  static getDerivedStateFromProps(props: Props, state: { visited: boolean }) {
    return (props.visible || props.mountWhenHidden) && !state.visited ? { visited: true } : null
  }
  private remember() {
    if (this.pendingScroll || !this.node.isConnected || this.node.closest('[hidden]')) return
    this.scroll.clear()
    for (const el of [this.node, ...this.node.querySelectorAll('*')]) if (el.scrollTop || el.scrollLeft) this.scroll.set(el, [el.scrollTop, el.scrollLeft])
    this.pendingScroll = true
  }
  getSnapshotBeforeUpdate(previous: Props) {
    if (previous.visible && (previous.slot !== this.props.slot || previous.visible !== this.props.visible)) this.remember()
    return null
  }
  private beforeRemove = (element: HTMLElement) => {
    if (this.node.parentElement !== element) return
    this.remember()
    const parking = this.context!.target()
    if (parking && parking !== element) parking.appendChild(this.node)
    else this.node.remove()
  }
  private place = () => {
    this.node.className = this.props.className
    const parent = this.context!.target(this.props.slot)
    if (this.node.parentElement !== (parent ?? null)) {
      this.remember()
      if (parent) parent.appendChild(this.node)
      else this.node.remove()
      // 外层安放后，再让嵌套内容在真实尺寸下恢复滚动。
      if (this.state.doc !== this.node.ownerDocument) this.setState({ doc: this.node.ownerDocument })
      this.context!.refresh()
    }
    if (this.pendingScroll && this.props.visible && this.node.isConnected && !this.node.closest('[hidden]')) {
      for (const [el, [top, left]] of this.scroll) if (this.node.contains(el)) { el.scrollTop = top; el.scrollLeft = left }
      this.scroll.clear(); this.pendingScroll = false
    }
  }
  componentDidMount() {
    if (!this.context) throw new Error(uiText("内容承载缺少工作区宿主"))
    this.unsubscribe = this.context.subscribe({ beforeRemove: this.beforeRemove, refresh: this.place })
    this.place()
  }
  componentDidUpdate() { this.place() }
  componentWillUnmount() { this.unsubscribe?.(); this.node.remove(); this.scroll.clear() }
  render() { return this.state.visited ? createPortal(<UiDocumentContext.Provider value={this.state.doc}>{this.props.children}</UiDocumentContext.Provider>, this.node) : null }
}
