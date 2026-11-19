import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { FileSpace } from '../../src/storage/file-space'
import { LibraryFiles } from '../../src/storage/library-files'
import { openHost, tempDir } from '../helpers/helpers'

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).reverse().forEach(fn => fn()))
const temp = () => { const root = tempDir('rm-retirement-'); cleanups.push(() => rmSync(root, { recursive: true, force: true })); return root }
const snapshot = (root: string) => Object.fromEntries(readdirSync(root, { recursive: true, withFileTypes: true }).filter(f => f.isFile()).map(f => [join(f.parentPath, f.name), readFileSync(join(f.parentPath, f.name)).toString('base64')]))
function modern() { const h = openHost(); cleanups.push(h.cleanup); return h }

it.each([1, 2, 3, 5])('旧空间 v%s 拒绝打开，不建表、不改原件和登记', version => {
  const root = temp(), db = new Database(join(root, '.file-space.db'))
  db.exec('CREATE TABLE space (id TEXT,version INTEGER)'); db.prepare('INSERT INTO space VALUES (?,?)').run(randomUUID(), version); db.close()
  mkdirSync(join(root, 'files')); writeFileSync(join(root, 'files', 'old.txt'), 'original')
  const before = snapshot(root)
  expect(() => new FileSpace(root)).toThrow('LEGACY_STORAGE_UNSUPPORTED')
  expect(snapshot(root)).toEqual(before)
})
it('旧仓库拒绝初始化；保留旧数据库、共享登记和字节', () => {
  const root = temp(), db = new Database(join(root, 'library.db'))
  db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY,value TEXT); INSERT INTO meta VALUES ('library_id','old'); CREATE TABLE block (data TEXT)"); db.close()
  writeFileSync(join(root, '.file-storage.json'), '{"files":[]}')
  const before = snapshot(root)
  expect(() => openHost(undefined, undefined, root)).toThrow('LEGACY_STORAGE_UNSUPPORTED')
  expect(snapshot(root)).toEqual(before); expect(readdirSync(root).sort()).toEqual(['.file-storage.json', 'library.db'])
})
it.each(['pending', 'complete'])('未完成旧迁移或未封存收尾不由新版续跑 (%s)', state => {
  const h = modern(); h.host.close()
  const db = new Database(join(h.root, 'library.db'))
  db.exec('CREATE TABLE file_migrations (id TEXT,data TEXT)'); db.prepare('INSERT INTO file_migrations VALUES (?,?)').run('old', JSON.stringify({state,retired:false}));db.close()
  const before = snapshot(h.root)
  expect(() => openHost(undefined,undefined,h.root)).toThrow('LEGACY_STORAGE_UNSUPPORTED')
  expect(snapshot(h.root)).toEqual(before)
})
it('旧恢复日志只阻止打开，不自动重放；完成迁移的封存记录可保留', () => {
  const h = modern(); h.host.close()
  const db = new Database(join(h.root,'library.db'))
  db.exec('CREATE TABLE file_migrations (id TEXT,data TEXT)');db.prepare('INSERT INTO file_migrations VALUES (?,?)').run('done',JSON.stringify({state:'complete',retired:true}));db.close()
  mkdirSync(join(h.root,'.file-recovery')); writeFileSync(join(h.root,'.file-recovery','interrupted'), '{}')
  const before = snapshot(h.root)
  expect(() => openHost(undefined,undefined,h.root)).toThrow('LEGACY_STORAGE_UNSUPPORTED')
  expect(snapshot(h.root)).toEqual(before)
  rmSync(join(h.root,'.file-recovery'),{recursive:true}) // 测试夹具明确移走；产品不会删除日志。
  const reopened = openHost(undefined,undefined,h.root);reopened.host.close()
})
it('新版仓库残留旧引用：业务数据可读，旧原件读取与另存都拒绝；迁移 RPC 已退出', async () => {
  const h = modern(), [id] = await h.host.api.ingest([{ type:'text',text:'保留文字和笔记' }])
  h.host.api.put(id,'note',{text:'保留笔记'})
  const ref = `spaces/v1/${randomUUID()}/${randomUUID()}/old.md`
  h.host.lib.db.prepare("INSERT INTO block VALUES (?, 'file', ?, 1, 100, 0)").run(id,JSON.stringify({path:ref,name:'old.md',ext:'md',hash:'a'.repeat(64),size:0}))
  await h.host.scheduler.idle(); h.host.close()
  const reopened = openHost(undefined,undefined,h.root);cleanups.push(() => reopened.host.close())
  expect(reopened.host.store.blocksOf(id).note.data.text).toBe('保留笔记')
  expect(() => reopened.host.lib.files.readable(ref)).toThrow('LEGACY_STORAGE_UNSUPPORTED')
  expect(() => new LibraryFiles(h.root).readable(ref)).toThrow('LEGACY_STORAGE_UNSUPPORTED')
  await expect(reopened.host.api.makeFileIndependent(id)).rejects.toThrow()
  for (const key of ['previewFileMigration','fileMigrations','reconnectFileStorage']) expect((reopened.host.api as any)[key]).toBeUndefined()
})

it('新导入不按哈希复用残留旧引用的不可用素材', async () => {
  const h = modern(), input = { type: 'bytes' as const, name: 'same.txt', bytes: new TextEncoder().encode('same') }
  const [old] = await h.host.api.ingest([input]); await h.host.scheduler.idle()
  h.host.api.put(old, 'note', { text: '旧记录保留' })
  const file = h.host.store.blocksOf(old).file.data, parts = String(file.path).split('/')
  const legacy = `spaces/v1/${parts[2]}/${parts[3]}/${parts[5]}`
  h.host.lib.db.prepare("UPDATE block SET data=json_set(data,'$.path',?) WHERE entity_id=? AND kind='file'").run(legacy, old)
  const [fresh] = await h.host.api.ingest([input]); await h.host.scheduler.idle()
  expect(fresh).not.toBe(old)
  expect(h.host.store.blocksOf(old).note.data.text).toBe('旧记录保留')
  expect(h.host.store.blocksOf(old).file.data.path).toBe(legacy)
  expect(h.host.lib.files.status(String(h.host.store.blocksOf(fresh).file.data.path)).state).toBe('available')
})
