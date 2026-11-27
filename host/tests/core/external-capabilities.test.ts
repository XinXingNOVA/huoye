import { describe, expect, it, vi } from 'vitest'
import { LibraryCapabilities } from '../../src/core/capabilities'
import { invokeProvider } from '../../src/core/external-provider'
import { packageManifestSchema, packageInfo, type InstalledPackage } from '../../src/shared/external-plugins'
import type { AuthorContract } from '../../src/shared/capability-declarations'
import type { PluginInfo } from '../../src/shared/plugin-plan'

vi.mock('../../src/core/external-provider', () => ({ invokeProvider: vi.fn() }))

const id = 'folio/text.count@1'
const contract: AuthorContract = { id, source: 'none', input: { text: 'text' }, output: { count: 'number' } }
const manifest = packageManifestSchema.parse({ formatVersion: 1, apiVersion: 1, id: 'counter', title: 'Counter', description: '',
  author: 'test', version: '1.0.0', entries: { provider: 'provider.mjs' }, capabilities: { version: 1, contracts: [contract], provides: [id] } })
const pack: InstalledPackage = { manifest, directory: '/unused', hash: 'a'.repeat(64) }
const consumer: PluginInfo = { id: 'client', title: 'Client', description: '', capabilities: { version: 1, contracts: [contract], consumes: [id] } }
const preferences = { [id]: manifest.id }

describe('外部能力装配', () => {
  it('包选择和仓库快照同时命中才就绪；同名的不同契约不执行', () => {
    const bus = (plugins: PluginInfo[], packages = [pack]) => new LibraryCapabilities(plugins, {}, undefined, { preferences, packages })
    expect(bus([consumer, packageInfo(pack)]).inspect(id).state).toBe('ready')
    expect(bus([consumer, packageInfo(pack)], [{ ...pack, development: true }]).inspect(id).state).toBe('unavailable')
    expect(bus([consumer, packageInfo(pack)], [{ ...pack, hash: 'b'.repeat(64) }]).inspect(id).state).toBe('unavailable')
    expect(new LibraryCapabilities([consumer, packageInfo(pack)], {}, undefined, { packages: [pack] }).inspect(id).state).toBe('unavailable')
    const other = { ...consumer, capabilities: { ...consumer.capabilities!, contracts: [{ ...contract, source: 'file' as const }] } }
    expect(bus([other, packageInfo(pack)]).inspect(id)).toMatchObject({ state: 'unavailable', reason: expect.stringContaining('契约不一致') })
    const legacy = { ...consumer, capabilities: { version: 1 as const, consumes: [id] } }
    expect(bus([legacy, packageInfo(pack)]).inspect(id, legacy.id).state).toBe('unavailable')
  })
  it('按本库实际依赖选择唯一声明本地的引擎，多个实现交给用户选择', async () => {
    const second = 'other', signal = AbortSignal.timeout(3000)
    const local = (name: string, programs?: string[]): InstalledPackage => ({ ...pack,
      manifest: { ...manifest, id: name, capabilities: { version: 2, provides: [id], contracts: [contract],
        implementations: [{ id, execution: 'local', workload: programs ? 'heavy' : 'light', programs }] } } })
    const a = local(manifest.id), b = local(second), missing = local(second, ['absent-cli'])
    const acquire = vi.fn(async () => () => {})
    const client = { ...consumer, capabilities: { ...consumer.capabilities!, version: 2 as const } }
    const bus = (packages: InstalledPackage[], preferred?: string) => new LibraryCapabilities(
      [client, ...packages.map(p => packageInfo(p))], {}, acquire, { packages, programDirs: [], preferences: preferred ? { [id]: preferred } : {} })
    expect(bus([a, b]).inspect(id)).toMatchObject({ state: 'unavailable', reason: expect.stringContaining('选择') })
    expect(bus([missing]).inspect(id)).toMatchObject({ state: 'unavailable', reason: '找不到 absent-cli' })
    expect(bus([a, missing], second).inspect(id)).toMatchObject({ state: 'unavailable', provider: second })
    const auto = bus([a, missing])
    expect(auto.inspect(id)).toMatchObject({ state: 'ready', provider: manifest.id })
    vi.mocked(invokeProvider).mockResolvedValueOnce({ count: 3 })
    await auto.forJob(client.id, vi.fn(), signal, { allowed: [id], priority: 'interactive' }).run(id, { params: { text: 'abc' } })
    expect(vi.mocked(invokeProvider).mock.lastCall?.[2]).toEqual({ text: 'abc' })
    expect(acquire).toHaveBeenCalledWith(expect.anything(), 'interactive', 'light')
    const unrelated = { id: 'client.other', priority: 0, has: [], outputs: [], run: async () => ({}) }
    const uses = { ...unrelated, optionalCapabilities: [id] }
    const before = auto.fingerprint(auto.systemCapabilities(client.id, uses))
    const switched = bus([a, b], second)
    expect(switched.fingerprint(switched.systemCapabilities(client.id, uses))).not.toBe(before)
    expect(switched.fingerprint(switched.systemCapabilities(client.id, unrelated))).toBe(auto.fingerprint([]))
    await expect(auto.forJob(client.id, vi.fn(), signal, { allowed: [] }).run(id, { params: { text: 'abc' } }))
      .rejects.toThrow('CAPABILITY_UNDECLARED')
  })

  it('纯参数调用校验字段和返回值，回收计算名额，全程无需原件定位', async () => {
    const release = vi.fn(), resolve = vi.fn(), acquire = vi.fn(async () => release)
    const api = new LibraryCapabilities([consumer, packageInfo(pack)], {}, acquire, { packages: [pack], preferences })
      .forJob(consumer.id, resolve, new AbortController().signal)
    await expect(api.run(id, { id: 'extra-file', params: { text: 'abc' } })).rejects.toThrow('CAPABILITY_INVALID_INPUT')
    await expect(api.run(id, { params: { text: 'abc' } }, { maxEdge: 32 })).rejects.toThrow('CAPABILITY_INVALID_INPUT')
    expect(acquire).not.toHaveBeenCalled()
    vi.mocked(invokeProvider).mockResolvedValueOnce({ count: '3' }).mockResolvedValueOnce({ count: 3 })
    await expect(api.run(id, { params: { text: 'abc' } })).rejects.toThrow('CAPABILITY_INVALID_OUTPUT')
    await expect(api.run(id, { params: { text: 'abc' } })).resolves.toEqual({ count: 3 })
    expect(release).toHaveBeenCalledTimes(2)
    expect(resolve).not.toHaveBeenCalled()
  })
})

it('可选本地值计算按消费端契约路由，未安装、违规输入和输出分别可识别', async () => {
  const client = { ...consumer, capabilities: { version: 2 as const, contracts: [contract], optionalConsumes: [id] } }
  const engine = { ...pack, manifest: packageManifestSchema.parse({ ...manifest, entries: { service: 'service.mjs' },
    capabilities: { version: 2, contracts: [contract], provides: [id], implementations: [{ id, execution: 'local', via: 'service', workload: 'light' }] } }) }
  const signal = new AbortController().signal
  const missing = new LibraryCapabilities([client], {})
  expect(missing.inspectValue(client.id, id).state).toBe('unavailable')
  await expect(missing.readValue(client.id, id, { text: 'abc' }, signal)).rejects.toThrow('CAPABILITY_UNAVAILABLE')
  const resident = vi.fn().mockResolvedValue({ count: 3 })
  const bus = new LibraryCapabilities([client, packageInfo(engine)], {}, undefined, { packages: [engine], resident })
  expect(bus.inspectValue(client.id, id)).toMatchObject({ state: 'ready', provider: manifest.id })
  await expect(bus.readValue('unknown', id, { text: 'abc' }, signal)).rejects.toThrow('CAPABILITY_UNDECLARED')
  await expect(bus.readValue(client.id, id, { count: 3 }, signal)).rejects.toThrow('CAPABILITY_INVALID_INPUT')
  expect(resident).not.toHaveBeenCalled()
  expect(await bus.readValue(client.id, id, { text: 'abc' }, signal)).toEqual({ count: 3 })
  resident.mockResolvedValueOnce({ count: 'three' })
  await expect(bus.readValue(client.id, id, { text: 'abc' }, signal)).rejects.toThrow('CAPABILITY_INVALID_OUTPUT')
})
