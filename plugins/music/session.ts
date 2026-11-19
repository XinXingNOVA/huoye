export type PlayMode = 'sequence' | 'shuffle' | 'repeat'
export interface SavedSession { version: 1; queue: string[]; index: number; volume: number; mode: PlayMode; position: number }
export interface SessionState extends Omit<SavedSession, 'version' | 'position'> { playing: boolean; error?: string; generation: number }
export function readSession(raw: unknown): SavedSession {
  const v = raw && typeof raw === 'object' ? raw as Partial<SavedSession> : {}
  const queue = v.version === 1 && Array.isArray(v.queue) ? [...new Set(v.queue.filter((id): id is string => typeof id === 'string' && id.length > 0))].slice(0, 10000) : []
  return { version: 1, queue, index: Math.max(0, Math.min(queue.length - 1, Number.isInteger(v.index) ? v.index! : 0)),
    volume: typeof v.volume === 'number' && Number.isFinite(v.volume) ? Math.max(0, Math.min(1, v.volume)) : 0.75,
    mode: ['sequence', 'shuffle', 'repeat'].includes(v.mode ?? '') ? v.mode! : 'sequence',
    position: typeof v.position === 'number' && Number.isFinite(v.position) ? Math.max(0, v.position) : 0 }
}

/** 窗口级播放会话；持久快照不含 playing，重新打开必须保持暂停。 */
export class MusicSession {
  private listeners = new Set<() => void>()
  private clockListeners = new Set<() => void>()
  private state: SessionState
  private clock = { time: 0, duration: 0 }
  element: HTMLAudioElement | null = null
  autoplay = false
  resume: number
  private savedAt = 0
  constructor(raw: unknown, private save: (value: SavedSession) => void) {
    const v = readSession(raw)
    this.state = { queue: v.queue, index: v.index, mode: v.mode, volume: v.volume, playing: false, generation: 0 }
    this.resume = v.position
  }
  getSnapshot = () => this.state
  getClock = () => this.clock
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn) } }
  subscribeClock = (fn: () => void) => { this.clockListeners.add(fn); return () => { this.clockListeners.delete(fn) } }
  private patch(value: Partial<SessionState>) { this.state = { ...this.state, ...value }; this.listeners.forEach(fn => fn()) }
  persist = () => {
    this.savedAt = Date.now()
    if (this.element?.readyState) this.resume = this.element.currentTime
    this.save({ version: 1, queue: this.state.queue, index: this.state.index, mode: this.state.mode, volume: this.state.volume,
      position: this.resume })
  }
  tick = () => {
    const el = this.element
    if (!el) return
    const time = Number.isFinite(el.currentTime) ? el.currentTime : 0
    const duration = Number.isFinite(el.duration) ? el.duration : 0
    if (time !== this.clock.time || duration !== this.clock.duration) {
      this.clock = { time, duration }; this.clockListeners.forEach(fn => fn())
    }
    if (!el.paused && Date.now() - this.savedAt >= 5000) this.persist()
  }
  played = (playing: boolean) => { this.autoplay = playing; this.patch({ playing, ...(playing ? { error: undefined } : {}) }); this.persist() }
  fail = (error: string) => { this.element?.pause(); this.autoplay = false; this.patch({ playing: false, error }) }
  play = () => { if (this.element) void this.element.play().catch(() => this.fail('未能播放，请重试或检查音频格式')) }
  toggle = () => { if (this.element?.paused) this.play(); else this.element?.pause() }
  seek = (value: number) => { if (this.element && this.clock.duration > 0) { this.element.currentTime = Math.max(0, Math.min(this.clock.duration, value)); this.tick(); this.persist() } }
  volume = (value: number) => { this.patch({ volume: Math.max(0, Math.min(1, value)) }); if (this.element) this.element.volume = this.state.volume; this.persist() }
  mode = (mode: PlayMode) => { this.patch({ mode }); this.persist() }
  private start(index: number, queue = this.state.queue) {
    if (!queue[index]) return
    this.element?.pause(); this.element = null
    this.resume = 0; this.autoplay = true
    this.clock = { time: 0, duration: 0 }; this.clockListeners.forEach(fn => fn())
    this.patch({ queue, index, playing: false, error: undefined, generation: this.state.generation + 1 }); this.persist()
  }
  playQueue = (queue: string[], first: string) => {
    const unique = [...new Set(queue)].slice(0, 10000)
    const index = unique.indexOf(first)
    if (index >= 0) this.start(index, unique)
  }
  jump = (index: number) => this.start(index)
  next = (manual = true) => {
    const { queue, index, mode } = this.state
    if (!queue.length) return
    if (!manual && mode === 'repeat') { this.start(index); return }
    if (mode === 'shuffle' && queue.length > 1) { this.start((index + 1 + Math.floor(Math.random() * (queue.length - 1))) % queue.length); return }
    if (index + 1 < queue.length) this.start(index + 1)
    else if (manual) this.start(0)
    else {
      this.autoplay = false; this.resume = 0
      if (this.element) this.element.currentTime = 0
      this.tick(); this.patch({ playing: false }); this.persist()
    }
  }
  previous = () => this.start((this.state.index - 1 + this.state.queue.length) % this.state.queue.length)
  enqueue = (ids: string[], next = false) => {
    const current = this.state.queue[this.state.index]
    const fresh = [...new Set(ids)].filter(id => next ? id !== current : !this.state.queue.includes(id))
    const queue = next ? this.state.queue.filter(id => !fresh.includes(id)) : [...this.state.queue]
    const index = Math.max(0, queue.indexOf(current))
    queue.splice(next && queue.length ? index + 1 : queue.length, 0, ...fresh)
    if (queue.length > 10000) { this.fail('播放队列最多 10000 首'); return }
    this.patch({ queue, index }); this.persist()
  }
  remove = (index: number) => {
    const queue = this.state.queue.filter((_, i) => i !== index)
    if (index === this.state.index) {
      this.element?.pause(); this.element = null; this.resume = 0; this.autoplay = false
      this.clock = { time: 0, duration: 0 }; this.clockListeners.forEach(fn => fn())
      this.patch({ queue, index: Math.min(index, Math.max(0, queue.length - 1)), playing: false, error: undefined, generation: this.state.generation + 1 })
    } else this.patch({ queue, index: this.state.index - (index < this.state.index ? 1 : 0) })
    this.persist()
  }
  dispose = () => { this.persist(); this.element?.pause(); this.element = null }
}
