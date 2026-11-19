import type { EditChange, EditSession } from '../../plugin-api/ui/editing'

/** opt-in 的原生输入适配；程序化 change 仍是独立操作，不根据字符串相似度猜测意图。 */
export function bindSharedInput(element: HTMLInputElement | HTMLTextAreaElement, session: EditSession) {
  const source = crypto.randomUUID()
  let pending: Pick<EditChange, 'inputType' | 'before'> | undefined
  let composition: string | undefined
  const position = () => ({ start: element.selectionStart ?? 0, end: element.selectionEnd ?? 0 })
  const beforeInput = (event: Event) => {
    pending = { inputType: (event as InputEvent).inputType, before: position() }
  }
  const input = (event: Event) => {
    const type = (event as InputEvent).inputType || pending?.inputType || ''
    const hint = (pending || composition) ? { before: pending?.before ?? position(), source, inputType: type, after: position(), composition } : undefined
    session.change(element.value, hint)
    pending = undefined
  }
  const boundary = () => { pending = undefined; session.breakHistory() }
  const keydown = (raw: Event) => {
    const event = raw as KeyboardEvent
    if (!event.isComposing && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) boundary()
  }
  const compositionStart = () => { boundary(); composition = crypto.randomUUID() }
  const compositionEnd = () => {
    // 部分浏览器的最后 input 晚于 compositionend；先收齐最终字串，随后同值 input 不会再建历史。
    session.change(element.value, { source, inputType: 'insertCompositionText', before: position(), after: position(), composition })
    composition = undefined; boundary()
  }
  element.addEventListener('beforeinput', beforeInput)
  element.addEventListener('input', input)
  element.addEventListener('compositionstart', compositionStart)
  element.addEventListener('compositionend', compositionEnd)
  element.addEventListener('pointerdown', boundary)
  element.addEventListener('keydown', keydown)
  element.addEventListener('blur', boundary)
  return () => {
    element.removeEventListener('beforeinput', beforeInput)
    element.removeEventListener('input', input)
    element.removeEventListener('compositionstart', compositionStart)
    element.removeEventListener('compositionend', compositionEnd)
    element.removeEventListener('pointerdown', boundary)
    element.removeEventListener('keydown', keydown)
    element.removeEventListener('blur', boundary)
    boundary()
  }
}
