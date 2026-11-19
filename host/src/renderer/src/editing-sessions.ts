import { bindSharedInput } from './shared-input'
import { EditHistory } from './edit-history'
import type { EditChange, EditBase, EditCommit, EditSession, EditSnapshot, EditingSessions } from '../../plugin-api/ui/editing'
interface Recovery { base: EditBase; text: string }
const validBase = (v: any): v is EditBase => !!v && typeof v.text === 'string' && Number.isSafeInteger(v.revision) && v.revision >= 0

class Session implements EditSession {
  private state: EditSnapshot
  private listeners = new Set<() => void>()
  private history = new EditHistory()
  private timer?: ReturnType<typeof setTimeout>
  private pending?: Promise<void>
  private observed?: EditBase
  private composing = false
  private disposed = false
  constructor(initial: EditBase, private commit: EditCommit | undefined, private changed: () => void, restored?: Recovery) {
    this.state = { base: { ...initial }, text: initial.text, dirty: false, saving: false, canUndo: false, canRedo: false }
    if (restored) { this.state.base = restored.base; this.state.text = restored.text; this.state.dirty = restored.text !== restored.base.text; if (initial.revision > restored.base.revision) {
      if (!this.state.dirty || initial.text === restored.text) this.state = { ...this.state, base: { ...initial }, text: initial.text, dirty: false }
      else this.state.conflict = { ...initial }
    } }
  }
  bind(commit: EditCommit) { this.commit ??= commit }
  get bound() { return !!this.commit }
  snapshot = () => this.state
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private emit(patch: Partial<EditSnapshot>) {
    this.state = { ...this.state, ...patch, canUndo: this.history.canUndo, canRedo: this.history.canRedo }
    if (!this.disposed) { this.changed(); for (const l of this.listeners) l() }
  }
  observe(current: EditBase) {
    if (current.revision <= this.state.base.revision) return
    if (this.pending) { if (!this.observed || current.revision > this.observed.revision) this.observed = current; return }
    if (!this.state.dirty || current.text === this.state.text) {
      this.history.clear()
      this.emit({ base: { ...current }, text: current.text, dirty: false, conflict: undefined, error: undefined })
    } else this.emit({ conflict: { ...current } })
  }
  private schedule() {
    clearTimeout(this.timer)
    if (!this.disposed && this.state.dirty && !this.state.conflict) this.timer = setTimeout(() => { void this.save().catch(() => {}) }, 800)
  }
  breakHistory() {
    this.history.break()
    if (this.composing) { this.composing = false; this.schedule() }
  }
  change(text: string, input?: EditChange) {
    if (text === this.state.text) return
    this.history.record(this.state.text, text, input)
    this.composing = !!input?.composition
    this.emit({ text, dirty: text !== this.state.base.text, error: undefined })
    clearTimeout(this.timer)
    if (!this.composing) this.schedule()
  }
  undo() {
    if (this.composing) return
    const text = this.history.undo(this.state.text)
    if (text === undefined) return
    this.emit({ text, dirty: text !== this.state.base.text }); this.schedule()
  }
  redo() {
    if (this.composing) return
    const text = this.history.redo(this.state.text)
    if (text === undefined) return
    this.emit({ text, dirty: text !== this.state.base.text }); this.schedule()
  }
  async save(): Promise<void> {
    clearTimeout(this.timer)
    if (this.pending) { await this.pending; return this.save() }
    if (this.state.conflict) throw new Error('内容已被其他入口修改，请先处理草稿冲突')
    if (!this.state.dirty) return
    if (this.composing) throw new Error('请先完成输入法输入，再保存')
    if (!this.commit) throw new Error('此草稿尚未连接保存入口；可以复制或丢弃本机草稿')
    const commit = this.commit
    const { base, text } = this.state
    this.emit({ saving: true, error: undefined })
    this.pending = Promise.resolve().then(() => commit(base, text)).then(result => {
      if (!result.accepted) {
        this.emit({ conflict: result.current })
        throw new Error('内容已被其他入口修改，请先处理草稿冲突')
      }
      this.emit({ base: result.current, dirty: this.state.text !== result.current.text })
    }).catch(error => { this.emit({ error: String(error) }); throw error }).finally(() => {
      this.pending = undefined; this.emit({ saving: false })
      const observed = this.observed; this.observed = undefined
      if (observed) this.observe(observed)
    })
    await this.pending
    // 保存期间仍可输入；继续保存后续草稿，不把旧响应当成新内容。
    if (this.state.dirty && !this.composing) await this.save()
  }
  resolve(choice: 'remote' | 'draft') {
    if (!this.state.conflict || this.state.saving) return
    const base = this.state.conflict
    this.history.clear()
    const text = choice === 'remote' ? base.text : this.state.text
    this.emit({ base, text, dirty: text !== base.text, conflict: undefined, error: undefined }); this.schedule()
  }
  discard() {
    if (this.state.saving) return
    clearTimeout(this.timer)
    const base = this.state.conflict ?? this.state.base
    this.history.clear()
    this.emit({ base, text: base.text, dirty: false, conflict: undefined, error: undefined })
  }
  get unused() { return !this.listeners.size && !this.state.dirty && !this.state.saving && !this.state.conflict }
  dispose() { this.disposed = true; clearTimeout(this.timer); this.listeners.clear() }
}

/** 一窗口一份；React 卸载不结束草稿，不执行写入。只恢复未保存内容，撤销栈限本次运行。 */
export class EditSessions implements EditingSessions {
  private inputs = new WeakMap<Element, EditSession>()
  bindInput(element: HTMLInputElement | HTMLTextAreaElement, session: EditSession, options?: { syncChanges?: boolean }) {
    this.inputs.set(element, session)
    const unbind = options?.syncChanges ? bindSharedInput(element, session) : () => {}
    return () => { unbind(); if (this.inputs.get(element) === session) this.inputs.delete(element) }
  }
  handleHistory(element: Element | null, command: 'undo' | 'redo') {
    const session = element && this.inputs.get(element)
    if (!session) return false
    session[command](); return true
  }
  private sessions = new Map<string, Session>()
  private recovery: Record<string, Recovery> = Object.create(null)
  constructor(private changed: () => void = () => {}) {}
  restore(value: unknown) {
    if (!value || typeof value !== 'object') return
    for (const [key, entry] of Object.entries(value)) {
      if (entry && validBase(entry.base) && typeof entry.text === 'string' && key.includes(':')) this.recovery[key] = entry
    }
  }
  export() {
    const result = { ...this.recovery }
    for (const [key, s] of this.sessions) { const v = s.snapshot(); if (v.dirty || v.conflict) result[key] = { base: v.base, text: v.text }; else delete result[key] }
    return result
  }
  open(key: string, initial: EditBase, commit: EditCommit) {
    if (!key.includes(':') || !validBase(initial)) throw new Error('无效的编辑会话身份或基线')
    let s = this.sessions.get(key)
    if (!s) {
      // 干净且没有观察者的历史会话只留最近一小批；脏草稿永不按缓存淘汰。
      for (const [id, old] of this.sessions) {
        if (this.sessions.size < 64) break
        if (old.unused) { old.dispose(); this.sessions.delete(id) }
      }
      s = new Session(initial, commit, this.changed, this.recovery[key]); this.sessions.set(key, s); delete this.recovery[key] }
    s.bind(commit)
    return s
  }
  get(key: string) {
    let s = this.sessions.get(key)
    const recovery = this.recovery[key]
    if (!s && recovery) { s = new Session(recovery.base, undefined, this.changed, recovery); this.sessions.set(key, s); delete this.recovery[key] }
    return s
  }
  async flush() { for (const s of this.sessions.values()) if (s.bound) await s.save() }
  dispose() { for (const s of this.sessions.values()) s.dispose() }
}
