import { expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { copyFileSync, mkdirSync, realpathSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { openHost, tempDir } from '../helpers/helpers'
import { DirectorySpaces } from '../../src/storage/directory-spaces'
import { serveLibraryFile } from '../../src/main/lib-protocol'

it('collects by suffix into each library independently and follows a relocated original while protecting library annotations', async () => {
  const a = openHost(), b = openHost(), home = tempDir()
  const catalog = join(home, 'catalog')
  vi.stubEnv('HUOYE_DIRECTORY_CATALOG', catalog)
  try {
    const origin = join(home, 'media'), file = join(origin, 'paper.MD'), copied = join(origin, 'copy.MD')
    mkdirSync(origin); writeFileSync(file, 'notes'); writeFileSync(join(origin, 'skip.bin'), 'other')
    const spaces = new DirectorySpaces(catalog), link = spaces.attach(a.host.lib, origin)
    const scan = () => spaces.refreshTree(a.host.lib, link.id, new AbortController().signal)
    await scan()
    const preview = () => a.host.api.previewDirectoryCollection(link.id, ['md'])
    const first = await preview()
    expect(first).toMatchObject({ pending: 1, existing: 0 })
    copyFileSync(file, copied); await scan()
    await expect(a.host.api.collectDirectoryFiles(link.id, ['md'], first.token)).rejects.toThrow('重新预览')
    const result = await a.host.api.collectDirectoryFiles(link.id, ['md'], (await preview()).token)
    expect(result).toMatchObject({ created: 2, failed: 0 })
    expect(await preview()).toMatchObject({ pending: 0, existing: 2 })
    expect(() => b.host.api.previewDirectoryCollection(link.id, ['md'])).toThrow('未关联')
    spaces.attach(b.host.lib, origin)
    const other = await b.host.api.previewDirectoryCollection(link.id, ['md'])
    expect(other.pending).toBe(2)
    expect((await b.host.api.collectDirectoryFiles(link.id, ['md'], other.token)).created).toBe(2)
    const [id] = (await a.host.api.query({ has: ['file'] })).ids
    const name = String(a.host.store.blocksOf(id).file.data.name), ref = String(a.host.store.blocksOf(id).file.data.path)
    expect(ref).toMatch(/^directories\/v1\//)
    await a.host.api.put(id, 'note', { text: '保留笔记' })
    renameSync(join(origin, name), join(origin, 'new.md')); await scan()
    const moved = join(home, 'relocated')
    renameSync(origin, moved); await spaces.relocate(a.host.lib, link.id, moved)
    expect(await a.host.api.fileStorageInfo(id)).toMatchObject({ path: realpathSync(join(moved, 'new.md')), storageKind: 'directory', canRevise: false })
    expect(await (await serveLibraryFile(a.root, new Request('lib://library/' + ref))).text()).toBe('notes')
    expect(await a.host.api.directorySpaceReferences(link.id)).toMatchObject({ active: 2, trashed: 0 })
    spaces.unlink(a.host.lib, link.id)
    expect((await a.host.api.fileStorageInfo(id)).associationState).toBe('detached')
    const detached = new DirectorySpaces(catalog).connections(a.host.lib, await a.host.api.referencedDirectorySpaces())
    expect(detached).toEqual([{ id: link.id, name: 'relocated', root: '', state: 'detached' }])
    expect(spaces.connections(b.host.lib, [link.id])[0].state).toBe('active')
    expect(a.host.store.blocksOf(id).note.data.text).toBe('保留笔记')
    expect(spaces.attach(a.host.lib, moved).id).toBe(link.id)
    writeFileSync(join(moved, 'new.md'), 'modified')
    expect((await serveLibraryFile(a.root, new Request('lib://library/' + ref))).status).toBe(403)
    await scan()
    expect((await a.host.api.fileStorageInfo(id)).state).toBe('unavailable')
    expect(readFileSync(join(moved, 'new.md'), 'utf8')).toBe('modified')
    await a.host.api.trash([id])
    expect(await a.host.api.directorySpaceReferences(link.id)).toMatchObject({ active: 1, trashed: 1 })
    expect((await preview()).pending).toBe(0)
    await a.host.api.collectDirectoryFiles(link.id, ['md'], (await preview()).token)
    expect(a.host.store.isTrashed(id)).toBe(true)
  } finally {
    await Promise.all([a.host.scheduler.idle(), b.host.scheduler.idle()])
    a.cleanup(); b.cleanup(); rmSync(home, { recursive: true, force: true }); vi.unstubAllEnvs()
  }
})

it('旧收录记录指向另一份主文件时，按实际文件身份创建和重放收录', async () => {
  const h = openHost(), home = tempDir(), source = join(home, '来源'), catalog = join(home, '登记簿')
  vi.stubEnv('HUOYE_DIRECTORY_CATALOG', catalog)
  try {
    mkdirSync(source)
    const managed = join(home, '独立文档.md')
    writeFileSync(managed, '独立副本')
    const [original] = await h.host.api.ingest([{ type: 'file', path: managed }])
    const originalPath = h.host.store.blocksOf(original).file.data.path
    writeFileSync(join(source, '稿件.md'), '原地文件')
    const spaces = new DirectorySpaces(catalog), space = spaces.attach(h.host.lib, source)
    await spaces.refreshTree(h.host.lib, space.id, new AbortController().signal)
    const query = { sourceKind: 'directory' as const, spaceId: space.id }
    const candidate = (await h.host.api.directoryFilePage(query)).items[0]
    h.host.lib.db.prepare('INSERT INTO space_adoptions VALUES (?,?,?)').run(space.id, candidate.id, original)
    expect((await h.host.api.directoryFilePage(query)).items[0].collectionState).toBe('uncollected')
    expect(await h.host.api.previewDirectoryCollection(space.id, ['md'])).toMatchObject({ pending: 1, existing: 0 })
    const request = { ...query, files: [{ id: candidate.id, stamp: candidate.stamp }], requestId: randomUUID() }
    await h.host.api.prepareDirectoryAdoption(request)
    const receipt = await h.host.api.commitDirectoryAdoption(request)
    const adopted = (receipt.result as { items: { id: string }[] }).items[0].id
    expect(adopted).not.toBe(original)
    expect((await h.host.api.directoryFilePage(query)).items[0].collected).toBe(adopted)
    expect(h.host.store.blocksOf(original).file.data.path).toBe(originalPath)
    expect(await h.host.api.prepareDirectoryAdoption(request)).toEqual({ ...receipt, replayed: true })
  } finally {
    await h.host.scheduler.idle(); h.cleanup(); rmSync(home, { recursive: true, force: true }); vi.unstubAllEnvs()
  }
})

it('两库独立预览和接纳原地改写，过期预览不能覆盖后来的版本', async () => {
  const a = openHost(), b = openHost(), home = tempDir()
  const catalog = join(home, 'catalog'), origin = join(home, 'files'), name = '稿件.md'
  vi.stubEnv('HUOYE_DIRECTORY_CATALOG', catalog)
  try {
    mkdirSync(origin)
    const source = join(origin, name)
    writeFileSync(source, '第一稿')
    const spaces = new DirectorySpaces(catalog), link = spaces.attach(a.host.lib, origin)
    spaces.attach(b.host.lib, origin)
    const scan = () => spaces.refreshTree(a.host.lib, link.id, new AbortController().signal)
    await scan()
    const collect = async (h: typeof a.host) => {
      const p = await h.api.previewDirectoryCollection(link.id, ['md'])
      expect((await h.api.collectDirectoryFiles(link.id, ['md'], p.token)).created).toBe(1)
      return (await h.api.query({ has: ['file'] })).ids[0]
    }
    const id = await collect(a.host), second = await collect(b.host)
    await a.host.api.put(id, 'note', { text: '我的笔记' })
    await a.host.api.patch(id, 'file', { name: '审稿用' })
    const original = a.host.store.blocksOf(id).file.data
    writeFileSync(source, '第二稿')
    await scan()
    const pending = (h: typeof a.host) => h.api.listDirectoryUpdates(link.id, 0)
    expect((await pending(a.host)).items).toEqual([{ id, path: name, revision: 2 }])
    const first = await a.host.api.previewFileUpdate(id)
    expect(first.previous).toMatchObject({ hash: original.hash, size: original.size, reference: original.path, unavailable: expect.any(String) })
    expect(first.previous.sample).toBeUndefined()
    expect(first.current).toMatchObject({ sample: '第二稿', ordinal: 2 })
    const request = (p: typeof first) => ({ id, contentVersion: p.current.id, expectedPath: p.expectedPath, revision: p.revision, requestId: randomUUID() })
    const stale = request(first)
    writeFileSync(source, '第三稿：修订')
    expect(() => a.host.api.acceptFileUpdate(stale)).toThrow('核对')
    await scan()
    expect(() => a.host.api.acceptFileUpdate(stale)).toThrow('SPACE_CHANGED')
    expect(a.host.store.blocksOf(id).file.data.path).toBe(original.path)
    const p = await a.host.api.previewFileUpdate(id), accept = request(p)
    await a.host.api.trash([id])
    expect((await pending(a.host)).total).toBe(0)
    expect(() => a.host.api.acceptFileUpdate(accept)).toThrow('ITEM_TRASHED')
    await a.host.api.restore([id])
    spaces.unlink(a.host.lib, link.id)
    expect(() => a.host.api.acceptFileUpdate(accept)).toThrow('未关联')
    spaces.attach(a.host.lib, origin)
    expect(await a.host.api.acceptFileUpdate(accept)).toMatchObject({ id, replayed: false })
    expect(await a.host.api.acceptFileUpdate(accept)).toMatchObject({ id, replayed: true })
    expect(() => a.host.api.acceptFileUpdate({ ...accept, revision: 1 })).toThrow('REQUEST_ID_CONFLICT')
    expect(a.host.store.blocksOf(id)).toMatchObject({ note: { data: { text: '我的笔记' } }, file: { data: { name: '审稿用', hash: p.current.hash } } })
    expect((await pending(a.host)).total).toBe(0)
    expect(await b.host.api.fileStorageInfo(second)).toMatchObject({ state: 'unavailable', hasUpdate: true, contentVersion: original.hash, currentOrdinal: 3 })
    expect((await pending(b.host)).items[0].id).toBe(second)
    expect((await serveLibraryFile(b.root, new Request('lib://library/' + original.path))).status).toBe(403)
    expect(readFileSync(a.host.lib.files.readable(p.current.reference), 'utf8')).toBe('第三稿：修订')
    writeFileSync(source, '第一稿')
    await scan()
    expect((await pending(b.host)).total).toBe(0)
    expect((await b.host.api.fileStorageInfo(second)).state).toBe('available')
    expect((await pending(a.host)).total).toBe(1)
  } finally {
    await Promise.all([a.host.scheduler.idle(), b.host.scheduler.idle()])
    a.cleanup(); b.cleanup(); rmSync(home, { recursive: true, force: true }); vi.unstubAllEnvs()
  }
})
