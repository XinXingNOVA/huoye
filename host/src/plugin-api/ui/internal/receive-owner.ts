import type { Query } from '../../../shared/query'
import type { ReceiveIntent, ReceiveDelivery, ViewReceiveBatch } from '../../../shared/transfer'

export type ContentDropOwner =
  | { kind: 'transient' }
  | { kind: 'view'; viewId(): string; signal: AbortSignal; hover(inside: boolean): void; batch(event: ViewReceiveBatch): void }
  | { kind: 'query'; capture(zone: string): { query: Query; title: string } }
  | { kind: 'items'; isCurrent(): boolean; capture(intent: ReceiveIntent): ReceiveDelivery }

const owners = new WeakMap<Element, ContentDropOwner>()
export function registerDropOwner(node: Element, owner: ContentDropOwner) {
  owners.set(node, owner)
  return () => { if (owners.get(node) === owner) owners.delete(node) }
}
export function contentDropOwner(element: Element | null): ContentDropOwner | undefined {
  for (let node = element; node; node = node.parentElement) {
    const owner = owners.get(node)
    if (owner) return owner
  }
}
