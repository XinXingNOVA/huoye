import { LibraryCreations } from '../../src/main/library-creation-state'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ApplicationAccess, type ApplicationAccessAdapter, type ApplicationLibrary } from '../../src/main/application-access'
import { ServiceRuntime } from '../../src/main/service-runtime'
import type { ApplicationServiceContext, ExternalCaller } from '../../src/plugin-api/service'
import { plugin } from '../../src/plugins/mcp/application-service'
import { clientConfig } from '../../src/plugins/mcp/client-config'
import { callLocal, type Connection } from '../../src/plugins/mcp/local'
import { applicationTools } from '../../src/plugins/mcp/tools'
import { openLibrary as openCoreLibrary } from '../../src/core/library'
import { PLUGINS, APPLICATION_PLUGINS } from '../../src/plugins/manifest'

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
function fixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'rm-app-access-')))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const libraries: ApplicationLibrary[] = []
  const calls = vi.fn(async (id: string, method: string) => method === 'listFileSpaces' ? [] : method === 'describeLibrary' ? { libraryId: id, operations: [{ name: 'create_text', title: '创建文本', effect: 'data' }], queries: [{ name: 'demo.overview' }] } : { target: id, ok: true })
  let live = true, nextId = 0
  const adapter: ApplicationAccessAdapter = { userData: dir, catalog: () => [], active: () => live, libraries: () => libraries,
    open: vi.fn(async (root, expectedId) => {
      const existing = libraries.find(l => l.root === root)
      if (existing) return existing
      const id = expectedId ?? `library-${++nextId}`
      writeFileSync(join(root, 'library.db'), id)
      const lib: ApplicationLibrary = { id, root, active: () => libraries.includes(lib), call: ((method: string) => calls(id, method)) as ExternalCaller }
      libraries.push(lib); return lib
    }) }
  const jobs = new LibraryCreations(join(dir, 'library-creations'))
  adapter.creations = {
    preview: () => ({ selection: { disabled: [], external: [] }, revision: 'base', development: [], changes: [], issues: [], warnings: [], versions: [] }),
    prepare(input, external) {
      const root = join(input.parent, input.name)
      if (existsSync(root)) throw new Error('[TARGET_EXISTS] 已存在')
      if (jobs.list().some(j => j.root === root)) throw new Error('已有待接续任务')
      return jobs.write({ id: randomUUID(), libraryId: randomUUID(), root, name: input.name, external, selection: { disabled: [], external: [] } })
    },
    find: (namespace, requestId) => jobs.list(true).find(j => j.external?.namespace === namespace && j.external.requestId === requestId),
    read: id => jobs.read(id),
    async resume(id, guard) {
      const job = jobs.read(id)
      try {
        guard(); jobs.claim(job); jobs.write({ ...job, phase: 'claimed' })
        await adapter.open(job.root, job.libraryId, job.external!.background)
        guard()
        if (jobs.read(id).state === 'cancelled') throw new Error('CREATION_CANCELLED')
        jobs.write({ ...job, phase: 'assembled' }); jobs.finish(jobs.read(id))
      } catch (e) { jobs.write({ ...jobs.read(id), error: String(e) }); throw e }
    },
    cancel: id => { const job = jobs.read(id); if (job.state === 'pending') jobs.finish(job, 'cancelled') },
    inspect: async id => ({ running: false, runtime: { core: libraries.some(l => l.id === jobs.read(id).libraryId) ? 'running' : 'stopped', workbench: 'closed', visible: false } })
  }
  const access = new ApplicationAccess(adapter)
  return { dir, libraries, calls, adapter, access, jobs, stop: () => { live = false } }
}
async function grant(f: ReturnType<typeof fixture>, name: string, mode: 'off' | 'read' | 'organize' | 'admin') {
  const root = join(f.dir, name); mkdirSync(root)
  const lib = await f.adapter.open(root)
  f.access.register(lib)
  const key = f.access.settings().libraries.find(g => g.libraryId === lib.id)!.key
  f.access.settings({ enabled: true, grant: { key, mode } })
  return { lib, key }
}

describe('应用接入与仓库授权', () => {
  it('托管创建策略固定自主开发许可，按库撤权，重放建库不会恢复授权', async () => {
    const f = fixture(), { lib: old } = await grant(f, '已有库', 'admin')
    f.adapter.development = {
      resolveToolchain: path => path ?? f.dir, sources: () => ({ sources: [] }),
      execute: async (_action, _input, target, guard) => { guard(); return target.projectToolchain }
    }
    const policy = { parent: f.dir, mode: 'admin' as const, autonomousDevelopment: true }
    f.access.settings({ creation: policy })
    const input = { name: '新库', requestId: 'managed-projects' }
    const { libraryId } = await f.access.create(input)
    const key = f.access.settings().libraries.find(l => l.libraryId === libraryId)!.key
    expect(f.access.list().find(l => l.libraryId === libraryId)).not.toHaveProperty('projectToolchain')
    const project = { pluginId: 'demo', title: '演示', requestId: 'project-demo' }
    await expect(f.access.development('create_development_project', { libraryId: old.id, ...project })).rejects.toThrow('PROJECT_DENIED')
    f.access.settings({ creation: { parent: f.dir, mode: 'admin' } })
    expect(await f.access.development('create_development_project', { libraryId, ...project })).toBe(f.dir)
    await expect(f.access.development('control_library', { libraryId, session: randomUUID(), action: 'close', requestId: 'close-demo' })).rejects.toThrow('DEVELOPMENT_DISABLED')
    f.access.settings({ grant: { key, mode: 'organize' } })
    await expect(f.access.development('create_development_project', { libraryId, ...project })).rejects.toThrow('ADMIN_REQUIRED')
    f.access.settings({ grant: { key, mode: 'admin', autonomousDevelopment: false } })
    await f.access.create(input)
    await expect(f.access.development('create_development_project', { libraryId, ...project })).rejects.toThrow('PROJECT_DENIED')
    expect(() => f.access.settings({ creation: { ...policy, mode: 'read' } })).toThrow()
  })
  it('开发模式、逐库 admin、源码与截图许可独立检查；异步撤权即时阻断且远端不能自授权', async () => {
    const f = fixture(), { lib, key } = await grant(f, 'development', 'admin')
    const source = join(f.dir, 'source'), toolchain = join(f.dir, 'toolchain'); mkdirSync(source); mkdirSync(toolchain)
    const sourceId = 'a'.repeat(64)
    const execute = vi.fn<NonNullable<ApplicationAccessAdapter['development']>['execute']>(async (_action, _input, target, guard) => { guard(); return { sources: target.grant.sources } })
    f.adapter.development = { sources: () => ({ toolchain, sources: [{ key: sourceId, source, pluginId: 'demo', title: 'Demo' }] }), execute }
    const input = { libraryId: lib.id }
    await expect(f.access.development('get_development_status', input)).rejects.toThrow('DEVELOPMENT_DISABLED')
    f.access.settings({ developmentMode: true })
    await expect(f.access.development('get_development_status', input)).rejects.toThrow('DEVELOPMENT_DISABLED')
    await expect(f.access.setDevelopmentGrant({ key, enabled: true, capture: false, sourceIds: ['b'.repeat(64)] })).rejects.toThrow()
    await f.access.setDevelopmentGrant({ key, enabled: true, capture: false, sourceIds: [sourceId] })
    expect(await f.access.development('get_development_status', input)).toMatchObject({ sources: [{ source, pluginId: 'demo' }] })
    expect(f.access.list()[0]).not.toHaveProperty('development')
    const capture = { ...input, windowId: 'main', session: randomUUID(), windowRevision: 0 }
    await expect(f.access.development('capture_workbench_window', capture)).rejects.toThrow('CAPTURE_DENIED')
    f.access.settings({ grant: { key, mode: 'organize' } })
    await expect(f.access.development('get_development_status', input)).rejects.toThrow('ADMIN_REQUIRED')
    f.access.settings({ grant: { key, mode: 'admin' } })
    f.adapter.development.execute = async () => { f.access.settings({ developmentMode: false }); return { private: true } }
    await expect(f.access.development('get_development_status', input)).rejects.toThrow('DEVELOPMENT_DISABLED')
    f.access.settings({ developmentMode: true })
    f.adapter.development.execute = async (_action, _input, _target, guard) => {
      await f.access.setDevelopmentGrant({ key, enabled: true, capture: true, sourceIds: [] }); guard(); return null
    }
    await expect(f.access.development('get_development_status', input)).rejects.toThrow('DEVELOPMENT_CHANGED')
    const runtime = new ServiceRuntime<ApplicationServiceContext>([plugin], () => ({ access: f.access, executable: () => ({ command: 'test', args: [], env: {} }) }))
    cleanups.push(() => runtime.stop()); await runtime.start(new Set(['mcp']))
    const connection = JSON.parse(readFileSync(f.access.configFile, 'utf8')) as Connection
    await expect(callLocal(connection, 'setDevelopmentGrant', { key, enabled: true, capture: true, sourceIds: [] })).rejects.toThrow()
    f.access.settings({ developmentMode: false })
    await expect(callLocal(connection, 'get_development_status', input)).rejects.toThrow('DEVELOPMENT_DISABLED')
  })
  it('工作台读取/展示分别服从 read/organize，回传前及执行前检查撤权和核心失效', async () => {
    const f = fixture(), { lib, key } = await grant(f, 'session', 'read')
    const read = { action: 'read' as const, input: {} }
    const present = { action: 'present' as const, input: { requestId: 'session-present', expected: { sessionId: randomUUID(), contextRevision: '1', windowRevision: 0, tabId: 'tab' }, target: { action: 'reveal' as const, ids: ['a'] } } }
    lib.session = vi.fn(async (_input, guard) => { guard(); return { ready: true } })
    expect(await f.access.workbench(lib.id, read)).toEqual({ ready: true })
    await expect(f.access.workbench(lib.id, present)).rejects.toThrow('READ_ONLY')
    expect(lib.session).toHaveBeenCalledTimes(1)
    f.access.settings({ grant: { key, mode: 'organize' } })
    expect(await f.access.workbench(lib.id, present)).toEqual({ ready: true })
    lib.session = async (_input, guard) => { f.access.settings({ grant: { key, mode: 'read' } }); guard(); throw new Error('unreachable') }
    await expect(f.access.workbench(lib.id, present)).rejects.toThrow('READ_ONLY')
    lib.session = async () => { f.access.settings({ grant: { key, mode: 'off' } }); return { private: true } }
    await expect(f.access.workbench(lib.id, read)).rejects.toThrow('ACCESS_DENIED')
    f.access.settings({ grant: { key, mode: 'read' } }); lib.active = () => false
    await expect(f.access.workbench(lib.id, read)).rejects.toThrow('WORKBENCH_NOT_READY')
    expect(f.adapter.open).toHaveBeenCalledTimes(1)
  })
  it('运行状态为只读且不隐式开库；等待加工有界、核对输入版本与会话并逐次检查授权', async () => {
    const f = fixture(), { lib, key } = await grant(f, 'status', 'read')
    const pending = { session: 'one', items: [{ id: 'item', revision: 'rev1', state: 'pending', kinds: [{ kind: 'out', state: 'pending' }] }] }
    lib.call = vi.fn(async () => structuredClone(pending)) as ExternalCaller
    const request = { ids: ['item'], kinds: ['out'] }
    expect(await f.access.status({ libraryId: lib.id })).toMatchObject({ core: 'running' })
    const timed = await f.access.processing(lib.id, { ...request, waitMs: 5 })
    expect(timed.timedOut).toBe(true)
    expect(timed.items[0].state).toBe('pending')
    expect((await f.access.processing(lib.id, { ...request, expectedRevisions: { item: 'older' } })).items[0].state).toBe('changed')
    let reads = 0
    lib.call = vi.fn(async () => ({ ...structuredClone(pending), session: ++reads === 1 ? 'one' : 'two' })) as ExternalCaller
    await expect(f.access.processing(lib.id, { ...request, waitMs: 500 })).rejects.toThrow('LIBRARY_CHANGED')
    reads = 0
    lib.call = vi.fn(async () => ({ ...structuredClone(pending), items: [{ ...pending.items[0], revision: ++reads === 1 ? 'rev1' : 'rev2' }] })) as ExternalCaller
    expect((await f.access.processing(lib.id, { ...request, waitMs: 500 })).items[0].state).toBe('changed')
    lib.call = vi.fn(async () => { setTimeout(() => f.access.settings({ grant: { key, mode: 'off' } }), 0); return structuredClone(pending) }) as ExternalCaller
    await expect(f.access.processing(lib.id, { ...request, waitMs: 500 })).rejects.toThrow('ACCESS_DENIED')
    await expect(f.access.status({ libraryId: lib.id })).rejects.toThrow('ACCESS_DENIED')
    f.access.settings({ grant: { key, mode: 'read' } }); f.libraries.splice(0)
    expect(await f.access.status({ libraryId: lib.id, sections: ['workbench'] })).toEqual({ libraryId: lib.id, core: 'closed', workbench: { state: 'closed', visible: false } })
    await expect(f.access.processing(lib.id, request)).rejects.toThrow('LIBRARY_OFFLINE')
    expect(f.adapter.open).toHaveBeenCalledTimes(1)
  })
  it('任务清单的创建需要 organize，read 可接手查看，off 不能发现任务', async () => {
    const f = fixture(), { lib, key } = await grant(f, 'task-scope', 'read')
    const plan = { action: 'create' as const, taskId: 'task-scope', title: '整理图稿', inputs: [join(f.dir, '图稿.png')] }
    await f.access.call(lib.id, 'libraryTask', { action: 'list' })
    await expect(f.access.call(lib.id, 'libraryTask', plan)).rejects.toThrow('READ_ONLY')
    for (const action of ['abandon', 'complete'] as const)
      await expect(f.access.call(lib.id, 'libraryTask', { action, taskId: plan.taskId })).rejects.toThrow('READ_ONLY')
    f.access.settings({ grant: { key, mode: 'organize' } })
    await f.access.call(lib.id, 'libraryTask', plan)
    f.access.settings({ grant: { key, mode: 'off' } })
    await expect(f.access.call(lib.id, 'libraryTask', { action:'get', taskId:plan.taskId })).rejects.toThrow('ACCESS_DENIED')
  })
  it('打开已授权路径时核对真实身份，不在错误库装配插件', () => {
    const f = fixture(), root = join(f.dir, 'identity')
    const lib = openCoreLibrary(root), id = lib.id
    lib.close()
    expect(() => openCoreLibrary(root, 'wrong-library-id')).toThrow('LIBRARY_CHANGED')
    const reopened = openCoreLibrary(root, id)
    expect(reopened.id).toBe(id); reopened.close()
  })
  it('不再导入或更新旧单库配置；新路径默认关闭，旧 token 无法访问应用', async () => {
    const f = fixture(), root = join(f.dir, 'legacy'); mkdirSync(root)
    const lib = await f.adapter.open(root)
    const key = createHash('sha256').update(`${root}\0${lib.id}`).digest('hex'), token = 'legacy'.repeat(8)
    mkdirSync(join(f.dir, 'mcp'))
    const file = join(f.dir, 'mcp', `${key}.json`)
    const original = JSON.stringify({ libraryId: lib.id, mode: 'organize', token, endpoint: 'old' })
    writeFileSync(file, original)
    f.access.register(lib)
    expect(f.access.settings()).toMatchObject({ enabled: false, libraries: [{ key, mode: 'off' }] })
    f.access.settings({ enabled: true, grant: { key, mode: 'organize' } })
    const runtime = new ServiceRuntime<ApplicationServiceContext>([plugin], () => ({ access: f.access, executable: () => ({ command: 'test', args: [], env: {} }) }))
    cleanups.push(() => runtime.stop()); await runtime.start(new Set(['mcp']))
    const connection = JSON.parse(readFileSync(f.access.configFile, 'utf8')) as Connection
    await expect(callLocal({ ...connection, libraryId: lib.id, token }, 'describe_library')).rejects.toThrow('CONFIG_RETIRED')
    await expect(callLocal({ ...connection, token }, 'list_libraries')).rejects.toThrow('ACCESS_DENIED')
    expect(readFileSync(file, 'utf8')).toBe(original)
    f.access.register({ id: lib.id, root: join(f.dir, 'copy') })
    const copy = f.access.settings().libraries.find(g => g.name === 'copy')!
    expect(copy.mode).toBe('off')
    expect(existsSync(join(f.dir, 'mcp', `${copy.key}.json`))).toBe(false)
  })

  it('应用默认关闭，无仓库也可开启和发现；MCP 不再参与仓库装配', () => {
    const f = fixture()
    expect(() => f.access.list()).toThrow('ACCESS_DISABLED')
    f.access.settings({ enabled: true })
    expect(f.access.list()).toEqual([])
    expect(PLUGINS.some(p => p.id === 'mcp')).toBe(false)
    expect(APPLICATION_PLUGINS.some(p => p.id === 'mcp')).toBe(true)
    expect(applicationTools.map(t => t.name)).toEqual(expect.arrayContaining(['create_library', 'open_library', 'execute_operation']))
  })
  it('目标 ID 明确路由，只读拒绝写入，未授权不泄露，重载失效且关闭后不能读取', async () => {
    const f = fixture(), a = await grant(f, 'a', 'read'), b = await grant(f, 'b', 'organize'), c = await grant(f, 'hidden', 'off')
    expect(f.access.list().map(l => l.libraryId)).toEqual([a.lib.id, b.lib.id])
    await expect(f.access.call(a.lib.id, 'executeOperation', { requestId: 'request-a', operation: 'create_text', args: {} })).rejects.toThrow('READ_ONLY')
    expect(await f.access.call(b.lib.id, 'readItem', { id: 'same-item' })).toMatchObject({ target: b.lib.id })
    await expect(f.access.call(c.lib.id, 'readItem', { id: 'x' })).rejects.toThrow('ACCESS_DENIED')
    expect((await f.access.call(a.lib.id, 'describeLibrary')).operations).toEqual([])
    expect((await f.access.call(a.lib.id, 'describeLibrary')).queries).toEqual([{ name: 'demo.overview' }])
    expect(await f.access.call(a.lib.id, 'executeQuery', { query: 'demo.overview' })).toMatchObject({ target: a.lib.id })
    await expect(f.access.call(c.lib.id, 'executeQuery', { query: 'demo.overview' })).rejects.toThrow('ACCESS_DENIED')
    expect(await f.access.call(a.lib.id, 'listHistory', {})).toMatchObject({ target: a.lib.id })
    await expect(f.access.call(c.lib.id, 'readHistory', { id: 1 })).rejects.toThrow('ACCESS_DENIED')
    const original = a.lib.active
    a.lib.active = () => false
    await expect(f.access.call(a.lib.id, 'describeLibrary')).rejects.toThrow('LIBRARY_OFFLINE')
    a.lib.active = original
    f.stop(); expect(() => f.access.list()).toThrow('SERVICE_UNAVAILABLE')
  })
  it('同 ID 的拷贝不猜测目标；撤销其中一个授权才能使用', async () => {
    const f = fixture(), a = await grant(f, 'a', 'read')
    f.access.register({ id: a.lib.id, root: join(f.dir, 'copy') })
    const copy = f.access.settings().libraries.find(g => g.name === 'copy')!
    f.access.settings({ grant: { key: copy.key, mode: 'read' } })
    await expect(f.access.call(a.lib.id, 'describeLibrary')).rejects.toThrow('身份重复')
    f.access.settings({ grant: { key: copy.key, mode: 'off' } })
    expect((await f.access.call(a.lib.id, 'describeLibrary')).libraryId).toBe(a.lib.id)
  })
  it('创建权限、路径与并发幂等；重启回执不再次建库，不覆盖已有文件夹', async () => {
    const f = fixture()
    f.access.settings({ enabled: true })
    expect(() => f.access.create({ name: 'one', requestId: 'no-grant' })).toThrow('ACCESS_DENIED')
    f.access.settings({ creation: { parent: f.dir, mode: 'organize' } })
    for (const name of ['..', '.', '../escape', 'x/y', 'C:\\x', 'nul', 'trailing.']) expect(() => f.access.create({ name, requestId: 'bad-name' })).toThrow()
    const input = { name: 'one', requestId: 'create-one' }
    const [first, second] = await Promise.all([f.access.create(input), f.access.create(input)])
    expect(first.replayed).toBe(false); expect(second).toEqual({ ...first, replayed: true })
    expect(f.adapter.open).toHaveBeenCalledTimes(1)
    const resumed = new ApplicationAccess(f.adapter)
    expect(await resumed.create(input)).toEqual(second)
    expect(() => resumed.create({ ...input, name: 'two' })).toThrow('REQUEST_CONFLICT')
    expect(() => resumed.create({ name: 'one', requestId: 'another-id' })).toThrow('TARGET_EXISTS')
    f.access.settings({ creation: null })
    expect(() => f.access.create(input)).toThrow('ACCESS_DENIED')
  })
  it('创建期间收回策略停止后续阶段；恢复原授权后接续同一身份', async () => {
    const f = fixture()
    const original = f.adapter.open
    let resolve!: () => void
    const gate = new Promise<void>(r => { resolve = r })
    f.adapter.open = async (root, id, background) => { await gate; return original(root, id, background) }
    f.access.settings({ enabled: true, creation: { parent: f.dir, mode: 'organize' } })
    const input = { name: 'interrupted', requestId: 'interrupted-create' }
    const task = f.access.create(input)
    f.access.settings({ creation: null }); resolve()
    await expect(task).rejects.toThrow('ACCESS_DENIED')
    const target = f.access.list()[0]
    f.access.settings({ creation: { parent: f.dir, mode: 'organize' } })
    expect(await f.access.create(input)).toMatchObject({ libraryId: target.libraryId, state: 'completed', replayed: true })
  })
  it('应用状态升级保持 token、关闭选择、空间授权和创建回执，只丢弃废弃字段', async () => {
    const f = fixture()
    f.access.settings({ enabled: true, creation: { parent: f.dir, mode: 'organize' } })
    const input = { name: 'kept', requestId: 'keep-create-receipt' }
    const receipt = await f.access.create(input)
    const key = f.access.settings().libraries[0].key
    const fileSpaces = [{ spaceId: '12345678-1234-4234-8234-123456789abc', revise: true, recycle: false }]
    f.access.settings({ enabled: false, grant: { key, mode: 'read', fileSpaces } })
    const before = f.access.settings()
    const file = join(f.dir, 'mcp', 'application-state.json')
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    saved.requests['legacy-create-receipt'] = { name: 'kept', root: receipt.root, libraryId: receipt.libraryId };
    saved.configured = true; saved.libraries[0].legacyToken = 'legacy'.repeat(8)
    writeFileSync(file, JSON.stringify(saved))
    const resumed = new ApplicationAccess(f.adapter)
    expect(resumed.settings()).toEqual(before)
    resumed.publishEndpoint('new-endpoint')
    const config = JSON.parse(readFileSync(resumed.configFile, 'utf8'))
    expect(config).toEqual({ libraryId: 'application', token: saved.token, endpoint: 'new-endpoint', mode: 'off', tools: 'daily' })
    if (process.platform !== 'win32') {
      expect(statSync(file).mode & 0o777).toBe(0o600)
      expect(statSync(resumed.configFile).mode & 0o777).toBe(0o600)
    }
    const after = JSON.parse(readFileSync(file, 'utf8'))
    expect(after.requests).toEqual(saved.requests)
    expect(after.configured).toBeUndefined(); expect(after.libraries[0].legacyToken).toBeUndefined()
    resumed.settings({ enabled: true })
    expect(await resumed.create(input)).toEqual({ ...receipt, replayed: true })
    expect(await resumed.creationStatus('legacy-create-receipt')).toMatchObject({ state: 'completed', libraryId: receipt.libraryId })
    expect(await resumed.create({ name: 'kept', requestId: 'legacy-create-receipt' })).toMatchObject({ replayed: true, state: 'completed' })
    expect(f.adapter.open).toHaveBeenCalledOnce()
    expect(() => resumed.authorize({ libraryId: receipt.libraryId, token: saved.libraries[0].legacyToken })).toThrow('CONFIG_RETIRED')
    writeFileSync(file, '{broken')
    expect(() => new ApplicationAccess(f.adapter)).toThrow()
    expect(readFileSync(file, 'utf8')).toBe('{broken')
  })
  it('已派发读取返回前重查撤权、关库与服务停止', async () => {
    for (const action of ['revoke', 'close', 'stop'] as const) {
      const f = fixture(), { lib, key } = await grant(f, action, 'read')
      let finish!: (value: any) => void
      f.calls.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
      const pending = f.access.call(lib.id, 'readItem', { id: 'item' })
      if (action === 'revoke') f.access.settings({ grant: { key, mode: 'off' } })
      else if (action === 'close') f.libraries.splice(0)
      else f.stop()
      finish({ target: lib.id, ok: true })
      await expect(pending).rejects.toThrow(action === 'revoke' ? 'ACCESS_DENIED' : action === 'close' ? 'LIBRARY_OFFLINE' : 'SERVICE_UNAVAILABLE')
    }
  })
  it('真实应用通道在零仓库时能创建，校验目标与参数；停服清理，重启接续关闭选择和 token', async () => {
    const f = fixture()
    f.access.settings({ enabled: true, creation: { parent: f.dir, mode: 'organize' } })
    const runtime = new ServiceRuntime<ApplicationServiceContext>([plugin], () => ({ access: f.access, executable: () => ({ command: 'electron', args: ['mcp.js'], env: {} }) }))
    cleanups.push(() => runtime.stop())
    await runtime.start(new Set(['mcp']))
    const settings = await runtime.invoke('mcp', 'settings') as { config: string }
    expect(JSON.parse(settings.config)).toEqual({ mcpServers: { huoye: {
      command: 'electron', args: ['mcp.js', '--config', f.access.configFile], env: {}
    } } })
    expect(clientConfig(settings.config, 'json')).toBe(settings.config)
    const toml = clientConfig(settings.config, 'toml')
    expect(toml).toContain('[mcp_servers.huoye]')
    expect(toml).toContain('[mcp_servers.huoye.env]')
    expect(toml).toContain(JSON.stringify(f.access.configFile))
    const connection = JSON.parse(readFileSync(f.access.configFile, 'utf8')) as Connection
    expect(await callLocal(connection, 'list_libraries')).toEqual({ libraries: [] })
    expect(await callLocal(connection, 'list_ecosystem_catalog')).toMatchObject({ total: 0, creation: { mode: 'organize' }, supported: { pluginConfiguration: false } })
    await expect(callLocal(connection, 'create_library', { name: 'escalation', requestId: 'no-escalation', mode: 'admin' })).rejects.toThrow('INVALID_INPUT')
    const made = await callLocal(connection, 'create_library', { name: 'new', requestId: 'real-create' }) as { libraryId: string }
    expect(await callLocal(connection, 'describe_library', { libraryId: made.libraryId })).toMatchObject({ libraryId: made.libraryId })
    expect(await callLocal(connection, 'execute_query', { libraryId: made.libraryId, query: 'demo.overview' })).toMatchObject({ target: made.libraryId })
    await expect(callLocal(connection, 'execute_query', { libraryId: made.libraryId, query: 'demo.overview', requestId: 'not-needed' })).rejects.toThrow('INVALID_INPUT')
    await expect(callLocal(connection, 'describe_library')).rejects.toThrow('INVALID_INPUT')
    await expect(callLocal(connection, 'create_text', { libraryId: made.libraryId, requestId: 'old-tool', content: 'old' })).rejects.toThrow('未知的工具')
    await expect(callLocal({ ...connection, token: '中' }, 'list_libraries')).rejects.toThrow('ACCESS_DENIED')
    await expect(callLocal({ ...connection, token: 'x'.repeat(40) }, 'list_libraries')).rejects.toThrow('ACCESS_DENIED')
    await expect(callLocal(connection, 'create_library', { name: 'x', requestId: 'other-create', parent: '/tmp' })).rejects.toThrow('INVALID_INPUT')
    f.access.settings({ enabled: false })
    await expect(callLocal(connection, 'list_libraries')).rejects.toThrow('ACCESS_DISABLED')
    await runtime.stop()
    if (process.platform !== 'win32') expect(existsSync(connection.endpoint)).toBe(false)
    await expect(callLocal(connection, 'list_libraries')).rejects.toThrow('LIBRARY_OFFLINE')
    const resumed = new ApplicationAccess(f.adapter)
    const next = new ServiceRuntime<ApplicationServiceContext>([plugin], () => ({ access: resumed, executable: () => ({ command: 'test', args: [], env: {} }) }))
    cleanups.push(() => next.stop()); await next.start(new Set(['mcp']))
    const current = JSON.parse(readFileSync(resumed.configFile, 'utf8')) as Connection
    expect(current).toMatchObject({ libraryId: 'application', token: connection.token, mode: 'off' })
    expect(current.endpoint).not.toBe(connection.endpoint)
    await expect(callLocal(current, 'list_libraries')).rejects.toThrow('ACCESS_DISABLED')
    resumed.settings({ enabled: true })
    expect(await callLocal(current, 'describe_library', { libraryId: made.libraryId })).toMatchObject({ libraryId: made.libraryId })
  })
})

describe('托管授权与能力发现', () => {
  it('自定创建先预演并要求 admin；过期预演拒绝；参数重试不能改变后台模式或插件选择', async () => {
    const f = fixture(), choice = { name: 'planned', plugins: [{ id: 'text' }] }
    f.access.settings({ enabled: true, creation: { parent: f.dir, mode: 'organize' } })
    expect(() => f.access.previewCreation(choice)).toThrow('ADMIN_REQUIRED')
    f.access.settings({ creation: { parent: f.dir, mode: 'admin' } })
    expect(() => f.access.previewCreation({ ...choice, parent: '/tmp/override' } as any)).toThrow()
    const preview = f.access.previewCreation(choice)
    expect(preview).toMatchObject({ root: join(f.dir, choice.name), mode: 'admin', background: true })
    expect(existsSync(preview.root)).toBe(false)
    const input = { ...choice, requestId: 'preview-create', previewRevision: preview.revision }
    expect(() => f.access.create({ ...choice, requestId: input.requestId })).toThrow('PREVIEW_REQUIRED')
    const original = f.adapter.creations!.preview
    f.adapter.creations!.preview = (...args) => ({ ...original(...args), revision: 'changed' })
    expect(() => f.access.create(input)).toThrow('PREVIEW_CHANGED')
    expect(f.jobs.list(true)).toEqual([])
    f.adapter.creations!.preview = original
    const made = await f.access.create(input)
    expect(made.state).toBe('completed')
    expect(f.adapter.open).toHaveBeenCalledExactlyOnceWith(preview.root, made.libraryId, true)
    expect(() => f.access.create({ ...input, background: false })).toThrow('REQUEST_CONFLICT')
    expect(() => f.access.create({ ...input, plugins: [] })).toThrow('REQUEST_CONFLICT')
    // 已确认后的任务不重新读取方案；完成后回执也不因运行库关闭消失。
    f.adapter.creations!.preview = () => { throw new Error('方案已经更新') }
    f.libraries.splice(0)
    expect(await new ApplicationAccess(f.adapter).create(input)).toMatchObject({ state: 'completed', libraryId: made.libraryId, runtime: { core: 'stopped' } })
    expect(f.adapter.open).toHaveBeenCalledOnce()
  })

  it('运行中取消只截断后续阶段、保留数据和终态；同请求不会重新创建，撤权不能由恢复补回', async () => {
    const f = fixture(), original = f.adapter.open
    let finish!: () => void
    const gate = new Promise<void>(resolve => { finish = resolve })
    f.adapter.open = async (...args) => { await gate; return original(...args) }
    f.access.settings({ enabled: true, creation: { parent: f.dir, mode: 'admin' } })
    const input = { name: 'cancelled', requestId: 'cancel-create' }, pending = f.access.create(input)
    const status = await f.access.creationStatus(input.requestId)
    expect(status).toMatchObject({ state: 'pending', phase: 'claimed' })
    writeFileSync(join(status.root, 'important.txt'), '保留')
    expect(await f.access.cancelCreation(input.requestId)).toMatchObject({ state: 'cancelled' })
    finish()
    expect(await pending).toMatchObject({ state: 'cancelled' })
    const resumed = new ApplicationAccess(f.adapter)
    expect(await resumed.create(input)).toMatchObject({ state: 'cancelled', libraryId: status.libraryId })
    expect(await resumed.resumeCreation(input.requestId)).toMatchObject({ state: 'cancelled' })
    expect(original).toHaveBeenCalledOnce()
    expect(readFileSync(join(status.root, 'important.txt'), 'utf8')).toBe('保留')
    const key = resumed.settings().libraries[0].key
    resumed.settings({ grant: { key, mode: 'off' } })
    expect(() => resumed.create(input)).toThrow('ACCESS_DENIED')
    expect(() => resumed.resumeCreation(input.requestId)).toThrow('ACCESS_DENIED')
    expect(resumed.settings().libraries[0].mode).toBe('off')
  })

  it('新库仅按用户选择授予 admin；已有权限与 token 不随策略改变，重启保持', async () => {
    const f = fixture(), old = await grant(f, 'old', 'organize')
    const token = JSON.parse(readFileSync(f.access.configFile, 'utf8')).token
    f.access.settings({ creation: { parent: f.dir, mode: 'admin' } })
    const created = await f.access.create({ name: 'managed', requestId: 'managed-library' })
    const resumed = new ApplicationAccess(f.adapter)
    expect(resumed.list().map(g => [g.libraryId, g.mode])).toEqual([[old.lib.id, 'organize'], [created.libraryId, 'admin']])
    expect(JSON.parse(readFileSync(resumed.configFile, 'utf8')).token).toBe(token)
    expect(resumed.settings().creation?.mode).toBe('admin')
  })

  it('按宿主声明区分数据、结构与旧操作；拒绝调用方伪造 effect，admin 也不能永久清除或隐式取得原件权限', async () => {
    const f = fixture(), { lib, key } = await grant(f, 'scope', 'organize')
    const operations = [
      { name: 'data', title: '数据', effect: 'data' }, { name: 'structure', title: '结构', effect: 'structure' }, { name: 'legacy', title: '旧插件' }
    ]
    f.calls.mockImplementation(async (id, method) => method === 'describeLibrary' ? { libraryId: id, operations, queries: [] } as any : { target: id, ok: true })
    const request = (operation: string) => ({ operation, requestId: 'scoped-write', args: {} })
    let description = await f.access.call(lib.id, 'describeLibrary')
    expect(description.operations.map(o => o.name)).toEqual(['data'])
    expect(description.blockedOperations?.map(o => o.reason)).toEqual([expect.stringContaining('ADMIN_REQUIRED'), expect.stringContaining('OPERATION_UNCLASSIFIED')])
    await f.access.call(lib.id, 'executeOperation', request('data'))
    await expect(f.access.call(lib.id, 'executeOperation', request('structure'))).rejects.toThrow('ADMIN_REQUIRED')
    await expect(f.access.call(lib.id, 'executeOperation', { ...request('structure'), effect: 'data' } as any)).rejects.toThrow()
    for (const mode of ['organize', 'admin'] as const) {
      f.access.settings({ grant: { key, mode } })
      await expect(f.access.call(lib.id, 'executeOperation', request('legacy'))).rejects.toThrow('OPERATION_UNCLASSIFIED')
      await expect(f.access.call(lib.id, 'applyItemLifecycle', { action: 'purge', ids: ['item'], previewToken: 'a'.repeat(64), requestId: 'no-purge' })).rejects.toThrow('IRREVERSIBLE_DENIED')
      await expect(f.access.call(lib.id, 'externalFileAction', { action: 'restoreVersion', input: { spaceId: '12345678-1234-4234-8234-123456789abc', fileId: '12345678-1234-4234-8234-123456789abc', contentVersion: '12345678-1234-4234-8234-123456789abc', revision: 1, requestId: 'no-original' } } as any)).rejects.toThrow('MCP_SPACE_DENIED')
    }
    description = await f.access.call(lib.id, 'describeLibrary')
    expect(description.operations.map(o => o.name)).toEqual(['data', 'structure'])
    await f.access.call(lib.id, 'executeOperation', request('structure'))
    expect(f.calls.mock.calls.filter(([, method]) => method !== 'describeLibrary').map(([, method]) => method)).toEqual(['executeOperation', 'executeOperation'])
  })

  it.each(['organize', 'off', 'reload'] as const)('操作描述等待期间变更为 %s 后不得派发结构写入', async mode => {
    const f = fixture(), { lib, key } = await grant(f, 'race', 'admin')
    let finish!: (value: any) => void
    f.calls.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const pending = f.access.call(lib.id, 'executeOperation', { operation: 'structure', requestId: 'race-write', args: {} })
    if (mode === 'reload') f.libraries.splice(0)
    else f.access.settings({ grant: { key, mode } })
    finish({ operations: [{ name: 'structure', effect: 'structure' }] })
    await expect(pending).rejects.toThrow(mode === 'organize' ? 'ADMIN_REQUIRED' : mode === 'off' ? 'ACCESS_DENIED' : 'LIBRARY_CHANGED')
    expect(f.calls).toHaveBeenCalledOnce()
  })

  it('零仓库可发现；分页绑定目录和权限快照；隐藏目标及等待期间撤权不泄露目录', async () => {
    const f = fixture()
    f.adapter.catalog = vi.fn(() => ['file', 'text'].map(id => ({ kind: 'plugin' as const, id, title: id, description: '', source: 'builtin' as const, requires: [], issues: [], runtime: 'not-checked' as const })))
    f.access.settings({ enabled: true })
    const first = await f.access.catalog({ limit: 1 })
    expect(first).toMatchObject({ creation: null, total: 2, nextOffset: 1, supported: { creationWithPreset: true } })
    expect(first.target).toBeUndefined()
    expect((await f.access.catalog({ offset: 1, snapshot: first.snapshot })).entries[0].id).toBe('text')
    await expect(f.access.catalog({ offset: 1 })).rejects.toThrow('CATALOG_CHANGED')
    f.access.settings({ creation: { parent: f.dir, mode: 'admin' } })
    await expect(f.access.catalog({ offset: 1, snapshot: first.snapshot })).rejects.toThrow('CATALOG_CHANGED')
    const { lib, key } = await grant(f, 'target', 'read')
    expect((await f.access.catalog({ libraryId: lib.id })).target?.permissions).toMatchObject({
      read: true, organize: false, structure: false, workbenchSession: true, workbenchPresentation: false,
      workbench: false, workbenchConfiguration: false, reviewRead: true, reviewManage: false
    })
    f.access.settings({ grant: { key, mode: 'organize' } })
    expect((await f.access.catalog({ libraryId: lib.id })).target?.permissions).toMatchObject({
      workbenchSession: true, workbenchPresentation: true, workbench: false, workbenchConfiguration: false,
      reviewRead: true, reviewManage: true
    })
    f.access.settings({ grant: { key, mode: 'admin' } })
    const admin = await f.access.catalog({ libraryId: lib.id })
    expect(admin.target?.permissions).toMatchObject({
      structure: true, workbenchSession: true, workbenchPresentation: true, workbench: true,
      workbenchConfiguration: true, reviewRead: true, reviewManage: true
    })
    expect(admin.supported.packageInstallation).toBe(false)
    f.access.settings({ grant: { key, mode: 'off' } })
    const count = vi.mocked(f.adapter.catalog).mock.calls.length
    await expect(f.access.catalog({ libraryId: lib.id })).rejects.toThrow('ACCESS_DENIED')
    expect(vi.mocked(f.adapter.catalog).mock.calls).toHaveLength(count)
    f.access.settings({ grant: { key, mode: 'admin' } })
    let finish!: (value: []) => void
    f.adapter.catalog = () => new Promise(resolve => { finish = resolve })
    const pending = f.access.catalog({ libraryId: lib.id })
    f.access.settings({ grant: { key, mode: 'off' } }); finish([])
    await expect(pending).rejects.toThrow('ACCESS_DENIED')
  })
})

it('文件空间 MCP 仅开放已关联空间发现与收录，不开放路径关联；只读授权拒绝收录', async () => {
  const f=fixture(),{lib,key}=await grant(f,'spaces','read')
  await f.access.call(lib.id,'listFileSpaces')
  await f.access.call(lib.id,'getImportSettings')
  await expect(f.access.call(lib.id,'importFiles', {requestId:'denied-new-import',files:[]})).rejects.toThrow('READ_ONLY')
  await expect(f.access.call(lib.id,'setImportSettings' as any, {})).rejects.toThrow('ACCESS_DENIED')
  await expect(f.access.call(lib.id,'adoptSpaceFiles',{spaceId:'space',requestId:'adopt-space',files:[]})).rejects.toThrow('READ_ONLY')
  await expect(f.access.call(lib.id,'linkFileSpace' as any,'/tmp/unapproved')).rejects.toThrow('ACCESS_DENIED')
  f.access.settings({grant:{key,mode:'organize'}})
  await f.access.call(lib.id,'adoptSpaceFiles',{spaceId:'space',requestId:'adopt-space',files:[]})
  expect(applicationTools.map(t=>t.name)).toEqual(expect.arrayContaining(['list_file_spaces','list_space_files','adopt_space_files']))
})


it('仓库生命周期授权不扩大到空间原件；只读能预览但不能执行', async () => {
  const f = fixture(), { lib, key } = await grant(f, 'lifecycle', 'read')
  const input = { action: 'trash' as const, ids: ['entity'], previewToken: 'a'.repeat(64), requestId: 'lifecycle-request' }
  await f.access.call(lib.id, 'previewItemLifecycle', { action: 'trash', ids: ['entity'] })
  await f.access.call(lib.id, 'previewUnlinkFileSpace', 'space')
  await expect(f.access.call(lib.id, 'applyItemLifecycle', input)).rejects.toThrow('READ_ONLY')
  f.access.settings({ grant: { key, mode: 'organize' } })
  await f.access.call(lib.id, 'applyItemLifecycle', input)
  for (const method of ['mutateSpaceFiles', 'refreshFileSpace', 'unlinkFileSpace', 'forgetFileSpace', 'previewForgetFileSpace', 'purge']) {
    await expect(f.access.call(lib.id, method as any, {})).rejects.toThrow('ACCESS_DENIED')
  }
  expect(applicationTools.map(t => t.name)).toEqual(expect.arrayContaining(['preview_item_lifecycle', 'apply_item_lifecycle', 'preview_unlink_file_space']))
})


it('本机设置可按已登记关系修改空间权限；不修改 AI 授权，不对 MCP 开放提权', async () => {
  const f = fixture(), { lib, key } = await grant(f, 'permission-target', 'read')
  const spaceId = '12345678-1234-4234-8234-123456789abc'
  const input = { key, spaceId, permission: 'revise' as const, enabled: true, revision: 3 }
  const result = { revision: 4, members: [{ id: lib.id, name: 'test', revise: true, recycle: false }] }
  f.adapter.setSpacePermission = vi.fn(async () => result)
  const before = f.access.settings()
  await expect(f.access.setSpacePermission(input)).rejects.toThrow('SPACE_NOT_LINKED')
  f.calls.mockResolvedValueOnce([{ id: spaceId, root: '/registered-space', state: 'active' }] as never)
  expect(await f.access.setSpacePermission(input)).toEqual(result)
  expect(f.adapter.setSpacePermission).toHaveBeenCalledExactlyOnceWith('/registered-space', lib.id, input)
  expect(f.access.settings()).toEqual(before)
  await expect(f.access.setSpacePermission({ ...input, key: 'unknown' })).rejects.toThrow('LIBRARY_UNKNOWN')
  await expect(f.access.setSpacePermission({ ...input, root: '/untrusted' } as any)).rejects.toThrow()
  await expect(f.access.call(lib.id, 'setSpacePermission' as any, input)).rejects.toThrow('ACCESS_DENIED')
  expect(applicationTools.some(t => /setSpacePermission|set_space_permission/.test(t.name))).toBe(false)
  f.libraries.splice(0)
  await expect(f.access.setSpacePermission(input)).rejects.toThrow('LIBRARY_OFFLINE')
})

it.each(['application.json', 'application-state.json'])('%s 保存失败保持内存授权、原文件和重开状态，修复后可重试', async filename => {
  const f = fixture(), { lib, key } = await grant(f, 'read-only', 'read')
  f.access.publishEndpoint('old-endpoint')
  const before = f.access.settings(), file = join(f.dir, 'mcp', 'application-state.json')
  const state = readFileSync(file, 'utf8'), config = readFileSync(f.access.configFile, 'utf8')
  const blocked = join(f.dir, 'mcp', filename + '.tmp'); mkdirSync(blocked)
  const change = { enabled: false, creation: { parent: f.dir, mode: 'organize' as const }, grant: { key, mode: 'organize' as const } }
  expect(() => f.access.settings(change)).toThrow()
  expect(f.access.settings()).toEqual(before)
  expect(readFileSync(file, 'utf8')).toBe(state)
  expect(readFileSync(f.access.configFile, 'utf8')).toBe(config)
  expect(new ApplicationAccess(f.adapter).settings()).toEqual(before)
  await expect(f.access.call(lib.id, 'executeOperation', { requestId: 'denied', operation: 'x', args: {} })).rejects.toThrow('READ_ONLY')
  expect(() => f.access.publishEndpoint('failed-endpoint')).toThrow()
  rmSync(blocked, { recursive: true })
  f.access.settings(change)
  expect(f.access.settings()).toMatchObject({ enabled: false, libraries: [{ mode: 'organize' }] })
  expect(JSON.parse(readFileSync(f.access.configFile, 'utf8')).endpoint).toBe('old-endpoint')
  expect(new ApplicationAccess(f.adapter).settings()).toEqual(f.access.settings())
})

it('授权落盘失败保留已固定任务但不认领目录；修复后接续，设置快照不能改内部状态', async () => {
  const f = fixture()
  f.access.settings({ enabled: true, creation: { parent: f.dir, mode: 'organize' } })
  const before = f.access.settings(), blocked = join(f.dir, 'mcp', 'application-state.json.tmp')
  mkdirSync(blocked)
  expect(() => f.access.register({ id: 'ghost', root: join(f.dir, 'ghost') })).toThrow()
  const input = { name: 'retry-create', requestId: 'retry-intent' }
  expect(() => f.access.create(input)).toThrow()
  expect(existsSync(join(f.dir, input.name))).toBe(false)
  expect(f.access.settings()).toEqual(before)
  expect(new ApplicationAccess(f.adapter).settings()).toEqual(before)
  rmSync(blocked, { recursive: true })
  const receipt = await f.access.create(input)
  expect(receipt.replayed).toBe(true)
  expect(f.jobs.list(true)).toHaveLength(1)
  const snapshot = f.access.settings()
  snapshot.creation!.mode = 'read'
  snapshot.libraries[0].fileSpaces.push({ spaceId: '12345678-1234-4234-8234-123456789abc', revise: true, recycle: true })
  expect(f.access.settings().creation!.mode).toBe('organize')
  expect(f.access.settings().libraries[0].fileSpaces).toEqual([])
})

it('托管能力按 admin 与目标身份路由，等待期间撤权阻止后续阶段且不开放人工批准工具', async () => {
  const f = fixture(), target = await grant(f, 'managed', 'organize')
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const call = vi.fn(async (_action, _input, guard, _root) => { await gate; guard(); return { ok: true } })
  f.adapter.management = { call, local: () => ({ suites: [], configurations: [], installations: [], packages: [], spaces: [] }) }
  const input = { libraryId: target.lib.id, plugins: [] }
  await expect(f.access.manage('preview_library_plugins', input)).rejects.toThrow('ADMIN_REQUIRED')
  expect(call).not.toHaveBeenCalled()
  f.access.settings({ grant: { key: target.key, mode: 'admin' } })
  const pending = f.access.manage('preview_library_plugins', input)
  expect(call.mock.calls[0][3]).toBe(target.lib.root)
  f.access.settings({ grant: { key: target.key, mode: 'read' } }); release()
  await expect(pending).rejects.toThrow('ADMIN_REQUIRED')
  await expect(f.access.manage('approve-installation' as any, { requestId: 'task-test' })).rejects.toThrow('UNAVAILABLE')
  expect(applicationTools.some(t => /approve|permission/.test(t.name))).toBe(false)
})
