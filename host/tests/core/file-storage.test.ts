import { randomUUID } from 'node:crypto'
import { identifyFiles } from '../../src/core/file-identity'
import { afterEach, expect, it, vi } from 'vitest'
import { mkdirSync, readFileSync, readdirSync, rmSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { LibraryFiles } from '../../src/storage/library-files'
import { fileReference, libraryFileUrl, localFilePath } from '../../src/shared/file-location'
import { serveLibraryFile } from '../../src/main/lib-protocol'
import { openHost, tempDir } from '../helpers/helpers'

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).reverse().forEach(fn => fn()))
const temp = () => { const root = tempDir('rm-storage-'); cleanups.push(() => rmSync(root, { recursive: true, force: true })); return root }
it('缓存可读写；缺失、非法路径和库外链接不可混淆', async () => {
  const root = temp(), files = new LibraryFiles(root), outside = temp()
  files.initialize(); files.write('cache/a.txt', '派生数据')
  expect(readFileSync(files.readable('cache\\a.txt'), 'utf8')).toBe('派生数据')
  expect(await (await serveLibraryFile(root, new Request(libraryFileUrl('library', 'cache/a.txt')))).text()).toBe('派生数据')
  writeFileSync(join(outside, 'a.txt'), '不可修改'); symlinkSync(outside, join(root, 'cache/external'), 'dir')
  expect(files.status('cache/missing.txt')).toEqual({ state: 'missing' })
  expect(files.status('cache/external/a.txt').state).toBe('unavailable')
  for (const ref of ['../escape', '/abs', 'C:\\source.txt', 'cache/../../library.db', 'cache/external/a.txt', 'library.db']) expect(() => files.write(ref, 'bad')).toThrow()
  expect(() => files.directory('cache/external/new')).toThrow()
  expect((await serveLibraryFile(root, new Request('lib://library/cache/external/a.txt'))).status).toBe(403)
  files.removeCache('cache/a.txt'); expect(files.status('cache/a.txt').state).toBe('missing')
  expect(readFileSync(join(outside, 'a.txt'), 'utf8')).toBe('不可修改')
})
it('旧原件即使存在也不再按相对路径读取或删除，缓存 API 不能写原件', async () => {
  const root = temp(), files = new LibraryFiles(root), ref = 'files/old/a.txt'
  mkdirSync(join(root, 'files/old'), { recursive: true }); writeFileSync(join(root, ref), '旧原件')
  expect(() => files.readable(ref)).toThrow('LEGACY_STORAGE_UNSUPPORTED')
  expect(files.status(ref).state).toBe('unavailable')
  expect(() => files.write(ref, 'bad')).toThrow('VERSION_PROTOCOL_REQUIRED')
  files.removeCache(ref)
  expect((await serveLibraryFile(root, new Request(libraryFileUrl('library', ref)))).status).toBe(403)
  expect(readFileSync(join(root, ref), 'utf8')).toBe('旧原件')
})
it('空间发布独立于仓库收录，失败后保留内容与回执；重试不重复发布', async () => {
  const h = openHost(); cleanups.push(h.cleanup)
  const source = join(temp(), '原文件.txt'); writeFileSync(source, '内容')
  const pending = h.host.lib.files.beginImport('retry-batch')
  const first = await pending.stage('a', source, '原文件.txt', '0'); pending.dispose()
  expect(readFileSync(h.host.lib.files.readable(first.reference), 'utf8')).toBe('内容')
  expect((await h.host.api.query({})).ids).toEqual([])
  const retry = h.host.lib.files.beginImport('retry-batch')
  const second = await retry.stage('b', source, '原文件.txt', '0'); retry.dispose()
  expect(second.reference).toBe(first.reference)
  const storage = h.host.lib.files.bindings!.default().space
  expect(storage.db.prepare('SELECT count(*) FROM file_versions').pluck().get()).toBe(1)
  expect(readdirSync(join(storage.root, 'cache/ingest'))).toEqual([])
  const destination = join(temp(), 'copy.txt')
  await h.host.lib.files.copyOut(first.reference, destination)
  await expect(h.host.lib.files.copyOut(first.reference, destination)).rejects.toThrow()
  expect(readFileSync(source, 'utf8')).toBe('内容'); expect(readFileSync(destination, 'utf8')).toBe('内容')
})
it('跨平台名称与定位规则一致，拒绝歧义和路径穿越', () => {
  expect(localFilePath('C:\\资料库', 'cache\\a\\照片.png')).toBe('C:/资料库/cache/a/照片.png')
  for (const ref of ['', '.', 'files//a', 'files/./a', 'files/../a', '//host/a', 'C:/a', 'files/a\0']) expect(() => fileReference(ref)).toThrow()
})

it('核心与只读主进程对版本内容、篡改、链接和回收状态采用相同读取规则', async () => {
  const h = openHost(); cleanups.push(h.cleanup)
  const source = join(temp(), 'read.txt'); writeFileSync(source, 'content')
  const [id] = await h.host.api.ingest([{ type: 'file', path: source }]); await h.host.scheduler.idle()
  const ref = String(h.host.store.blocksOf(id).file.data.path), core = h.host.lib.files, main = new LibraryFiles(h.root)
  const path = core.readable(ref), space = core.bindings!.default().space
  const verify = (error?: string) => { for (const files of [core, main]) {
    if (error) expect(() => files.readable(ref)).toThrow(error)
    else expect(readFileSync(files.readable(ref), 'utf8')).toBe('content')
  } }
  verify()
  const before = space.db.pragma('data_version', { simple: true })
  main.storageInfo(ref); main.readable(ref)
  expect(space.db.pragma('data_version', { simple: true })).toBe(before)
  const backup = path + '.backup'; renameSync(path, backup)
  verify('ENOENT')
  symlinkSync(backup, path); verify('INVALID_FILE_REFERENCE'); rmSync(path)
  writeFileSync(path, 'tampered'); verify('FILE_CHANGED'); rmSync(path); renameSync(backup, path)
  verify()
  const fileId = core.record(ref)!.id
  space.db.prepare("UPDATE files SET state='recycled' WHERE id=?").run(fileId); verify('FILE_UNAVAILABLE')
  space.db.prepare("UPDATE files SET state='available' WHERE id=?").run(fileId)
  h.host.lib.db.prepare("UPDATE file_spaces SET state='detached' WHERE id=?").run(space.id); verify('SPACE_NOT_LINKED')
})

it('回拖只检查所选版本候选，保持重复路径、显示名、回收站与无效引用语义', async () => {
  const h = openHost(); cleanups.push(h.cleanup)
  const source = join(temp(), 'drag.txt'); writeFileSync(source, 'drag')
  const [id] = await h.host.api.ingest([{ type: 'file', path: source }]); await h.host.scheduler.idle()
  const original = h.host.store.blocksOf(id).file.data, path = h.host.lib.files.readable(String(original.path))
  const db = h.host.lib.db, files = new LibraryFiles(h.root)
  // 大量无关引用排在目标之前；识别不得逐项打开原件。
  db.transaction(() => { for (let i = 0; i < 1000; i++) {
    const other = `000-${i}`
    db.prepare('INSERT INTO entity VALUES (?,0,NULL)').run(other)
    db.prepare('INSERT INTO block VALUES (?,\'file\',?,1,1,0)').run(other, JSON.stringify({ ...original, path: `spaces/v2/${randomUUID()}/${randomUUID()}/${randomUUID()}/unrelated.txt` }))
  } })()
  const read = vi.spyOn(files, 'readable')
  const renamed = String(original.path).replace(/[^/]+$/, 'display-name.txt').replaceAll('/', '\\')
  db.prepare("UPDATE block SET data=? WHERE entity_id=? AND kind='file'").run(JSON.stringify({ ...original, path: renamed }), id)
  expect(identifyFiles(db, files, [path, source, path])).toEqual([id, null, id])
  expect(read).toHaveBeenCalledTimes(1)
  db.prepare('UPDATE entity SET deleted_at=1 WHERE id=?').run(id)
  expect(identifyFiles(db, files, [path])).toEqual([null])
  db.prepare('UPDATE entity SET deleted_at=NULL WHERE id=?').run(id)
  rmSync(path)
  expect(identifyFiles(db, files, [path])).toEqual([null])
})
