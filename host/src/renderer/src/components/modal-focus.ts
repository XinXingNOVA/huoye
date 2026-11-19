import { useUiEffect } from '../../../plugin-api/ui/hooks'
import type { RefObject } from 'react'

const focusable = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]'
const visible = (node: HTMLElement) => !!node.getClientRects().length && node.ownerDocument.defaultView!.getComputedStyle(node).visibility !== 'hidden' && !node.closest('[inert]')

/** 仅约束当前浮层的键盘焦点；允许后出现的确认框／菜单取得焦点。 */
export function useModalFocus(root: RefObject<HTMLElement | null>, enabled = true) {
  useUiEffect(display => {
    const dialog = root.current
    if (!enabled || !dialog) return
    const document = dialog.ownerDocument
    const previous = document.activeElement as HTMLElement | null
    const candidates = () => [...dialog.querySelectorAll<HTMLElement>(focusable)].filter(el => el.tabIndex >= 0 && visible(el))
    const focusFirst = () => (dialog.querySelector<HTMLElement>('input[type="search"]') ?? candidates()[0] ?? dialog).focus({ preventScroll: true })
    if (!dialog.contains(document.activeElement)) focusFirst()
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || event.isComposing) return
      const top = [...document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]')].filter(visible).at(-1)
      if (top !== dialog) return
      const current = document.activeElement
      // Portal 中的弹出菜单自行管理；不把它的 Tab 抢回父设置。
      if (current?.nodeType === 1 && !dialog.contains(current) && current.closest('.overlay')) return
      const nodes = candidates(), first = nodes[0], last = nodes.at(-1)
      if (!first) { event.preventDefault(); dialog.focus(); return }
      if (!dialog.contains(current) || (event.shiftKey ? current === first || current === dialog : current === last)) {
        event.preventDefault(); (event.shiftKey ? last! : first).focus()
      }
    }
    display.onDocument('keydown', keydown, true)
    return () => {
      const current = document.activeElement
      if (previous?.isConnected && (current === document.body || !current?.isConnected || dialog.contains(current))) previous.focus({ preventScroll: true })
    }
  }, [root, enabled])
}
