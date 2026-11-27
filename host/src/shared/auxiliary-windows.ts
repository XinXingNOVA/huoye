/** 附属画面共享所属仓库会话；不接受任意 URL 或插件脚本。 */
export type AuxiliaryKind = 'settings' | `content:${string}`
export interface WindowBounds { x: number; y: number; width: number; height: number }
export type ContentWindowMode = 'pinned' | 'minimal'
export interface ContentWindowState extends WindowBounds { pinned?: true; minimal?: true }
export interface AuxiliaryEvent { kind: AuxiliaryKind; type: 'close-request' | 'closed' | 'find' | 'focus' | 'bounds' | 'fullscreen'; bounds?: ContentWindowState; fullscreen?: boolean }
export interface AuxiliaryWindowBridge {
  prepare(kind: AuxiliaryKind, bounds?: Partial<ContentWindowState>): Promise<void>
  toggleMode(kind: `content:${string}`, mode: ContentWindowMode): Promise<void>
  show(kind: AuxiliaryKind): Promise<void>
  focus(kind: AuxiliaryKind | 'main'): Promise<void>
  close(kind: AuxiliaryKind): Promise<void>
  onDragCancel(listener: () => void): () => void
  onEvent(listener: (event: AuxiliaryEvent) => void): () => void
}
