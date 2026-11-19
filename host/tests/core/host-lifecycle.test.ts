import { afterEach, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { FileSpace } from '../../src/storage/file-space'
import { Host } from '../../src/core/host'
import { openLibrary } from '../../src/core/library'
import { Scheduler } from '../../src/core/scheduler'
import type { CorePlugin } from '../../src/core/plugin'
import { tempDir } from '../helpers/helpers'

const cleanups: (() => void)[] = []
afterEach(() => { vi.restoreAllMocks(); cleanups.splice(0).reverse().forEach(f => f()) })
const plugin: CorePlugin = { id: 'sample', version: 1, blocks: [{ id: 'sample', plugin: 'sample', title: '样本', version: 1, rebuildable: false,
  fields: { text: { type: 'text', title: '文字' } } }] }
const root = () => { const p = tempDir('rm-host-lifecycle-'); cleanups.push(() => rmSync(p, { recursive: true, force: true })); return p }

it.each([false, true])('迁移失败释放数据库和仓库锁，可重新打开；注入 library：%s', injected => {
  const p = root(), first = new Host(p, [plugin], () => {}, { manifest: [] })
  const id = first.api.create({ sample: { text: 'keep' } }); first.close()
  const lib = injected ? openLibrary(p) : undefined
  if (lib) cleanups.push(() => { if (lib.db.open) lib.close() })
  const newer = { ...plugin, blocks: plugin.blocks!.map(b => ({ ...b, version: 2 })) }
  expect(() => new Host(p, [newer], () => {}, { manifest: [], library: lib })).toThrow(/缺少迁移/)
  if (lib) expect(lib.db.open).toBe(false)
  const reopened = new Host(p, [plugin], () => {}, { manifest: [] })
  try { expect(reopened.store.blocksOf(String(id)).sample.data.text).toBe('keep') } finally { reopened.close() }
})

it('调度器创建后的初始化失败停止后台任务，并保留原始错误', () => {
  const p = root(), first = new Host(p, [plugin], () => {}, { manifest: [] })
  first.api.create({ sample: { text: '不能因失败打开而清理历史' } }); first.close()
  const lib = openLibrary(p), stop = vi.spyOn(Scheduler.prototype, 'stop')
  const before = lib.db.prepare('SELECT * FROM block_history').all()
  cleanups.push(() => { if (lib.db.open) lib.close() })
  vi.spyOn(Scheduler.prototype, 'rescan').mockImplementation(() => { throw new Error('模拟后段初始化失败') })
  expect(() => new Host(p, [plugin], () => {}, { library: lib, manifest: [] })).toThrow('模拟后段初始化失败')
  expect(stop).toHaveBeenCalledOnce()
  expect(lib.db.open).toBe(false)
  const reopened = openLibrary(p)
  try { expect(reopened.db.prepare('SELECT * FROM block_history').all()).toEqual(before) }
  finally { reopened.close() }
})

it('重复关闭安全；一个 stop 失败仍停止其他组件并释放库', () => {
  const p = root(), h = new Host(p, [plugin], () => {}, { manifest: [] })
  const stop = vi.spyOn(h.scheduler, 'stop').mockImplementation(() => { throw new Error('模拟 stop 失败') })
  expect(() => h.close()).toThrow('模拟 stop 失败')
  expect(h.lib.db.open).toBe(false)
  expect(() => h.close()).not.toThrow()
  expect(stop).toHaveBeenCalledOnce()
  const lib = openLibrary(p); lib.close()
})


it('单独打开仓库已准备文件业务结构，装配服务不再执行 DDL', () => {
  const p = root(), lib = openLibrary(p)
  cleanups.push(() => { if (lib.db.open) lib.close() })
  const tables = lib.db.prepare("SELECT name FROM main.sqlite_master WHERE type='table'").pluck().all()
  expect(tables).toEqual(expect.arrayContaining(['file_spaces', 'space_adoptions', 'ingest_pending', 'space_import_seen', 'space_import_inputs',
    'space_update_cursor', 'space_updates', 'file_edits', 'file_edit_requests']))
  expect(() => lib.db.prepare("INSERT INTO file_spaces VALUES ('other','path','token','pending',0,1)").run()).toThrow(/UNIQUE/)
  const exec = vi.spyOn(lib.db, 'exec'), h = new Host(p, [plugin], () => {}, { library: lib, manifest: [] })
  try { expect(exec.mock.calls.some(([sql]) => /CREATE\s+(TABLE|INDEX)|ALTER\s+TABLE/i.test(sql))).toBe(false) }
  finally { h.close() }
})

it.each(['op', 'new_data'])('仓库准备补齐历史列 %s，重开保留已有数据与任务且不执行恢复', missing => {
  const p = root(), lib = openLibrary(p), id = lib.id
  lib.db.prepare("INSERT INTO entity VALUES ('item',1,NULL)").run()
  lib.db.prepare("INSERT INTO block_history VALUES ('item','sample',1,'{\"text\":\"before\"}',1,NULL,NULL)").run()
  lib.db.prepare("INSERT INTO ingest_pending VALUES ('pending','signature','{\"drafts\":[]}')").run()
  lib.db.prepare("INSERT INTO file_edits VALUES ('edit','prepare','{\"owner\":\"local\",\"commit\":{\"requestId\":\"commit\"}}')").run()
  lib.db.prepare("INSERT INTO file_edit_requests VALUES ('commit','signature')").run()
  lib.db.prepare("INSERT INTO operation_receipt VALUES ('operation','signature','{\"ok\":true}',1)").run()
  lib.db.prepare("INSERT INTO space_update_cursor VALUES ('offline-space',7)").run()
  lib.db.prepare("INSERT INTO space_updates VALUES ('offline-space','file','version','retry')").run()
  lib.db.prepare("INSERT INTO file_spaces VALUES ('offline-space','missing','token','detaching',0,0)").run()
  const names = ['entity', 'ingest_pending', 'file_edits', 'file_edit_requests', 'operation_receipt', 'space_update_cursor', 'space_updates', 'file_spaces']
  const records = (db: Database.Database) => names.map(name => db.prepare(`SELECT * FROM ${name}`).all())
  const before = records(lib.db)
  if (missing === 'op') lib.db.exec('DROP INDEX history_op')
  lib.db.exec(`ALTER TABLE block_history DROP COLUMN ${missing}`); lib.close()
  const reopened = openLibrary(p)
  try {
    expect(reopened.id).toBe(id)
    expect(records(reopened.db)).toEqual(before)
    expect(reopened.db.prepare('SELECT data,op,new_data FROM block_history').get()).toEqual({ data: '{\"text\":\"before\"}', op: null, new_data: null })
    const schemaVersion = reopened.db.pragma('schema_version', { simple: true }); reopened.close()
    const again = openLibrary(p)
    try { expect(again.db.pragma('schema_version', { simple: true })).toBe(schemaVersion) } finally { again.close() }
  } finally { if (reopened.db.open) reopened.close() }
})

it('仓库结构准备失败回滚本次补表补列，释放连接与锁后可重试', () => {
  const p = root(), lib = openLibrary(p)
  lib.db.exec('DROP TABLE file_edits; ALTER TABLE block_history DROP COLUMN new_data'); lib.close()
  const db = new Database(join(p, 'library.db'))
  const schema = () => db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all(), before = schema()
  const original = Database.prototype.exec
  let failed: Database.Database | undefined
  const fail = vi.spyOn(Database.prototype, 'exec').mockImplementation(function(this: Database.Database, sql: string) {
    if (sql.includes('CREATE INDEX IF NOT EXISTS main.history_op')) { failed = this; throw new Error('模拟结构准备失败') }
    return original.call(this, sql)
  })
  try {
    expect(() => openLibrary(p)).toThrow('模拟结构准备失败')
    expect(failed?.open).toBe(false)
    expect(schema()).toEqual(before)
    expect(existsSync(join(p, '.lock'))).toBe(false)
  } finally { fail.mockRestore(); db.close() }
  const reopened = openLibrary(p)
  try { expect(reopened.db.prepare('SELECT count(*) FROM file_edits').pluck().get()).toBe(0) }
  finally { reopened.close() }
})

it('随库空间创建中断保留独立恢复标记，重开接续同一仓库与空间', () => {
  const p = root(), fail = vi.spyOn(FileSpace.prototype, 'connect').mockImplementationOnce(() => { throw new Error('模拟关联中断') })
  try { expect(() => openLibrary(p)).toThrow('模拟关联中断') } finally { fail.mockRestore() }
  const db = new Database(join(p, 'library.db'))
  let id: string
  try {
    id = String(db.prepare("SELECT value FROM meta WHERE key='library_id'").pluck().get())
    expect(db.prepare("SELECT value FROM meta WHERE key='managed_space_pending'").pluck().get()).toBe('file-spaces/default')
    expect(db.prepare('SELECT count(*) FROM file_spaces').pluck().get()).toBe(0)
  } finally { db.close() }
  const space = new FileSpace(join(p, 'file-spaces/default')), spaceId = space.id; space.close()
  const reopened = openLibrary(p)
  try {
    expect(reopened.id).toBe(id)
    expect(reopened.files.bindings!.default().space.id).toBe(spaceId)
    expect(reopened.db.prepare("SELECT 1 FROM meta WHERE key='managed_space_pending'").get()).toBeUndefined()
  } finally { reopened.close() }
})
