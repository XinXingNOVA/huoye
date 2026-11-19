import Database from 'better-sqlite3'
import { execFileSync } from 'node:child_process'
import { afterEach, expect, it } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { auditLibrary } from '../../scripts/storage/audit-library'
import { openHost, tempDir } from '../helpers/helpers'

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).reverse().forEach(fn => fn()))
function fixture() { const h = openHost(); cleanups.push(h.cleanup); return h }
function tree(root: string): Record<string, string> {
  const files: Record<string, string> = {}
  const visit = (dir: string) => { for (const e of readdirSync(dir, { withFileTypes: true })) { const path = join(dir, e.name); if (e.isDirectory()) visit(path); else files[path] = createHash('sha256').update(readFileSync(path)).digest('hex') } }
  visit(root); return files
}
function raw(root: string, fn: (db: Database.Database) => void) { const db = new Database(join(root, 'library.db')); try { fn(db) } finally { db.close() } }

it('新版仓库检查不打开 Host、不建表、不改数据库或字节；结果可重复', async () => {
  const h = fixture()
  await h.host.api.ingest([{ type: 'bytes', name: 'new.md', bytes: new TextEncoder().encode('# versioned') }]); await h.host.scheduler.idle(); h.host.close()
  const before = tree(h.root), report = auditLibrary(h.root)
  expect(report.status).toBe('clear'); expect(report.counts.legacyReferences).toBe(0)
  expect(report.spaces).toEqual([expect.objectContaining({ version: 4, state: 'versioned', binding: 'active' })])
  expect(JSON.parse(execFileSync(process.execPath, ['scripts/storage/audit.ts', '--json', h.root], { encoding: 'utf8' }))).toEqual([report])
  expect(auditLibrary(h.root)).toEqual(report); expect(tree(h.root)).toEqual(before)
})

it('快照包含已提交但未 checkpoint 的 WAL，不在来源目录新增或改变辅助文件', async () => {
  const h = fixture()
  const [id] = await h.host.api.ingest([{ type: 'bytes', name: 'wal.md', bytes: new TextEncoder().encode('wal') }]); await h.host.scheduler.idle()
  h.host.lib.db.prepare("UPDATE block SET data=json_set(data,'$.path','files/old/wal.md') WHERE entity_id=? AND kind='file'").run(id)
  h.host.api.trash([id])
  const before = tree(h.root), report = auditLibrary(h.root)
  expect(report.counts.legacyReferences).toBe(1); expect(report.samples[0].trashed).toBe(true)
  expect(report.issues.some(i => i.code === 'open-library')).toBe(true)
  expect(tree(h.root)).toEqual(before)
})

it('覆盖回收站、休眠文件列表及未知嵌套字段；样本有界，计数不截断', async () => {
  const h = fixture()
  const [id] = await h.host.api.ingest([{ type: 'bytes', name: 'old.txt', bytes: new TextEncoder().encode('old') }])
  const fileId = randomUUID(), ref = `shared/${fileId}/old.txt`
  h.host.lib.db.prepare("UPDATE block SET data=json_set(data,'$.path',?) WHERE entity_id=? AND kind='file'").run(ref, id)
  writeFileSync(join(h.root, '.file-storage.json'), '{}')
  const old = new Database(join(h.root, '.file-space.db')); old.exec('CREATE TABLE space (id TEXT,version INTEGER)'); old.prepare('INSERT INTO space VALUES (?,2)').run(randomUUID()); old.close()
  h.host.lib.db.prepare('INSERT INTO kind_def VALUES (?,?)').run('sleeping', JSON.stringify({ id: 'sleeping', dormant: true, fields: { files: { file: true, list: true, type: 'text' }, value: { type: 'json' } } }))
  h.host.lib.db.prepare('INSERT INTO block VALUES (?,?,?,1,999,0)').run(id, 'sleeping', JSON.stringify({ files: [ref, `files\\${fileId}\\old.txt`], value: { suspicious: ref } }))
  h.host.api.trash([id]); await h.host.scheduler.idle(); h.host.close()
  const before = tree(h.root), report = auditLibrary(h.root, 1)
  expect(report.status).toBe('review'); expect(report.counts.legacyReferences).toBe(3)
  expect(report.counts.undeclaredCandidates).toBe(1); expect(report.samples).toHaveLength(1); expect(report.samples[0].trashed).toBe(true)
  expect(report.issues.map(i => i.code)).toEqual(expect.arrayContaining(['legacy-space', 'legacy-sharing-index', 'legacy-references', 'undeclared-candidates']))
  expect(tree(h.root)).toEqual(before)
})

it('迁移后的历史引用、封存空间和备份不算活跃旧依赖', () => {
  const h = fixture(); h.host.close()
  const db = new Database(join(h.root, '.file-space.db'))
  db.exec('CREATE TABLE space (id TEXT, version INTEGER)'); db.prepare('INSERT INTO space VALUES (?,5)').run(randomUUID()); db.close()
  mkdirSync(join(h.root, 'backups', 'old')); writeFileSync(join(h.root, 'backups', 'old', '.file-storage.json'), 'archived')
  raw(h.root, db => db.prepare('INSERT INTO block_history (entity_id,kind,seq,data,at,new_data) VALUES (?,?,1,?,0,?)').run('old', 'file', JSON.stringify({ path: 'files/old/a.txt' }), JSON.stringify({ path: 'shared/old/a.txt' })))
  const report = auditLibrary(h.root)
  expect(report.counts.historyReferences).toBe(2); expect(report.status).toBe('clear')
  expect(report.spaces.some(s => s.state === 'retired')).toBe(true)
})

it('未完成导入、编辑、发布、迁移收尾和旧恢复记录都会报告，已结束记录不阻挡', () => {
  const h = fixture(); h.host.close()
  raw(h.root, db => {
    db.prepare('INSERT INTO ingest_pending VALUES (?,?,?)').run('pending', 'sig', '{}')
    for (const [id, data] of [['pending', {}], ['accepted', { result: { library: { state: 'accepted' } } }], ['discarded', { discarded: true }]]) db.prepare('INSERT INTO file_edits VALUES (?,?,?)').run(id, id, JSON.stringify(data))
    db.exec('CREATE TABLE space_publications (request_id TEXT PRIMARY KEY, signature TEXT NOT NULL, input TEXT NOT NULL, result TEXT)')
    db.prepare('INSERT INTO space_publications VALUES (?,?,?,NULL)').run('pending', 'sig', '{}')
    db.exec('CREATE TABLE file_migrations (id TEXT PRIMARY KEY, data TEXT NOT NULL)')
    for (const [id, data] of [['unfinished', { state: 'complete', retired: false }], ['finished', { state: 'complete', retired: true }], ['abandoned', { state: 'abandoned' }]]) db.prepare('INSERT INTO file_migrations VALUES (?,?)').run(id, JSON.stringify(data))
  })
  mkdirSync(join(h.root, '.file-recovery')); writeFileSync(join(h.root, '.file-recovery', 'unfinished'), '{}')
  const report = auditLibrary(h.root)
  expect(report.status).toBe('review'); expect(report.counts.tasks).toBe(5)
})

it('版本草稿单独报告；旧分享入口、存储发布与接收方法已退出', async () => {
  const h = fixture()
  expect((h.host.api as any).prepareFileShare).toBeUndefined(); expect((h.host.api as any).acceptFileShare).toBeUndefined()
  expect((h.host.lib.files as any).publish).toBeUndefined(); expect((h.host.lib.files as any).shared).toBeUndefined()
  const [id] = await h.host.api.ingest([{ type: 'bytes', name: 'draft.md', bytes: new TextEncoder().encode('before') }])
  await h.host.api.prepareFileEdit({ id, destination: { mode: 'publish' }, content: { type: 'text', text: 'after' }, requestId: randomUUID() })
  await h.host.scheduler.idle(); h.host.close()
  expect(auditLibrary(h.root).issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'unfinished', message: expect.stringContaining('版本草稿') })]))
})

it('已解除的离线空间不重新访问；删除关联不掩盖旧引用，活跃离线空间使检查不完整', () => {
  const h = fixture(); h.host.close()
  const id = randomUUID(), missing = join(h.root, 'deleted-space')
  raw(h.root, db => db.prepare('INSERT INTO file_spaces VALUES (?,?,?, ?,0,0)').run(id, missing, 'old-token', 'detached'))
  expect(auditLibrary(h.root).status).toBe('clear'); expect(existsSync(missing)).toBe(false)
  raw(h.root, db => {
    db.prepare('DELETE FROM file_spaces WHERE id=?').run(id)
    db.prepare('INSERT INTO entity VALUES (?,0,NULL)').run('lost')
    db.prepare('INSERT INTO block VALUES (?,?,?,1,1,0)').run('lost', 'file', JSON.stringify({ path: `spaces/v1/${id}/${randomUUID()}/missing.txt` }))
  })
  expect(auditLibrary(h.root).counts.legacyReferences).toBe(1)
  raw(h.root, db => db.prepare('INSERT INTO file_spaces VALUES (?,?,?, ?,0,0)').run(id, missing, 'old-token', 'active'))
  expect(auditLibrary(h.root).status).toBe('incomplete'); expect(existsSync(missing)).toBe(false)
})

it('损坏数据、缺失数据库及数据库符号链接不能误报为检查通过', () => {
  const h = fixture(); h.host.close()
  raw(h.root, db => db.prepare('INSERT INTO block VALUES (?,?,?,1,1,0)').run('broken', 'file', '{broken'))
  expect(auditLibrary(h.root).status).toBe('incomplete')
  const missing = join(h.root, 'missing'); expect(auditLibrary(missing).status).toBe('incomplete'); expect(existsSync(missing)).toBe(false)
  const link = tempDir('rm-audit-link-'); cleanups.push(() => rmSync(link, { recursive: true, force: true }))
  symlinkSync(join(h.root, 'library.db'), join(link, 'library.db'))
  expect(auditLibrary(link).issues.some(i => i.message.includes('符号链接'))).toBe(true)
})
