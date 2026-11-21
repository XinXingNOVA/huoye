import { afterEach, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openHost } from '../helpers/helpers'
import { ApplicationAccess } from '../../src/main/application-access'
import { ServiceRuntime } from '../../src/main/service-runtime'
import type { ApplicationServiceContext, ExternalCaller } from '../../src/plugin-api/service'
import { plugin } from '../../src/plugins/mcp/application-service'
import { callLocal, type Connection } from '../../src/plugins/mcp/local'
import { DirectorySpaces } from '../../src/storage/directory-spaces'
import { SpaceVersions, setVersionPermission } from '../../src/storage/space-versions'
import { applicationTools } from '../../src/plugins/mcp/tools'
import type { FileEditPreview, FileEditResult } from '../../src/shared/file-edits'
import type { SpaceHistoryPage } from '../../src/shared/space-versions'
import type { SpaceMutationPreview } from '../../src/shared/file-spaces'
const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const f of cleanups.splice(0).reverse()) await f() })
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'rm-mcp-edits-')); cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const { host, cleanup } = openHost(); cleanups.push(cleanup)
  const versions = SpaceVersions.create(join(dir, 'shared'), 'shared'); cleanups.push(() => versions.space.close())
  host.api.linkFileSpace(versions.space.root)
  const source = join(dir, 'source.md'); writeFileSync(source, '# original')
  const imported = await host.api.importToLibrary([{ type: 'file', path: source }], { spaceId: versions.space.id, requestId: randomUUID() })
  const id = imported.items[0].id
  const lib = { id: host.lib.id, root: host.lib.root, active: () => true,
    call: ((method: string, ...args: unknown[]) => Promise.resolve((host.api as unknown as Record<string, (...args: unknown[]) => unknown>)[method](...args))) as ExternalCaller }
  const access = new ApplicationAccess({ userData: dir, active: () => true, libraries: () => [lib], open: async () => lib })
  access.register(lib); const key = access.settings().libraries[0].key
  access.settings({ enabled: true, grant: { key, mode: 'organize' } })
  const runtime = new ServiceRuntime<ApplicationServiceContext>([plugin], () => ({ access, executable: () => ({ command: 'test', args: [], env: {} }) }))
  cleanups.push(() => runtime.stop()); await runtime.start(new Set(['mcp']))
  const connection = JSON.parse(readFileSync(access.configFile, 'utf8')) as Connection
  const call = (name: string, input: Record<string, unknown> = {}) => callLocal(connection, name, { libraryId: lib.id, ...input })
  const authorize = (revise: boolean, recycle: boolean, mode: 'read' | 'organize' = 'organize') => access.settings({ grant: { key, mode, fileSpaces: [{ spaceId: versions.space.id, revise, recycle }] } })
  return { dir, host, versions, id, access, call, authorize, key }
}
it('MCP 发现、双层权限、编辑/历史恢复/回收闭环与作用域隔离', async () => {
  const { host, versions, id, call, authorize } = await fixture(), spaceId = versions.space.id
  expect(applicationTools.map(t => t.name)).toEqual(expect.arrayContaining(['prepare_file_edit', 'commit_file_edit', 'list_file_versions', 'apply_space_lifecycle']))
  const prepare = { id, content: { type: 'text', text: '# MCP new' }, destination: { mode: 'publish' }, requestId: randomUUID() }
  expect(await call('get_file_edit_capabilities', { id })).toMatchObject({ publish: { allowed: false } })
  await expect(call('prepare_file_edit', prepare)).rejects.toThrow('MCP_SPACE_DENIED')
  authorize(true, false)
  await expect(call('prepare_file_edit', prepare)).rejects.toThrow('SPACE_REVISE_DENIED')
  setVersionPermission(versions.space, host.lib.id, 'revise', true, versions.space.info().revision)
  const p = await call('prepare_file_edit', prepare) as FileEditPreview
  await expect(host.api.commitFileEdit({ editId: p.editId, previewToken: p.previewToken, requestId: randomUUID() })).rejects.toThrow('EDIT_SCOPE')
  const request = { editId: p.editId, previewToken: p.previewToken, requestId: randomUUID() }
  authorize(false, false); await expect(call('commit_file_edit', request)).rejects.toThrow('MCP_SPACE_DENIED')
  authorize(true, false); const result = await call('commit_file_edit', request) as FileEditResult
  expect(result.library.state).toBe('accepted')
  expect((await call('commit_file_edit', request) as FileEditResult).space.contentVersion).toBe(result.space.contentVersion)
  const fileId = result.space.fileId, history = await call('list_file_versions', { spaceId, fileId }) as SpaceHistoryPage
  const restore = { spaceId, fileId, contentVersion: history.versions.at(-1)!.id, revision: history.revision, requestId: randomUUID() }
  await call('restore_file_version', restore)
  expect(versions.versions(fileId)).toHaveLength(3)
  expect(readFileSync(host.lib.files.readable(String(host.store.blocksOf(id).file.data.path)), 'utf8')).toBe('# MCP new')
  const update = await call('preview_file_update', { id }) as import('../../src/shared/file-updates').FileUpdatePreview
  await call('accept_file_update', { id, expectedPath: update.expectedPath, contentVersion: update.current.id, revision: update.revision, requestId: randomUUID() })
  expect(readFileSync(host.lib.files.readable(String(host.store.blocksOf(id).file.data.path)), 'utf8')).toBe('# original')
  const target = { spaceId, action: 'recycle', files: [{ id: fileId, revision: versions.space.byId(fileId)!.revision }] }
  const preview = await call('preview_space_lifecycle', target) as SpaceMutationPreview
  expect(preview.blocked).toContain('MCP')
  await expect(call('apply_space_lifecycle', { ...target, version: preview.version, requestId: randomUUID() })).rejects.toThrow('MCP_SPACE_DENIED')
  authorize(true, true)
  await expect(call('apply_space_lifecycle', { ...target, version: preview.version, requestId: randomUUID() })).rejects.toThrow('SPACE_RECYCLE_DENIED')
  setVersionPermission(versions.space, host.lib.id, 'recycle', true, versions.space.info().revision)
  const allowed = await call('preview_space_lifecycle', target) as SpaceMutationPreview
  expect(allowed.blocked).toBeUndefined()
  await call('apply_space_lifecycle', { ...target, version: allowed.version, requestId: randomUUID() })
  expect(() => versions.read(fileId, result.space.contentVersion)).toThrow('FILE_UNAVAILABLE')
  const back = { ...target, action: 'restore', files: [{ id: fileId, revision: versions.space.byId(fileId)!.revision }] }
  const previewBack = await call('preview_space_lifecycle', back) as SpaceMutationPreview
  await call('apply_space_lifecycle', { ...back, version: previewBack.version, requestId: randomUUID() })
  expect(host.store.isTrashed(id)).toBe(false)
  authorize(true, true, 'read')
  expect(await call('list_file_versions', { spaceId, fileId })).toMatchObject({ canRestore: false })
  await expect(call('accept_file_update', { id, expectedPath: update.expectedPath, contentVersion: update.current.id, revision: update.revision, requestId: randomUUID() })).rejects.toThrow('READ_ONLY')
})
it('本机授权配置可重读，未授权空间、额外参数和过大文字不能写入', async () => {
  const { host, access, call, authorize, id, versions } = await fixture()
  authorize(true, true)
  const saved = JSON.parse(readFileSync(join(access.configFile, '..', 'application-state.json'), 'utf8'))
  expect(saved.libraries[0].fileSpaces).toEqual([{ spaceId: versions.space.id, revise: true, recycle: true }])
  await expect(call('prepare_file_edit', { id, content: { type: 'text', text: 'a'.repeat(32001) }, destination: { mode: 'publish' }, requestId: randomUUID() })).rejects.toThrow()
  await expect(call('list_file_versions', { spaceId: randomUUID(), fileId: randomUUID() })).rejects.toThrow('SPACE_NOT_LINKED')
  await expect(call('prepare_file_edit', { id, actor: 'application', content: { type: 'text', text: 'bad' }, destination: { mode: 'publish' }, requestId: randomUUID() })).rejects.toThrow()
  expect((await host.api.query({ has: ['file'] })).ids).toEqual([id])
})

it('通过公开 MCP 预览已核对的原地内容，只有整理授权能接纳到本仓库', async () => {
  const { dir, host, call, authorize } = await fixture()
  const home = join(dir, 'directory-catalog'), origin = join(dir, 'source-folder')
  vi.stubEnv('HUOYE_DIRECTORY_CATALOG', home)
  try {
    mkdirSync(origin)
    const source = join(origin, '原地.md')
    writeFileSync(source, '原文')
    const spaces = new DirectorySpaces(home), space = spaces.attach(host.lib, origin)
    const scan = () => spaces.refreshTree(host.lib, space.id, new AbortController().signal)
    await scan()
    const plan = await host.api.previewDirectoryCollection(space.id, ['md'])
    await host.api.collectDirectoryFiles(space.id, ['md'], plan.token)
    writeFileSync(source, '修订原文')
    await scan()
    const [{ id }] = (await host.api.listDirectoryUpdates(space.id, 0)).items
    authorize(false, false, 'read')
    const p = await call('preview_file_update', { id }) as import('../../src/shared/file-updates').FileUpdatePreview
    expect(p.current.sample).toBe('修订原文')
    const args = { id, expectedPath: p.expectedPath, contentVersion: p.current.id, revision: p.revision, requestId: randomUUID() }
    await expect(call('accept_file_update', args)).rejects.toThrow('READ_ONLY')
    authorize(false, false, 'organize')
    expect(await call('accept_file_update', args)).toMatchObject({ id, replayed: false })
    expect(await call('accept_file_update', args)).toMatchObject({ id, replayed: true })
    expect((await host.api.listDirectoryUpdates(space.id, 0)).total).toBe(0)
  } finally {
    await host.scheduler.idle()
    vi.unstubAllEnvs()
  }
})
