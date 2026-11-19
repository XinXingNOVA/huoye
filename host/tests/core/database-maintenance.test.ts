import { afterEach, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { openHost } from '../helpers/helpers'

const cleanups: (() => void)[] = []
afterEach(() => { vi.restoreAllMocks(); cleanups.splice(0).reverse().forEach(f => f()) })

it('旧会话清理留下可复用页；整理缩小库文件，保留数据、当前撤销链、回执和未完成任务', async () => {
  const first = openHost(); cleanups.push(first.cleanup)
  const id = await first.host.api.create({ note: { text: 'x'.repeat(2 * 1024 * 1024) } })
  await first.host.api.put(id, 'note', { text: '当前内容' })
  const request = { operation: 'create_text', requestId: 'survives-retention', args: { content: '回执对应的素材' } }
  const receipt = await first.host.api.executeOperation(request)
  first.host.close()
  const { host } = openHost(undefined, undefined, first.root)
  cleanups.push(() => host.close())
  const db = host.lib.db
  for (const table of ['operation', 'block_history', 'op_entity', 'record_history'])
    expect(db.prepare(`SELECT count(*) FROM ${table}`).pluck().get()).toBe(0)
  expect(await host.api.executeOperation(request)).toEqual({ ...receipt, replayed: true })
  // 持久任务是另一条恢复链，不能因释放数据库空间而删除。
  db.exec(`INSERT INTO ingest_pending VALUES ('pending','signature','{"drafts":[]}');
    INSERT INTO file_edits VALUES ('edit','prepare','{"owner":"local"}');
    INSERT INTO file_edit_requests VALUES ('commit','signature');`)
  await host.api.put(id, 'note', { text: '本会话编辑' })
  const tables = ['entity', 'block', 'kind_def', 'operation', 'block_history', 'op_entity', 'record_history',
    'operation_receipt', 'ingest_pending', 'file_edits', 'file_edit_requests', 'file_spaces']
  const snapshot = () => tables.map(table => db.prepare(`SELECT * FROM main.${table}`).all())
  const before = snapshot(), page = await host.api.listHistory(), info = await host.api.databaseStorageInfo()
  expect(info.reusableBytes).toBeGreaterThan(2 * 1024 * 1024)
  db.pragma('wal_checkpoint(TRUNCATE)')
  const diskBefore = statSync(join(first.root, 'library.db')).size
  const result = await host.api.compactDatabase()
  expect(result.checkpointPending).toBe(false)
  expect(result.after.allocatedBytes).toBeLessThan(result.before.allocatedBytes)
  expect(result.after.reusableBytes).toBe(0)
  expect(statSync(join(first.root, 'library.db')).size).toBeLessThan(diskBefore)
  expect(snapshot()).toEqual(before)
  expect(await host.api.listHistory()).toEqual(page)
  host.api.undo({ session: page.session, revision: page.revision, id: page.undo!.id })
  expect(host.store.blocksOf(id).note.data.text).toBe('当前内容')
  host.api.redo()
  expect(host.store.blocksOf(id).note.data.text).toBe('本会话编辑')
  expect(await host.api.executeOperation(request)).toEqual({ ...receipt, replayed: true })
})

it('活动事务或读取锁阻止整理；失败后撤销链和数据仍可用，释放锁可重试', async () => {
  const h = openHost(); cleanups.push(h.cleanup)
  const { host } = h, db = host.lib.db
  const id = await host.api.create({ note: { text: 'before' } })
  const reader = new Database(join(h.root, 'library.db'), { readonly: true })
  try {
    reader.exec('BEGIN'); reader.prepare('SELECT * FROM block').all()
    await host.api.put(id, 'note', { text: 'after' })
    const page = await host.api.listHistory()
    db.pragma('busy_timeout = 1')
    expect(() => host.api.compactDatabase()).toThrow('DATABASE_BUSY')
    expect(await host.api.listHistory()).toEqual(page)
    reader.exec('ROLLBACK')
    expect(() => host.store.batch(() => host.api.compactDatabase())).toThrow('DATABASE_BUSY')
    const exec = vi.spyOn(db, 'exec').mockImplementationOnce(() => { throw new Error('模拟整理写入失败') })
    expect(() => host.api.compactDatabase()).toThrow('模拟整理写入失败')
    exec.mockRestore()
    expect(host.store.blocksOf(id).note.data.text).toBe('after')
    expect(await host.api.listHistory()).toEqual(page)
    await host.api.compactDatabase()
    host.api.undo()
    expect(host.store.blocksOf(id).note.data.text).toBe('before')
  } finally { reader.close() }
})
