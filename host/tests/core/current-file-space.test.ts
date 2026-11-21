import Database from 'better-sqlite3'
import { afterEach, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { FileSpace } from '../../src/storage/file-space'
import { SpaceLifecycle } from '../../src/storage/space-lifecycle'
import { LibraryFiles } from '../../src/storage/library-files'
import { SpaceHistory } from '../../src/storage/space-history'
import { SpaceVersions, inspectVersionReadiness, versionPermissions } from '../../src/storage/space-versions'
import { parseSpaceReference } from '../../src/storage/space-reference'
import { openHost, tempDir } from '../helpers/helpers'

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).reverse().forEach(fn => fn()))
function directory() {
  const dir = tempDir('rm-current-space-')
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

it.each(['private', 'shared'] as const)('直接创建完整 %s 版本空间，关闭重开不补旧表、不改变身份', mode => {
  const root = join(directory(), 'space'), info = FileSpace.create(root, mode)
  expect(info).toMatchObject({ mode, versioned: true, members: 0 })
  const read = new Database(join(root, '.file-space.db'), { readonly: true })
  try {
    expect(read.prepare('SELECT version FROM space').pluck().get()).toBe(4)
    const schemaVersion = read.pragma('schema_version', { simple: true })
    const reopened = new FileSpace(root); reopened.close()
    expect(read.pragma('schema_version', { simple: true })).toBe(schemaVersion)
    const tables = read.prepare("SELECT name FROM sqlite_master WHERE type='table'").pluck().all()
    expect(tables).toEqual(expect.arrayContaining(['version_drafts', 'version_receipts', 'version_import_batches', 'history_restorations', 'file_heads', 'file_versions', 'space_changes', 'space_file_records', 'space_disposals', 'space_disposal_commands']))
    expect(read.prepare('PRAGMA table_info(version_members)').all()).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'recycle' })]))
  } finally { read.close() }
  const space = new FileSpace(root)
  try {
    expect(space.info()).toEqual(info)
    expect(space.db.prepare('SELECT total_changes()').pluck().get()).toBe(0)
    expect(() => FileSpace.create(root, mode)).toThrow()
    expect(space.id).toBe(info.id)
  } finally { space.close() }
})

it('无效模式不创建目录；不完整初始化拒绝打开，不降成可写旧空间', () => {
  const root = join(directory(), 'space')
  expect(() => FileSpace.create(root, 'invalid' as any)).toThrow('无效的空间模式')
  expect(existsSync(root)).toBe(false)
  mkdirSync(root); new Database(join(root, '.file-space.db')).close()
  expect(() => new FileSpace(root)).toThrow('初始化未完成')
  const db = new Database(join(root, '.file-space.db'), { readonly: true })
  try { expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).toEqual([]) }
  finally { db.close() }
})

it('已有早期 v4 增量补列保留版本与回执，不需要回到旧空间初始化', async () => {
  const dir = directory(), versions = SpaceVersions.create(join(dir, 'space'), 'shared')
  cleanups.push(() => { if (versions.space.db.open) versions.space.close() })
  const source = join(dir, 'original.md'); writeFileSync(source, '# original')
  const draft = await versions.stage({ spaceId: versions.space.id, source, requestId: randomUUID() })
  const request = { spaceId: versions.space.id, draftId: draft.draft.id, previewToken: versions.preview(draft.draft.id).previewToken, requestId: randomUUID() }
  const saved = await versions.commit(request)
  versions.space.connect('reader', dir, 'reader-token', true)
  versions.space.db.prepare("UPDATE version_members SET revise=1 WHERE library_id='reader'").run()
  versions.space.db.exec('DROP TABLE space_file_records; DROP TABLE space_disposals; DROP TABLE space_disposal_commands; DROP TABLE history_restorations; DROP TABLE version_import_batches; ALTER TABLE version_members DROP COLUMN recycle; ALTER TABLE version_drafts DROP COLUMN actor')
  versions.space.close()
  const space = new FileSpace(join(dir, 'space'))
  cleanups.push(() => space.close())
  expect(space.db.prepare("SELECT revise,recycle FROM version_members WHERE library_id='reader'").get()).toEqual({ revise: 1, recycle: 0 })
  expect(space.db.prepare('SELECT actor FROM version_drafts').pluck().get()).toBe('application')
  expect(space.info().versioned).toBe(true)
  const reopened = new SpaceVersions(space)
  expect(await reopened.commit(request)).toMatchObject({ ...saved, replayed: true })
  expect(readFileSync(reopened.read(saved.fileId, saved.contentVersion), 'utf8')).toBe('# original')
  expect(reopened.versions(saved.fileId)).toHaveLength(1)
  // 日常查询在禁止写入的连接上仍可运行；不再逐文件探测或补齐结构。
  space.db.pragma('query_only = ON')
  const prepare = vi.spyOn(space.db, 'prepare')
  try {
    expect(new SpaceLifecycle(space).page({ spaceId: space.id }).items[0].reference).toBeTruthy()
    expect(new SpaceHistory(space).page({ spaceId: space.id, fileId: saved.fileId }).versions).toHaveLength(1)
    expect(inspectVersionReadiness(space).readyForWarehouseWrites).toBe(true)
    expect(versionPermissions(space).members[0]).toMatchObject({ revise: true, recycle: false })
    expect(prepare.mock.calls.some(([sql]) => /table_info|sqlite_master|ALTER TABLE|CREATE TABLE/i.test(sql))).toBe(false)
  } finally { prepare.mockRestore(); space.db.pragma('query_only = OFF') }
})

it('默认测试仓库与真实新库相同：只建随库版本空间，导入字节可读且重启保留', async () => {
  const h = openHost(); cleanups.push(h.cleanup)
  const binding = (await h.host.api.listFileSpaces()).find(s => s.embedded)!
  expect(binding).toMatchObject({ default: true, versioned: true, canRevise: true, canRecycle: true })
  expect(binding.root).toBe(join(h.root, 'file-spaces', 'default'))
  expect(existsSync(join(h.root, '.file-space.db'))).toBe(false)
  expect(existsSync(join(h.root, 'files'))).toBe(false)
  const [id] = await h.host.api.ingest([{ type: 'bytes', name: 'new.md', bytes: new TextEncoder().encode('# 新格式') }])
  await h.host.scheduler.idle()
  const ref = String(h.host.store.blocksOf(id).file.data.path)
  expect(parseSpaceReference(ref)).toMatchObject({ spaceId: binding.id, contentVersion: expect.any(String) })
  h.host.close()
  const next = openHost(undefined, undefined, h.root); cleanups.push(() => next.host.close())
  expect(readFileSync(next.host.lib.files.readable(ref), 'utf8')).toBe('# 新格式')
  expect(next.host.store.blocksOf(id).body.data.content).toBe('# 新格式')
})


it('增量准备失败整体回滚并关闭连接，修复后可以重新打开', () => {
  const root = join(directory(), 'space'); FileSpace.create(root, 'shared')
  const file = join(root, '.file-space.db'), db = new Database(file)
  db.exec('ALTER TABLE version_members DROP COLUMN revise; ALTER TABLE version_members DROP COLUMN recycle; ALTER TABLE version_drafts DROP COLUMN actor; DROP TABLE history_restorations; DROP TABLE version_import_batches')
  const schema = () => db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all()
  const before = schema(), exec = Database.prototype.exec
  let failed: Database.Database | undefined
  const fail = vi.spyOn(Database.prototype, 'exec').mockImplementation(function(this: Database.Database, sql: string) {
    if (sql.startsWith('CREATE TABLE history_restorations')) { failed = this; throw new Error('simulate schema failure') }
    return exec.call(this, sql)
  })
  try {
    expect(() => new FileSpace(root)).toThrow('simulate schema failure')
    expect(failed?.open).toBe(false)
    expect(schema()).toEqual(before)
  } finally { fail.mockRestore(); db.close() }
  const recovered = new FileSpace(root)
  try { expect(recovered.db.prepare('SELECT revise,recycle FROM version_members').all()).toEqual([]) }
  finally { recovered.close() }
})

it('只读路径适配报告未准备结构，不补表；受控打开后继续读取同一版本', async () => {
  const h = openHost(); cleanups.push(h.cleanup)
  const [id] = await h.host.api.ingest([{ type: 'bytes', name: 'read.txt', bytes: Buffer.from('keep') }]); await h.host.scheduler.idle()
  const ref = String(h.host.store.blocksOf(id).file.data.path), space = h.host.lib.files.bindings!.default().space
  const main = new LibraryFiles(h.root)
  space.db.exec('DROP TABLE missing_check')
  expect(readFileSync(main.readable(ref), 'utf8')).toBe('keep')
  space.db.exec('DROP TABLE history_restorations')
  const before = space.db.pragma('schema_version', { simple: true })
  expect(() => main.readable(ref)).toThrow('FILE_SPACE_SCHEMA_NOT_READY')
  expect(space.db.pragma('schema_version', { simple: true })).toBe(before)
  new FileSpace(space.root).close()
  expect(readFileSync(main.readable(ref), 'utf8')).toBe('keep')
  // 原始版本表丢失不能当作已知增量重建为空表。
  space.db.exec('DROP TABLE file_versions')
  const broken = space.db.pragma('schema_version', { simple: true })
  expect(() => new FileSpace(space.root)).toThrow('FILE_SPACE_SCHEMA_INCOMPLETE')
  expect(space.db.pragma('schema_version', { simple: true })).toBe(broken)
})
