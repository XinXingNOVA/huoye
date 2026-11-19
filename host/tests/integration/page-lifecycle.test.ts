import { afterEach, expect, it, vi } from 'vitest'
import { PageTransitions } from '../../src/renderer/src/page-transitions'
import { savePdfReading, type PdfState } from '../../src/plugins/pdf/reading'
import type { TabLeaveContext } from '../../src/plugin-api/ui/contracts'

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes }); return { promise, resolve } }
afterEach(() => vi.useRealTimers())

it('结束回调成功才移除页面；准备时不重入，退出等待进行中的保存，恢复后可继续操作', async () => {
  const changed = vi.fn(), lifecycle = new PageTransitions(changed), save = deferred(), commit = vi.fn()
  const close = lifecycle.change(() => save.promise, commit)
  expect(lifecycle.busy).toBe(true)
  expect(commit).not.toHaveBeenCalled()
  expect(await lifecycle.change(async () => {}, commit)).toBe(false)
  const flushAll = vi.fn(async () => {})
  const quit = lifecycle.finish(flushAll)
  expect(flushAll).not.toHaveBeenCalled()
  save.resolve(); await close; await quit
  expect(commit).toHaveBeenCalledTimes(1)
  expect(flushAll).toHaveBeenCalledTimes(1)
  expect(lifecycle.prepared).toBe(true)
  lifecycle.resume()
  expect(lifecycle.busy).toBe(false)
  expect(await lifecycle.change(async () => {}, commit)).toBe(true)
})

it('失败和超时保留页面；重试成功，取消后旧回调完成不能再移除页面', async () => {
  const lifecycle = new PageTransitions(() => {}), commit = vi.fn()
  await expect(lifecycle.change(async () => { throw new Error('保存失败') }, commit)).rejects.toThrow('保存失败')
  expect(commit).not.toHaveBeenCalled(); expect(lifecycle.busy).toBe(false)
  vi.useFakeTimers()
  const slow = deferred(), failed = lifecycle.change(() => slow.promise, commit)
  const failure = expect(failed).rejects.toThrow('超过 30 秒')
  await vi.advanceTimersByTimeAsync(30000); await failure
  slow.resolve(); await Promise.resolve()
  expect(commit).not.toHaveBeenCalled()
  expect(await lifecycle.change(async () => {}, commit)).toBe(true)
  const other = deferred(), ending = lifecycle.finish(() => other.promise)
  const cancelled = expect(ending).rejects.toThrow('取消')
  lifecycle.resume(); await cancelled; other.resolve(); await Promise.resolve()
  expect(lifecycle.prepared).toBe(false)
})

it('PDF 结束时取同内容视图中最近的阅读快照；写入失败可重试，当前视图不必仍挂载', async () => {
  const run = vi.fn(async () => {})
  const saved: PdfState = { id: 'book', hash: 'v1', page: 5, offset: .3, zoom: 'fit', lastRead: 20 }
  const context = { id: 'tab', params: { id: 'book' }, saved, otherViews: [{ id: 'other', params: { id: 'book' }, saved: { ...saved, page: 8, lastRead: 30 } }], host: { core: { run } }, reason: 'close', signal: new AbortController().signal } as unknown as TabLeaveContext<{ id: string }, PdfState>
  await savePdfReading({ ...context, reason: 'navigate', nextParams: { id: 'book' } })
  expect(run).not.toHaveBeenCalled()
  run.mockRejectedValueOnce(new Error('写入失败'))
  await expect(savePdfReading(context)).rejects.toThrow('写入失败')
  await savePdfReading(context)
  expect(run).toHaveBeenLastCalledWith('pdf', 'saveReading', { id: 'book', hash: 'v1', page: 8, offset: .3, lastRead: 30 })
  run.mockClear()
  await savePdfReading({ ...context, saved: undefined, otherViews: [] })
  expect(run).not.toHaveBeenCalled()
  const abort = new AbortController(); abort.abort()
  await expect(savePdfReading({ ...context, signal: abort.signal })).rejects.toThrow()
  expect(run).not.toHaveBeenCalled()
})
