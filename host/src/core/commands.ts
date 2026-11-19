import type { Command, CommandContext } from '../plugin-api/core/contracts'

/** 同步命令上下文只在本次调用内有效，预演和 MCP 也走相同边界。 */
export function invokeCommand(command: Command, context: CommandContext, args: Record<string, unknown>) {
  let active = true
  const scoped = Object.fromEntries(Object.entries(context).map(([name, fn]) => [name, (...values: unknown[]) => {
    if (!active) throw new Error('[COMMAND_CONTEXT_EXPIRED] 命令上下文已经结束')
    return (fn as (...args: unknown[]) => unknown)(...values)
  }])) as unknown as CommandContext
  try {
    const result = command(scoped, args)
    if (result && typeof (result as unknown as { then?: unknown }).then === 'function') {
      void Promise.resolve(result).catch(() => {})
      throw new Error('[INVALID_COMMAND] 命令必须同步执行')
    }
    return result
  } finally { active = false }
}
