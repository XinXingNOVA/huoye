import { afterEach, beforeEach, expect, it } from 'vitest'
import { realpathSync, statSync, copyFileSync, linkSync, utimesSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { DirectorySpaces } from '../../src/storage/directory-spaces'
import { directoryPageSize } from '../../src/shared/directory-spaces'

let dir: string, source: string, spaces: DirectorySpaces
const a = { id: 'a', root: 'library-a' }, b = { id: 'b', root: 'library-b' }

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'directory-space-'))
  source = join(dir, 'source')
  mkdirSync(source)
  spaces = new DirectorySpaces(join(dir, 'catalogs'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

it('reuses one catalog across explicit associations and restores folder pages after reopening', async () => {
  for (let i = 0; i < directoryPageSize + 1; i++) writeFileSync(join(source, String(i)), '')
  const s = spaces.attach(a, source)
  const first = await spaces.page(a, s.id, null, 0, true)
  expect(first.total).toBe(directoryPageSize + 1)
  expect(first.items).toHaveLength(directoryPageSize)
  expect(spaces.list(b)).toEqual([])
  await expect(spaces.page(b, s.id, null, 0, false)).rejects.toThrow('未关联')
  expect(spaces.attach(b, source).id).toBe(s.id)
  spaces.unlink(a, s.id)
  const reopened = new DirectorySpaces(join(dir, 'catalogs'))
  expect((await reopened.page(b, s.id, null, 0, true)).items).toEqual(first.items)
  expect((await reopened.page(b, s.id, null, directoryPageSize, false)).items).toHaveLength(1)
  expect(reopened.list(a)).toEqual([])
})

it('refuses stale image bytes and keeps the last list if a different directory occupies the source path', async () => {
  const file = join(source, 'page.png')
  writeFileSync(file, 'first')
  const s = spaces.attach(a, source)
  const [old] = (await spaces.page(a, s.id, null, 0, true)).items
  writeFileSync(file, 'replacement')
  await expect(spaces.image(a, s.id, old.id, old.stamp)).rejects.toThrow('变化')
  const [fresh] = (await spaces.page(a, s.id, null, 0, true)).items
  expect(fresh.id).toBe(old.id)
  expect((await spaces.image(a, s.id, fresh.id, fresh.stamp)).toString()).toBe('replacement')
  renameSync(source, source + '-elsewhere')
  mkdirSync(source)
  const offline = await spaces.page(a, s.id, null, 0, true)
  expect(offline.issue).toMatch(/离线|替换/)
  expect(offline.items).toEqual([fresh])
})

it.each(['source-first', 'destination-first'])('reconnects a moved file with either scan order (%s), including across restarts', async order => {
  const left = join(source, 'left'), right = join(source, 'right')
  mkdirSync(left); mkdirSync(right)
  writeFileSync(join(left, 'a.txt'), 'words')
  const s = spaces.attach(a, source)
  const page = async (folder: string | null) => (await spaces.page(a, s.id, folder, 0, true)).items
  const [l, r] = await page(null)
  const [original] = await page(l.id)
  renameSync(join(left, 'a.txt'), join(right, 'b.txt'))
  if (order === 'source-first') {
    expect(await page(l.id)).toHaveLength(0)
    expect(spaces.missing(a, s.id, 0).items[0].id).toBe(original.id)
    spaces = new DirectorySpaces(join(dir, 'catalogs'))
  }
  expect((await page(r.id))[0].id).toBe(original.id)
  expect(await page(l.id)).toHaveLength(0)
  expect(spaces.missing(a, s.id, 0).total).toBe(0)
  renameSync(right, join(source, 'renamed-folder'))
  const scan = await spaces.refreshTree(a, s.id, new AbortController().signal)
  expect(scan).toMatchObject({ checked: 3, failed: 0 })
  const folder = (await page(null)).find(row => row.name === 'renamed-folder')!
  expect((await page(folder.id))[0].id).toBe(original.id)
})

it('keeps copies independent and only advances a verified content revision when bytes change', async () => {
  const file = join(source, 'page.md'), name = 'new.md', moved = join(source, name)
  writeFileSync(file, 'before')
  const s = spaces.attach(a, source)
  const entries = async () => (await spaces.page(a, s.id, null, 0, true)).items
  const [old] = await entries()
  const verify = (entry: typeof old) => spaces.verify(a, s.id, entry.id, entry.stamp)
  const v1 = await verify(old)
  renameSync(file, moved)
  copyFileSync(moved, join(source, 'copy.md'))
  let fresh = (await entries()).find(f => f.name === name)!
  expect(fresh.id).toBe(old.id)
  expect((await entries()).find(f => f.name === 'copy.md')!.id).not.toBe(old.id)
  utimesSync(moved, 1000, 1000)
  fresh = (await entries()).find(f => f.name === name)!
  expect(await verify(fresh)).toEqual(v1)
  writeFileSync(file, 'edited')
  renameSync(file, moved) // 编辑器的原子保存。
  await expect(verify(fresh)).rejects.toThrow('变化')
  fresh = (await entries()).find(f => f.name === name)!
  expect(fresh.id).toBe(old.id)
  expect(await verify(fresh)).toMatchObject({ revision: 2 })
  const unrelated = join(source, 'same.md')
  copyFileSync(moved, unrelated)
  rmSync(moved)
  expect((await entries()).find(f => f.name === 'same.md')!.id).not.toBe(old.id)
  expect(spaces.missing(a, s.id, 0).items.map(f => f.id)).toEqual([old.id])
})

it('treats hard links as separate records and retains ambiguous missing identities', async () => {
  const first = join(source, 'first'), second = join(source, 'second')
  writeFileSync(first, 'text')
  linkSync(first, second)
  const s = spaces.attach(a, source)
  const page = async () => (await spaces.page(a, s.id, null, 0, true)).items
  const [one, two] = await page()
  expect(one.id).not.toBe(two.id)
  renameSync(first, join(source, 'renamed'))
  const current = await page()
  expect(current.find(f => f.name === 'second')!.id).toBe(two.id)
  expect(current.find(f => f.name === 'renamed')!.id).not.toBe(one.id)
  expect(spaces.missing(a, s.id, 0).items[0].id).toBe(one.id)
})

it('retains the last complete directory when a whole-space check is stopped', async () => {
  const original = join(source, 'original')
  writeFileSync(original, 'observed')
  const s = spaces.attach(a, source)
  const before = await spaces.page(a, s.id, null, 0, true)
  rmSync(original)
  for (let i = 0; i < 32; i++) writeFileSync(join(source, String(i)), '')
  const controller = new AbortController()
  const pending = spaces.refreshTree(a, s.id, controller.signal)
  setImmediate(() => controller.abort())
  expect(await pending).toMatchObject({ checked: 0, failed: 0, cancelled: true })
  expect((await spaces.page(a, s.id, null, 0, false)).items).toEqual(before.items)
  expect(spaces.missing(a, s.id, 0).total).toBe(0)
  const next = await spaces.refreshTree(a, s.id, new AbortController().signal)
  expect(next).toMatchObject({ checked: 1, failed: 0, cancelled: false })
  expect(spaces.missing(a, s.id, 0).items[0].id).toBe(before.items[0].id)
})

it('upgrades an original catalog in place without changing its IDs or members', async () => {
  const s = { id: crypto.randomUUID() }, root = realpathSync(source), meta = statSync(root, { bigint: true })
  const location = join(dir, 'catalogs', s.id)
  mkdirSync(location, { recursive: true })
  const db = new Database(join(location, 'catalog.sqlite'))
  const legacyId = crypto.randomUUID()
  writeFileSync(join(source, 'before-upgrade.txt'), 'old')
  try {
    db.exec(`CREATE TABLE source(id TEXT PRIMARY KEY, root TEXT, name TEXT, device TEXT, inode TEXT);
      CREATE TABLE members(id TEXT, root TEXT, PRIMARY KEY(id,root));
      CREATE TABLE entries(id TEXT PRIMARY KEY,parent TEXT REFERENCES entries(id) ON DELETE CASCADE,
        name TEXT,path TEXT,folder INTEGER,size INTEGER,stamp TEXT,checkedAt INTEGER,UNIQUE(parent,name));
      INSERT INTO entries VALUES ('root',NULL,'','',1,0,'',NULL);`)
    db.prepare('INSERT INTO source VALUES (?,?,?,?,?)').run(s.id, root, 'source', String(meta.dev), String(meta.ino))
    db.prepare('INSERT INTO members VALUES (?,?)').run(a.id, a.root)
    db.prepare("INSERT INTO entries VALUES (?,'root','before-upgrade.txt','before-upgrade.txt',0,3,'old-stamp',NULL)").run(legacyId)
  } finally { db.close() }
  const first = await spaces.page(a, s.id, null, 0, true)
  expect(first.items[0].id).toBe(legacyId)
  renameSync(join(source, 'before-upgrade.txt'), join(source, 'after-upgrade.txt'))
  expect((await spaces.page(a, s.id, null, 0, true)).items[0].id).toBe(legacyId)
})

it.each([false, true])('follows a known file replacing another name, and then moving again (across directories: %s)', async across => {
  const folder = across ? join(source, 'dest') : source
  if (across) mkdirSync(folder)
  const left = join(source, 'a.jpg'), right = join(folder, 'b.jpg')
  writeFileSync(left, 'A'); writeFileSync(right, 'B')
  const s = spaces.attach(a, source)
  const page = async (folderId: string | null) => (await spaces.page(a, s.id, folderId, 0, true)).items
  const root = await page(null), dest = root.find(f => f.folder)?.id ?? null
  const first = root.find(f => f.name === 'a.jpg')!, replaced = (await page(dest)).find(f => f.name === 'b.jpg')!
  renameSync(left, right)
  expect((await page(dest)).find(f => f.name === 'b.jpg')!.id).toBe(first.id)
  renameSync(right, join(folder, 'c.jpg'))
  expect((await page(dest)).find(f => f.name === 'c.jpg')!.id).toBe(first.id)
  expect(spaces.missing(a, s.id, 0).items.map(f => f.id)).toEqual([replaced.id])
})

it('skips system files and dependency trees, retaining normal dotfiles on every scan', async () => {
  mkdirSync(join(source, '.git')); mkdirSync(join(source, 'node_modules'))
  writeFileSync(join(source, 'node_modules', 'dep.js'), '')
  for (const name of ['.DS_Store', 'Thumbs.db', 'desktop.ini', '.env', 'real.txt']) writeFileSync(join(source, name), 'data')
  const s = spaces.attach(a, source)
  expect(await spaces.refreshTree(a, s.id, new AbortController().signal)).toMatchObject({ checked: 1 })
  expect((await spaces.page(a, s.id, null, 0, true)).items.map(i => i.name)).toEqual(['.env', 'real.txt'])
  const db = new Database(join(dir, 'catalogs', s.id, 'catalog.sqlite'))
  try { expect(db.pragma('journal_mode', { simple: true })).toBe('wal') } finally { db.close() }
})

it('relocates a shared root by identity or verified bytes; a wrong replacement cannot change the catalog', async () => {
  const s = spaces.attach(a, source)
  spaces.attach(b, source)
  writeFileSync(join(source, 'small.txt'), 'verified')
  writeFileSync(join(source, 'unknown'), 'unknown')
  const entries = (await spaces.page(a, s.id, null, 0, true)).items
  const [known, unknown] = entries
  await spaces.verify(a, s.id, known.id, known.stamp)
  const moved = join(dir, 'moved')
  renameSync(source, moved)
  expect(await spaces.relocate(a, s.id, moved)).toMatchObject({ sameRoot: true })
  expect(spaces.list(b)[0].root).toBe(realpathSync(moved))
  const dest = join(dir, 'restore')
  mkdirSync(dest)
  writeFileSync(join(dest, 'small.txt'), 'mismatch')
  await expect(spaces.relocate(a, s.id, dest)).rejects.toThrow('仍在原位置')
  renameSync(moved, moved + '-offline')
  await expect(spaces.relocate(a, s.id, dest)).rejects.toThrow('已登记内容不符')
  expect(spaces.list(a)[0].root).toMatch(/moved$/)
  writeFileSync(join(dest, 'small.txt'), 'verified')
  writeFileSync(join(dest, 'unknown'), 'unknown')
  expect(await spaces.relocate(a, s.id, dest)).toMatchObject({ sameRoot: false, matched: 1 })
  const page = await spaces.page(b, s.id, null, 0, true)
  expect(page.items[0].id).toBe(known.id)
  expect(page.items[1].id).not.toBe(unknown.id)
  expect(spaces.missing(b, s.id, 0).items[0].id).toBe(unknown.id)
})

it('allows a second associated library to verify and refresh during a catalog read snapshot', async () => {
  writeFileSync(join(source, 'one'), 'data')
  const s = spaces.attach(a, source)
  spaces.attach(b, source)
  const [file] = (await spaces.page(a, s.id, null, 0, true)).items
  const reader = new Database(join(dir, 'catalogs', s.id, 'catalog.sqlite'), { readonly: true })
  const other = new DirectorySpaces(join(dir, 'catalogs'))
  try {
    reader.exec('BEGIN')
    const count = () => reader.prepare('SELECT count(*) FROM verified_files').pluck().get()
    expect(count()).toBe(0)
    await Promise.all([spaces.verify(a, s.id, file.id, file.stamp), other.verify(b, s.id, file.id, file.stamp)])
    expect(count()).toBe(0)
    reader.exec('COMMIT')
    expect(count()).toBe(1)
    expect(await other.page(b, s.id, null, 0, true)).toMatchObject({ total: 1 })
  } finally { reader.close() }
})

it('原仓库改名自动接续，副本和旧位置离线时需要明确选择来源', async () => {
  const original = { id: 'stable-library', root: join(dir, 'library') }
  mkdirSync(original.root)
  const linked = spaces.attach(original, source)
  const moved = { ...original, root: join(dir, 'renamed-library') }
  renameSync(original.root, moved.root)
  spaces.resumeMember(moved)
  expect(spaces.list(moved)).toEqual([linked])
  expect(spaces.members(linked.id)).toEqual([moved])

  mkdirSync(original.root) // 模拟带同一 libraryId 的副本
  spaces.resumeMember(original)
  expect(spaces.connections(original, [linked.id])[0].state).toBe('confirm')
  await expect(spaces.page(original, linked.id, null, 0, false)).rejects.toThrow('未关联')
  renameSync(moved.root, moved.root + '.offline')
  spaces.resumeMember(original)
  expect(spaces.list(original)).toEqual([])
  expect(() => spaces.attach(original, dir, linked.id)).toThrow('身份不符')
  expect(spaces.attach(original, source, linked.id)).toEqual(linked)
  renameSync(moved.root + '.offline', moved.root)
  expect(spaces.list(moved)).toEqual([linked])
  spaces.unlink(original, linked.id)
  expect(spaces.list(original)).toEqual([])
})

it('核对失败可重开后单独重试，重试只进入有失败项的目录', async () => {
  const nested = join(source, '子目录'), file = join(nested, '文稿.md')
  mkdirSync(nested); writeFileSync(file, '第一稿')
  const space = spaces.attach(a, source)
  const scan = (retry = false) => spaces.refreshTree(a, space.id, new AbortController().signal, retry)
  await scan()
  const [entry] = spaces.candidates(a, space.id, new Set(['md']))
  await spaces.verify(a, space.id, entry.id, entry.stamp)
  writeFileSync(file, '外部修订稿')
  // 各平台一致的单次读取失败；实机验收另用原件读取权限验证。
  const { verify } = spaces
  spaces.verify = async () => { throw new Error('读取暂时失败') }
  try {
    const r = await scan()
    expect(r).toMatchObject({ checked: 2, failed: 0, fileIssues: { total: 1, examples: [{ path: join('子目录','文稿.md'), reason: '读取暂时失败' }] } })
  } finally { spaces.verify = verify }
  spaces = new DirectorySpaces(join(dir, 'catalogs'))
  expect((await spaces.page(a, space.id, null, 0, false)).fileIssues.total).toBe(1)
  expect(await scan(true)).toMatchObject({ checked: 1, failed: 0, fileIssues: { total: 0 } })
  expect(spaces.revisedFiles(a, space.id)[0].revision).toBe(2)
  expect((await scan(true)).checked).toBe(0)
})
