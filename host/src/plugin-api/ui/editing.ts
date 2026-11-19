/** 仓库窗口内的共享文字草稿；key 必须为插件命名空间＋内容身份，不是页面 ID。 */
export interface EditBase { text: string; revision: number }
export interface EditSnapshot {
  base: EditBase
  text: string
  dirty: boolean
  saving: boolean
  error?: string
  conflict?: EditBase
  canUndo: boolean
  canRedo: boolean
}
/** accepted=false 时返回当前权威版本；保存必须在后端原子比较 revision。 */
export type EditCommit = (base: EditBase, text: string) => Promise<{ accepted: boolean; current: EditBase }>
/** 可选的输入意图；不提供时每次 change 作为独立编辑，适合程序化替换。 */
export interface EditChange {
  source: string
  inputType: string
  before: { start: number; end: number }
  after: { start: number; end: number }
  /** 一次输入法组合过程的稳定身份，不同确认不得复用。 */
  composition?: string
}
export interface EditSession {
  snapshot(): EditSnapshot
  subscribe(listener: () => void): () => void
  observe(current: EditBase): void
  change(text: string, input?: EditChange): void
  /** 移动光标、失焦等显式编辑边界；不触发保存。 */
  breakHistory(): void
  undo(): void
  redo(): void
  save(): Promise<void>
  /** 仅丢弃本机未保存草稿；保存飞行中不执行。 */
  discard(): void
  /** 显式选择远端，或保留草稿并以已看到的远端为新基线（之后仍做条件保存）。 */
  resolve(choice: 'remote' | 'draft'): void
}
export interface EditingSessions {
  /** 将原生菜单撤销／重做路由到焦点输入框的共享历史；卸载时解绑。 */
  bindInput(element: HTMLInputElement | HTMLTextAreaElement, session: EditSession, options?: {
    /** 原生 input/beforeinput/输入法事件直接更新会话并合并历史；默认只路由菜单。 */
    syncChanges?: boolean
  }): () => void
  open(key: string, initial: EditBase, commit: EditCommit): EditSession
  get(key: string): EditSession | undefined
}
