import { uiText } from '../../shared/i18n/interface-display'
import { isContentLocator } from '../../plugin-api/content-selection'
import type { ContentSelection, SelectionChannel } from '../../plugin-api/ui/selection-types'

/** 每个仓库工作台会话持有（含内容小窗）；租约隔离旧页回调，快照不随 DOM 选区或消费方变化。 */
export class ContentSelectionChannel implements SelectionChannel {
  private active?: string
  private serial = 0
  private value?: ContentSelection
  private owners = new Map<symbol, Parameters<SelectionChannel['register']>[0]>()
  private snapshots = new WeakMap<ContentSelection, symbol>()
  private listeners = new Set<() => void>()

  subscribe = (fn: () => void) => {
    this.listeners.add(fn)
    return () => { this.listeners.delete(fn) }
  }
  getSnapshot = () => this.value
  private emit() { this.listeners.forEach(fn => fn()) }

  activate(tab?: string) {
    if (tab === this.active) return
    this.active = tab
    for (const [key, owner] of this.owners) if (owner.tabId !== tab) this.owners.delete(key)
    this.clear()
  }
  clear = (id?: number) => {
    if (this.value && (id === undefined || this.value.id === id)) {
      this.value = undefined
      this.emit()
    }
  }
  valid = (value: ContentSelection) => {
    const token = this.snapshots.get(value), owner = token && this.owners.get(token)
    return !!owner && owner.tabId === this.active && owner.revision === value.revision
  }
  select = (value: ContentSelection, id: string) => {
    const token = this.snapshots.get(value)
    if (token && this.valid(value)) this.owners.get(token)?.select?.(id)
  }
  register: SelectionChannel['register'] = owner => {
    for (const [key, existing] of this.owners) {
      if (existing.tabId !== owner.tabId || existing.surfaceId !== owner.surfaceId) continue
      this.owners.delete(key)
      if (this.value && this.snapshots.get(this.value) === key) this.clear()
    }
    const token = Symbol()
    this.owners.set(token, { ...owner })
    const clear = () => { if (this.value && this.snapshots.get(this.value) === token) this.clear() }
    return {
      clear,
      dispose: () => { this.owners.delete(token); clear() },
      publish: input => {
        if (!this.owners.has(token) || owner.tabId !== this.active || input.sourceId !== owner.sourceId) return
        const rect = input.rect
        if (!input.text.trim() || input.text.length > 100000 || !isContentLocator(input.locator)
          || JSON.stringify(input.locator).length > 500000
          || ![rect.left, rect.top, rect.width, rect.height].every(Number.isFinite) || rect.width < 0 || rect.height < 0) {
          throw new Error(uiText("选区内容或位置无效／过大"))
        }
        const value: ContentSelection = structuredClone({ ...input, id: ++this.serial, tabId: owner.tabId, surfaceId: owner.surfaceId, revision: owner.revision })
        freeze(value)
        this.snapshots.set(value, token)
        this.value = value
        this.emit()
      }
    }
  }
}

function freeze(value: unknown) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return
  Object.values(value).forEach(freeze)
  Object.freeze(value)
}
