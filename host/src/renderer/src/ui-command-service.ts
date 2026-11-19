import type { CommandContext, CommandContribution, CommandItem, CommandService, CommandSession } from '../../plugin-api/ui/commands'
import type { UiHost } from '../../plugin-api/ui/contracts'

export type RuntimeCommand = CommandContribution & { pluginId?: string }
interface CapturedCommands {
  context: CommandContext
  host: UiHost
  /** 必须检查来源，不得把不存在的来源换成当前页面。 */
  validate(command: RuntimeCommand): Promise<void>
  collect(ids?: readonly string[]): Promise<RuntimeCommand[]>
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) }
  return value
}
export class UiCommands implements CommandService {
  private disposed = false
  constructor(private capture: () => CapturedCommands, private execution = { busy: false }) {}
  createSession = (options?: { ids?: readonly string[] }): CommandSession => {
    const ids = options?.ids === undefined ? undefined : [...new Set(options.ids)]
    if (ids && (ids.length > 200 || ids.some(id => typeof id !== 'string' || !id || id.length > 300))) throw new Error('命令 ID 列表无效')
    if (this.disposed) throw new Error('命令服务已关闭')
    const captured = this.capture()
    const context = freeze(structuredClone(captured.context))
    let ended = false, generation = 0, commands: Promise<RuntimeCommand[]> | undefined
    const check = () => { if (ended || this.disposed) throw new Error('命令会话已结束') }
    const load = () => {
      check()
      if (!commands) {
        const ticket = generation
        commands = captured.collect(ids).then(rows => {
          if (ids) rows = rows.filter(c => ids.includes(c.id))
          check()
          if (ticket !== generation) throw new Error('命令列表已更新，请使用最新结果')
          const seen = new Set<string>()
          for (const c of rows) { if (seen.has(c.id)) throw new Error(`命令 ID 重复：${c.id}`); seen.add(c.id) }
          return rows
        }).catch(e => { if (ticket === generation) commands = undefined; throw e })
      }
      return commands
    }
    const info = (c: RuntimeCommand): CommandItem | undefined => {
      if (c.when && !c.when(context)) return
      const enabled = c.enabled?.(context) ?? true
      return { id: c.id, title: c.title, category: c.category ?? '', keywords: c.keywords && [...c.keywords], accelerator: c.accelerator,
        danger: c.danger, pluginId: c.pluginId, enabled: enabled === true, disabledReason: typeof enabled === 'string' ? enabled : enabled ? undefined : '当前不可用' }
    }
    const list = async (search = '') => {
      const rows = await load(); check()
      const terms = search.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
      return rows.flatMap(c => {
        let item: CommandItem | undefined
        try { item = info(c) } catch { item = { id: c.id, title: c.title, category: c.category ?? '', pluginId: c.pluginId, enabled: false, disabledReason: '命令状态检查失败' } }
        if (!item) return []
        const text = [item.title, item.category, ...(item.keywords ?? [])].join(' ').toLocaleLowerCase()
        return terms.every(t => text.includes(t)) ? [item] : []
      })
    }
    return {
      context, list,
      refresh: () => { check(); generation++; commands = undefined; return list() },
      execute: async id => {
        check()
        if (this.execution.busy) throw new Error('已有命令正在执行，请稍候')
        this.execution.busy = true
        try {
          const command = (await load()).find(c => c.id === id)
          check()
          if (!command) throw new Error('命令不存在，请刷新列表')
          await captured.validate(command)
          check()
          const available = info(command)
          if (!available?.enabled) throw new Error(available?.disabledReason ?? '命令已不适用')
          await command.run(context, captured.host)
        } finally { this.execution.busy = false }
      },
      dispose: () => { ended = true; generation++; commands = undefined }
    }
  }
  dispose() { this.disposed = true }
}
