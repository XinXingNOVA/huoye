import { z } from 'zod'
import type { Command } from './contracts'

const input = z.object({
  id: z.string().min(1), hash: z.string().min(1), session: z.string().min(1).max(100),
  sessionStarted: z.number().finite().nonnegative(), lastPlayed: z.number().finite().nonnegative(),
  position: z.number().finite().nonnegative(), finished: z.boolean()
}).strict()

/** 复用事务内的记录算法，不注册数据定义或插件。调用者提供自己的块和命令入口。 */
export function playbackCommand(mediaKind: string, recordKind: string): Command {
  return (ctx, raw) => {
    const v = input.parse(raw), result = { label: '保存播放记录' }
    if (!ctx.query({ ids: [v.id], scope: 'all' }).ids.length) return result
    const blocks = ctx.blocksOf(v.id), old = blocks[recordKind]?.data
    // 迟到的旧文件／旧播放会话不能覆盖新会话；暂停后重复卸载不重复计次。
    if (!blocks[mediaKind] || blocks.file?.data.hash !== v.hash || v.lastPlayed < v.sessionStarted ||
        Number(old?.lastPlayed ?? -1) >= v.lastPlayed || Number(old?.sessionStarted ?? -1) > v.sessionStarted) return result
    const { id: _id, hash: _hash, ...record } = v
    ctx.put(v.id, recordKind, { ...record, plays: Number(old?.plays ?? 0) + (old?.session === v.session ? 0 : 1) })
    return result
  }
}
