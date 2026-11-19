import { afterEach, describe, expect, it } from 'vitest'
import { pomodoroPlugin } from '@test-plugins/pomodoro/core'
import { openHost } from '../helpers/helpers'

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).reverse().forEach(f => f()))
const fixture = () => {
  const h = openHost([pomodoroPlugin], { manifest: [{ id: 'pomodoro', title: '番茄钟', description: '' }] })
  cleanups.push(() => h.cleanup())
  return h
}
type Summary = {
  totalSessions: number; totalMinutes: number
  todaySessions: number; todayMinutes: number
  todayCompleted: number; todayInterrupted: number
  weekSessions: number; weekMinutes: number; weekCompleted: number
  recent: { id: string; label: string; minutes: number; startedAt: number; completed: boolean }[]
}
const summary = async (h: ReturnType<typeof fixture>) => (await h.host.api.executeQuery({ query: 'pomodoro.summary' })).result as Summary
const record = async (h: ReturnType<typeof fixture>, id: string, extra: Record<string, unknown> = {}) =>
  h.host.api.run('pomodoro', 'recordSession', { id, startedAt: Date.now(), plannedMinutes: 25, minutes: 25, label: '整理参考', completed: true, ...extra })

describe('番茄钟插件', () => {
  it('同一会话只记一次，完成与提前结束分开统计', async () => {
    const h = fixture()
    await record(h, 'session-0001')
    const replay = await record(h, 'session-0001') as { replayed?: boolean }
    expect(replay.replayed).toBe(true)
    await record(h, 'session-0002', { minutes: 12, completed: false, label: '被叫走' })

    const result = await summary(h)
    expect(result).toMatchObject({
      totalSessions: 2, totalMinutes: 37,
      todaySessions: 2, todayMinutes: 37,
      todayCompleted: 1, todayInterrupted: 1,
      weekSessions: 2, weekCompleted: 1
    })
    expect(result.recent.map(item => item.id).sort()).toEqual(['session-0001', 'session-0002'])
  })

  it('上周的记录计入总数但不计入今天和本周', async () => {
    const h = fixture()
    await record(h, 'session-old', { startedAt: Date.now() - 8 * 86400000, minutes: 5, completed: true })
    expect(await summary(h)).toMatchObject({ totalSessions: 1, todaySessions: 0, weekSessions: 0, weekCompleted: 0 })
  })

  it('可以删除单条记录，剩余统计随之更新', async () => {
    const h = fixture()
    await record(h, 'session-a001', { minutes: 25 })
    await record(h, 'session-b002', { minutes: 10 })
    await h.host.api.run('pomodoro', 'removeSession', { id: 'session-a001' })
    const result = await summary(h)
    expect(result).toMatchObject({ totalSessions: 1, totalMinutes: 10 })
    expect(result.recent.map(item => item.id)).toEqual(['session-b002'])
  })

  it('拒绝非法输入，清空后归零', async () => {
    const h = fixture()
    await expect(record(h, 'session-bad', { minutes: 0 })).rejects.toThrow()
    await expect(record(h, '', {})).rejects.toThrow()
    expect((await summary(h)).totalSessions).toBe(0)

    await record(h, 'session-0003')
    await h.host.api.run('pomodoro', 'clearLog', {})
    expect((await summary(h)).totalSessions).toBe(0)
  })
})
