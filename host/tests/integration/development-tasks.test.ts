import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DevelopmentTasks } from '../../src/main/development-tasks'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
it('生命周期回执不重放旧动作，绑定参数和仓库；中断与落盘后失败保留事实', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rm-dev-tasks-')); dirs.push(dir)
  const pending: Promise<void>[] = [], tasks = new DevelopmentTasks(dir, p => { pending.push(p) })
  let finish!: () => void
  const run = vi.fn(async (saved: () => void) => { saved(); await new Promise<void>(r => { finish = r }); throw new Error('重载失败') })
  const input = { requestId: 'apply-first', libraryId: 'a', session: 'original' }
  expect(tasks.submit('apply_development_build', input, '/a', run).state).toBe('pending')
  await Promise.resolve()
  expect(tasks.read(input.requestId, 'a', '/a')).toMatchObject({ state: 'pending', running: true, saved: true })
  expect(tasks.submit('apply_development_build', input, '/a', run).state).toBe('pending')
  expect(() => tasks.submit('control_library', input, '/a', run)).toThrow('REQUEST_CONFLICT')
  expect(() => tasks.submit('apply_development_build', { ...input, requestId: 'apply-other' }, '/a', run)).toThrow('LIBRARY_BUSY')
  expect(() => tasks.read(input.requestId, 'a', '/another')).toThrow('ACCESS_DENIED')
  const restarted = new DevelopmentTasks(dir)
  expect(restarted.submit('apply_development_build', input, '/a', run)).toMatchObject({ state: 'interrupted', saved: true, running: false })
  expect(run).toHaveBeenCalledTimes(1)
  finish(); await Promise.all(pending)
  expect(tasks.read(input.requestId, 'a', '/a')).toMatchObject({ state: 'failed', saved: true, error: 'Error: 重载失败', running: false })
  const close = { requestId: 'close-once', libraryId: 'a', session: 'old' }, closeRun = vi.fn(async () => {})
  tasks.submit('control_library', close, '/a', closeRun); await Promise.all(pending)
  expect(new DevelopmentTasks(dir).submit('control_library', close, '/a', closeRun).state).toBe('completed')
  expect(closeRun).toHaveBeenCalledTimes(1)
  expect(() => tasks.submit('control_library', { ...close, session: 'new' }, '/a', closeRun)).toThrow('REQUEST_CONFLICT')
})
