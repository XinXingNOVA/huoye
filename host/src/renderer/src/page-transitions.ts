/** 页面结束协调，不依赖 React 实例。暂时卸载界面不会进入这里。 */
export class PageTransitions {
  private phase: 'idle' | 'saving' | 'prepared' = 'idle'
  private task?: Promise<boolean>
  private controller?: AbortController
  constructor(private changed: (busy: boolean) => void) {}
  get busy() { return this.phase !== 'idle' }
  get prepared() { return this.phase === 'prepared' }

  change(prepare: (signal: AbortSignal) => Promise<void>, commit: () => void): Promise<boolean> {
    if (this.busy) return Promise.resolve(false)
    return this.run(prepare, commit, false)
  }
  async finish(prepare: (signal: AbortSignal) => Promise<void>): Promise<void> {
    if (this.task) { await this.task; return this.finish(prepare) }
    if (this.prepared) return
    await this.run(prepare, () => {}, true)
  }
  resume(): void {
    this.controller?.abort(new Error('操作已取消，页面已保留'))
    this.phase = 'idle'
    this.changed(false)
  }
  private run(prepare: (signal: AbortSignal) => Promise<void>, commit: () => void, hold: boolean): Promise<boolean> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('页面保存超过 30 秒，请检查后重试')), 30000)
    this.controller = controller
    this.phase = 'saving'
    this.changed(true)
    const aborted = new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true }))
    const task = (async () => {
      try {
        await Promise.race([Promise.resolve().then(() => { controller.signal.throwIfAborted(); return prepare(controller.signal) }), aborted])
        controller.signal.throwIfAborted()
        commit()
        this.phase = hold ? 'prepared' : 'idle'
        return true
      } finally {
        clearTimeout(timer)
        if (this.controller === controller) {
          this.controller = undefined
          this.task = undefined
          if (this.phase === 'saving') this.phase = 'idle'
          this.changed(this.busy)
        }
      }
    })()
    this.task = task
    return task
  }
}
