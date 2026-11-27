import { describe, expect, it, vi } from 'vitest'
import { LibraryCapabilities } from '../../src/core/capabilities'
import { capabilityDeclarationsSchema } from '../../src/shared/capability-declarations'
import { packageManifestSchema } from '../../src/shared/external-plugins'
import type { PluginInfo } from '../../src/shared/plugin-plan'

const name = 'media.inspect@1'
const consumer: PluginInfo = { id: 'consumer', title: '播放器', description: '', capabilities: { version: 1, consumes: [name] } }
const source = { id: 'track', fileSeq: 1 }

describe('能力声明与调用边界', () => {
  it('旧包可读取，同一新包可同时提供与消费，未版本化或重复的名字拒绝', () => {
    const pack = { id: 'sample', title: '样例', author: 'test', version: '1.0.0', description: '', apiVersion: 1, formatVersion: 1, entries: { service: 'service.mjs' } }
    expect(packageManifestSchema.parse(pack).capabilities).toBeUndefined()
    const capabilities = { version: 1, provides: ['studio/sound.peaks@1'], consumes: [name] }
    expect(packageManifestSchema.parse({ ...pack, capabilities }).capabilities).toEqual(capabilities)
    for (const consumes of [[name, name], ['media.inspect'], []]) {
      expect(capabilityDeclarationsSchema.safeParse({ version: 1, consumes }).success).toBe(false)
    }
  })

  it('调用身份与输入先于原件定位，返回前再次核对版本并校验 Provider 结果', async () => {
    const execute = vi.fn(async () => ({ tags: {}, tracks: [] }))
    const bus = new LibraryCapabilities([consumer], { [name]: { id: 'fixture', execute } })
    const current = vi.fn(() => '/accepted/version')
    const lifetime = new AbortController()
    const caller = bus.forJob(consumer.id, current, lifetime.signal)
    expect(caller.inspect(name)).toMatchObject({ state: 'ready', provider: 'fixture' })
    await expect(bus.forJob('other', current, lifetime.signal).run(name, source)).rejects.toThrow('CAPABILITY_UNDECLARED')
    await expect(caller.run(name, { ...source, path: '/other' } as typeof source)).rejects.toThrow('CAPABILITY_INVALID_INPUT')
    expect(current).not.toHaveBeenCalled()
    current.mockReturnValueOnce('/accepted/version').mockImplementationOnce(() => { throw Error('版本已变化') })
    await expect(caller.run(name, source)).rejects.toThrow('版本已变化')
    execute.mockResolvedValueOnce({ tags: {}, tracks: 'invalid' } as never)
    await expect(caller.run(name, source)).rejects.toThrow('CAPABILITY_INVALID_OUTPUT')
    lifetime.abort()
    await expect(caller.run(name, source)).rejects.toThrow()
    expect(execute).toHaveBeenCalledTimes(2)
  })
})

it('Provider 必须返回所选轨道和请求范围内的波形，按调用取消不会交付迟到的结果', async () => {
  const id = 'audio.waveform@1'
  const job = new AbortController(), call = new AbortController()
  const input = { ...source, track: 2, maxPeaks: 2 }
  const wave = { track: 2, bucketSeconds: 1, peaks: [0, 1] }
  const execute = vi.fn(async () => wave)
  const plugin = { ...consumer, capabilities: { version: 1 as const, consumes: [id] } }
  const bus = new LibraryCapabilities([plugin], { [id]: { id: 'test', execute } })
  const ctx = bus.forJob(plugin.id, () => '/accepted/file', job.signal)
  execute.mockResolvedValueOnce({ ...wave, track: 1 })
  await expect(ctx.run(id, input)).rejects.toThrow('CAPABILITY_INVALID_OUTPUT')
  execute.mockResolvedValueOnce({ ...wave, peaks: [0, 1, 0] })
  await expect(ctx.run(id, input)).rejects.toThrow('CAPABILITY_INVALID_OUTPUT')
  execute.mockImplementationOnce(async () => { call.abort(); return wave })
  await expect(ctx.run(id, input, { signal: call.signal })).rejects.toThrow()
  await expect(ctx.run(id, input)).resolves.toEqual(wave)
})
