import type { FC } from 'react'
import type { EntityView } from '../../shared/blocks'
import type { ContentLocator, ContentReference } from '../content-selection'
import type { PluginNeeds } from '../../shared/plugin-plan'
import type { UiHost } from './contracts'
export interface SelectionRect { left: number; top: number; width: number; height: number }
export interface ContentSelection extends ContentReference { id: number; tabId: string; surfaceId: string; revision: string; rect: SelectionRect }
export interface SelectionLease { publish(value: ContentReference & { rect: SelectionRect }): void; clear(): void; dispose(): void }
export interface SelectionChannel {
  subscribe(listener: () => void): () => void
  getSnapshot(): ContentSelection | undefined
  register(owner: { tabId: string; surfaceId: string; sourceId: string; revision: string; select?(id: string): void }): SelectionLease
  clear(id?: number): void
  valid(selection: ContentSelection): boolean
  select(selection: ContentSelection, id: string): void
}
export interface SelectionActionContext {
  host: UiHost
  /** 点击时的快照；焦点移到对话框后仍可用，切标签／来源内容变化后失效。 */
  selection: ContentSelection
  valid(): boolean
  select(id: string): void
}
export interface SelectionAction extends PluginNeeds {
  id: string; title: string; order: number
  when?(selection: ContentSelection, host: UiHost): boolean
  disabled?(selection: ContentSelection, host: UiHost): string | undefined
  run(context: SelectionActionContext): void | Promise<void>
}
export interface ContentLocation extends PluginNeeds {
  id: string; version: number
  match(source: EntityView): boolean
  open(reference: ContentReference, focus?: string): { tab: string; params: Record<string, unknown> } | undefined
}
export interface LocatedContent { status: 'found' | 'missing' | 'elsewhere' | 'unsupported'; rects: SelectionRect[] }
export interface SelectionSurfaceProps {
  host: UiHost; tabId: string; surfaceId: string; source: EntityView; revision: string; active: boolean
  root: HTMLElement; version?: unknown
  read(): { text: string; locator: ContentLocator; rect: SelectionRect } | undefined
  locate(reference: ContentReference): LocatedContent
  reveal(reference: ContentReference): void
  selected?: string; select(id: string | undefined): void; revealId?: string; revealKey?: string
}
export interface SelectionLayer extends PluginNeeds { id: string; order: number; Component: FC<SelectionSurfaceProps> }
