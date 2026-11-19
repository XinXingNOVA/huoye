import { afterEach, expect, it, vi } from 'vitest'
import { createCoreClient } from '../../src/renderer/src/core-client'

afterEach(() => vi.useRealTimers())
function fixture() {
  vi.useFakeTimers()
  const port = { onmessage: null as ((event: { data: unknown }) => void) | null, onmessageerror: null,
    postMessage: vi.fn(), close: vi.fn() }
  const abort = new AbortController(), client = createCoreClient(port as unknown as MessagePort, abort.signal)
  return { client, port, abort, reply: (data: unknown) => port.onmessage!({ data }) }
}
it('后台退出立即拒绝在途和后续请求，不重复发送写入', async () => {
  const f = fixture(), read = f.client.listFileSpaces(), write = f.client.trash(['id'])
  const checked = Promise.all([expect(read).rejects.toThrow('LIBRARY_OFFLINE'), expect(write).rejects.toThrow('写入结果需重新核对')])
  f.abort.abort(); await checked
  await expect(f.client.listFileSpaces()).rejects.toThrow('LIBRARY_OFFLINE')
  expect(f.port.postMessage).toHaveBeenCalledTimes(2)
  expect(f.port.close).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(0)
})
it('读取超时结束等待，迟到响应被忽略；可显式重新读取', async () => {
  const f = fixture(), read = f.client.listFileSpaces(), checked = expect(read).rejects.toThrow('TIMEOUT')
  await vi.advanceTimersByTimeAsync(15000); await checked
  f.reply({ id: 1, result: ['late'] })
  const next = f.client.listFileSpaces(); f.reply({ id: 2, result: [] })
  await expect(next).resolves.toEqual([]); expect(vi.getTimerCount()).toBe(0)
})
it('正常错误结束读取；写入不会套用短读取超时', async () => {
  const f = fixture(), read = f.client.listFileSpaces(), checked = expect(read).rejects.toThrow('not found')
  f.reply({ id: 1, error: 'not found' }); await checked
  const write = f.client.trash(['id'])
  await vi.advanceTimersByTimeAsync(20000)
  f.reply({ id: 2, result: undefined }); await expect(write).resolves.toBeUndefined()
  expect(vi.getTimerCount()).toBe(0)
})
it('端口发送失败结束全部等待', async () => {
  const f = fixture()
  f.port.postMessage.mockImplementation(() => { throw new Error('port closed') })
  await expect(f.client.listFileSpaces()).rejects.toThrow('LIBRARY_OFFLINE')
  expect(vi.getTimerCount()).toBe(0)
})

it('同一轮相同分面共读一次，写入、查询范围变化和下一轮各自重读', async () => {
  const f = fixture()
  vi.useRealTimers()
  const read = () => f.client.facet('labels', 'name', { query: { role: 'browse' } })
  const a = read(), b = read()
  const scoped = f.client.facet('labels', 'name', { query: { ids: ['id'] } })
  const write = f.client.trash(['id']), afterWrite = read()
  await Promise.resolve()
  const next = read()
  expect(f.port.postMessage.mock.calls.map(([m]) => m.method)).toEqual(['facet', 'facet', 'trash', 'facet', 'facet'])
  f.reply({ id: 1, result: [{ value: 'A', count: 2 }] })
  for (const id of [2, 4, 5]) f.reply({ id, result: [] })
  f.reply({ id: 3, result: undefined })
  const first = await a
  first[0].count = 0
  expect(await b).toEqual([{ value: 'A', count: 2 }])
  await Promise.all([scoped, write, afterWrite, next])
})
