import Database from 'better-sqlite3'
import { createHash, randomUUID } from 'node:crypto'
import { constants, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, readdirSync, realpathSync, statSync, type BigIntStats } from 'node:fs'
import { lstat, open, opendir, realpath, type FileHandle } from 'node:fs/promises'
import { basename, extname, join, relative, sep, isAbsolute } from 'node:path'
import { z } from 'zod'
import { directoryImage, directoryPageSize, type DirectoryConnection, type DirectoryScanResult, type DirectoryPage, type DirectorySpace, type DirectoryEntry, type DirectoryVerification, type VerificationIssues } from '../shared/directory-spaces'
import { directoryStamp as stampOf } from './directory-reference'
import { relocateDirectory } from './directory-relocation'
import { grantDirectoryAccess, hasDirectoryAccess, resumeDirectoryMember, type DirectoryMember as Member } from './directory-members'
import { startMissingCheck, finishMissingCheck, directoryProof } from './missing-check'
import { ignoredDirectoryEntry } from './directory-policy'
import { absentLocations, moveKey, otherLocations, prepareDirectoryCatalog, reconcileDirectory, type CatalogEntry, type ObservedChild } from './directory-identity'

type Source = DirectorySpace & { device: string; inode: string }
const ROOT = 'root'
const maxPreview = 32 * 1024 * 1024
const identity = (s: BigIntStats) => [String(s.dev), String(s.ino)]
const message = (e: unknown) => e instanceof Error ? e.message : String(e)
const inside = (root: string, path: string) => {
  const r = relative(root, path)
  return r !== '..' && !r.startsWith('..' + sep) && !isAbsolute(r)
}
function fileIssues(db: Database.Database): VerificationIssues {
  const total = Number(db.prepare('SELECT count(*) FROM verification_issues').pluck().get())
  const examples = db.prepare(`SELECT e.path,i.reason FROM verification_issues i JOIN entries e ON e.id=i.id
    ORDER BY e.path LIMIT 8`).all() as VerificationIssues['examples']
  return { total, examples }
}
export function openDirectoryCatalog(path: string, create = false) {
  const db = new Database(path, { fileMustExist: !create, timeout: 3000 })
  try {
    db.pragma('foreign_keys = ON')
    db.pragma('journal_mode = WAL')
    return db
  } catch (error) { db.close(); throw error }
}
const schema = `
  CREATE TABLE source(id TEXT PRIMARY KEY, root TEXT NOT NULL, name TEXT NOT NULL, device TEXT NOT NULL, inode TEXT NOT NULL);
  CREATE TABLE members(id TEXT NOT NULL, root TEXT NOT NULL, PRIMARY KEY(id,root));
  CREATE TABLE entries(id TEXT PRIMARY KEY, parent TEXT REFERENCES entries(id) ON DELETE CASCADE,
    name TEXT NOT NULL, path TEXT NOT NULL, folder INTEGER NOT NULL, size INTEGER NOT NULL, stamp TEXT NOT NULL,
    checkedAt INTEGER, UNIQUE(parent,name));
  CREATE INDEX listing ON entries(parent,folder DESC,name COLLATE NOCASE,name);
  CREATE INDEX unvisited ON entries(parent) WHERE folder=1 AND checkedAt IS NULL;
`

/** 本机的观察清单。仅原生选择器产生来源根路径，后续请求只接受空间和条目 ID。 */
export class DirectorySpaces {
  private indexing = new Set<string>()
  private lastScan = new Map<string, Promise<string>>()
  private scans = new Map<string, Promise<string>>()
  constructor(private home: string, private contentChanged?: (spaceId: string, fileId: string) => void) {}

  private use<T>(id: string, fn: (db: Database.Database) => T): T {
    z.uuid().parse(id)
    const db = openDirectoryCatalog(join(this.home, id, 'catalog.sqlite'))
    try { prepareDirectoryCatalog(db); return fn(db) } finally { db.close() }
  }

  private ids(): string[] {
    if (!existsSync(this.home)) return []
    return readdirSync(this.home, { withFileTypes: true }).filter(d => d.isDirectory() && z.uuid().safeParse(d.name).success).map(d => d.name)
  }

  private source(db: Database.Database): Source { return db.prepare('SELECT * FROM source').get() as Source }

  private assertMember(db: Database.Database, member: Member) {
    if (!hasDirectoryAccess(db, member)) throw new Error('当前仓库未关联此原地目录')
  }

  resumeMember(member: Member) {
    let catalogs: string[]
    try { catalogs = this.ids() } catch (e) { console.warn('[directory-space] 无法读取本机登记目录', message(e)); return }
    for (const id of catalogs) {
      try { this.use(id, db => resumeDirectoryMember(db, member)) }
      catch (error) { console.warn('[directory-space] 仓库位置未接续', id, message(error)) }
    }
  }

  identify(member: Member, paths: string[]) {
    const result: { spaceId: string; fileId: string }[] = []
    for (const space of this.list(member)) {
      const local = paths.filter(p => p !== space.root && inside(space.root, p))
      if (!local.length) continue
      this.use(space.id, db => {
        this.assertMember(db, member)
        const child = db.prepare('SELECT id,folder FROM entries WHERE parent=? AND name=?')
        for (const path of local) {
          let entry: { id: string; folder: number } | undefined = { id: ROOT, folder: 1 }
          for (const part of relative(space.root, path).split(sep)) {
            entry = child.get(entry.id, part) as typeof entry
            if (!entry) break
          }
          if (entry && !entry.folder) result.push({ spaceId: space.id, fileId: entry.id })
        }
      })
    }
    return result
  }

  members(id: string) {
    return this.use(id, db => db.prepare('SELECT id,root FROM members').all() as Member[])
  }

  list(member: Member): DirectorySpace[] {
    return this.ids().flatMap(id => this.use(id, db => hasDirectoryAccess(db, member) ? db.prepare('SELECT id,name,root FROM source').all() as DirectorySpace[] : []))
  }

  connections(member: Member, referenced: string[]): DirectoryConnection[] {
    const remaining = new Set(referenced), result: DirectoryConnection[] = []
    for (const id of this.ids()) {
      this.use(id, db => {
        const active = hasDirectoryAccess(db, member)
        const known = !!db.prepare('SELECT 1 FROM members WHERE id=?').get(member.id)
        if (!active && !known && !remaining.has(id)) return
        remaining.delete(id)
        const { name, root } = this.source(db)
        result.push({ id, name, root: active ? root : '', state: active ? 'active' : known ? 'confirm' : 'detached' })
      })
    }
    for (const id of remaining) result.push({ id, name: '原地空间 · ' + id.slice(0,8), root: '', state: 'missing' })
    return result
  }

  attach(member: Member, path: string, expectedId?: string): DirectorySpace {
    const root = realpathSync(path), st = statSync(root, { bigint: true })
    if (!st.isDirectory()) throw new Error('请选择目录')
    if (existsSync(this.home) && inside(realpathSync(this.home), root)) throw new Error('不能关联活页的目录登记簿')
    const [device, inode] = identity(st)
    for (const id of expectedId ? [expectedId] : this.ids()) {
      const found = this.use(id, db => {
        const s = this.source(db)
        if (s.root !== root || s.device !== device || s.inode !== inode) return
        grantDirectoryAccess(db, member)
        return { id, root, name: s.name }
      })
      if (found) return found
    }
    if (expectedId) throw new Error('所选目录与原登记的来源身份不符，请选择原目录')
    const id = randomUUID(), name = basename(root) || root
    mkdirSync(this.home, { recursive: true })
    const stage = mkdtempSync(join(this.home, '.new-'))
    try {
      const db = openDirectoryCatalog(join(stage, 'catalog.sqlite'), true)
      try {
        db.transaction(() => {
          db.exec(schema)
          db.prepare('INSERT INTO source VALUES (?,?,?,?,?)').run(id, root, name, device, inode)
          prepareDirectoryCatalog(db)
          grantDirectoryAccess(db, member)
          db.prepare("INSERT INTO entries(id,parent,name,path,folder,size,stamp) VALUES (?,NULL,'','',1,0,'')").run(ROOT)
        })()
      } finally { db.close() }
      renameSync(stage, join(this.home, id))
    } finally { rmSync(stage, { recursive: true, force: true }) }
    return { id, root, name }
  }

  async relocate(member: Member, id: string, target: string) {
    const { source } = this.lookup(member, id, ROOT, true)
    const root = realpathSync(target)
    if (inside(realpathSync(this.home), root)) throw new Error('不能关联活页的目录登记簿')
    const db = openDirectoryCatalog(join(this.home, id, 'catalog.sqlite'))
    try {
      return await relocateDirectory(db, source, root, () => {
        this.assertMember(db, member)
        if (this.source(db).root !== source.root) throw new Error('来源目录已重新定位，请刷新')
        for (const other of this.ids()) {
          if (other !== id && this.use(other, db => this.source(db).root === root)) throw new Error('所选目录已经有独立空间登记')
        }
      })
    } finally { db.close() }
  }

  unlink(member: Member, id: string) {
    this.use(id, db => db.transaction(() => {
      this.assertMember(db, member)
      db.prepare('DELETE FROM members WHERE id=? AND root=?').run(member.id, member.root)
    }).immediate())
  }

  private lookup(member: Member, id: string, key: string, folder: boolean) {
    return this.use(id, db => {
      this.assertMember(db, member)
      const entry = db.prepare('SELECT * FROM entries WHERE id=? AND folder=?').get(key, Number(folder)) as CatalogEntry | undefined
      if (!entry) throw new Error('[DIRECTORY_ENTRY_MISSING] 目录项已变化，请返回上一级刷新')
      return { source: this.source(db), entry }
    })
  }

  private async location(s: Source, entry: CatalogEntry) {
    const path = join(s.root, entry.path)
    const rootStat = await lstat(s.root, { bigint: true }).catch(() => { throw new Error('来源目录离线或不可访问') })
    const [device, inode] = identity(rootStat)
    if (!rootStat.isDirectory() || device !== s.device || inode !== s.inode) throw new Error('来源目录已离线或位置已被替换')
    if (!inside(s.root, path) || inside(realpathSync(this.home), path) || await realpath(path) !== path) throw new Error('目录位置已变化或经过符号链接，请重新核对')
    return path
  }

  private async scan(member: Member, source: Source, entry: CatalogEntry, signal?: AbortSignal, onlyFile?: string) {
    signal?.throwIfAborted()
    const path = await this.location(source, entry)
    const before = await lstat(path, { bigint: true })
    if (!before.isDirectory() || (entry.parent !== null && identity(before).join(':') !== entry.stamp)) throw new Error('此目录已被替换，请刷新上一级目录')
    const found: ObservedChild[] = []
    const catalogRoot = realpathSync(this.home)
    const directory = await opendir(path)
    for await (const child of directory) {
      signal?.throwIfAborted()
      if (ignoredDirectoryEntry(child.name, child.isDirectory()) || child.isSymbolicLink() || (!child.isFile() && !child.isDirectory())) continue
      const file = join(path, child.name)
      if (inside(catalogRoot, file)) continue
      const st = await lstat(file, { bigint: true })
      if (st.isFile() || st.isDirectory()) found.push({ name: child.name, folder: Number(st.isDirectory()), size: st.isFile() ? Number(st.size) : 0, stamp: st.isDirectory() ? identity(st).join(':') : stampOf(st), diskKey: moveKey(st) })
    }
    const other = this.use(source.id, db => otherLocations(db, entry, found))
    const absent = await absentLocations(source.root, other, signal)
    await this.location(source, entry)
    const after = await lstat(path, { bigint: true })
    signal?.throwIfAborted()
    if (stampOf(before) !== stampOf(after)) throw new Error('读取期间目录有变化，请刷新')
    this.use(source.id, db => db.transaction(() => {
      if (!db.prepare('SELECT 1 FROM entries WHERE id=?').get(entry.id)) throw new Error('目录已变化，请刷新')
      this.assertMember(db, member)
      if (this.source(db).root !== source.root) throw new Error('来源目录已重新定位，请刷新')
      reconcileDirectory(db, entry, found, absent)
    }).immediate())
    // 已核对文件在移动／外部保存后重验字节，仍相同的已收录引用可直接打开。
    const dirty = this.use(source.id, db => db.prepare(`SELECT e.id,e.stamp FROM entries e JOIN verified_files v ON v.id=e.id
      WHERE e.parent=? AND e.stamp IS NOT v.stamp AND (? IS NULL OR e.id=?)`).all(entry.id, onlyFile ?? null, onlyFile ?? null) as {id: string; stamp: string}[])
    for (const item of dirty) {
      signal?.throwIfAborted()
      try { await this.verify(member, source.id, item.id, item.stamp, signal) }
      catch (error) {
        signal?.throwIfAborted()
        if (onlyFile) throw error
        this.use(source.id, db => db.transaction(() => {
          this.assertMember(db, member)
          db.prepare(`INSERT OR REPLACE INTO verification_issues(id,stamp,reason)
            SELECT e.id,e.stamp,? FROM entries e JOIN verified_files v ON v.id=e.id
            WHERE e.id=? AND e.stamp=? AND e.stamp IS NOT v.stamp`).run(message(error), item.id, item.stamp)
        }).immediate())
      }
    }
    return stampOf(after)
  }

  private scanOnce(member: Member, source: Source, entry: CatalogEntry, options: { fresh?: boolean; signal?: AbortSignal; onlyFile?: string } = {}) {
    const { fresh, signal } = options
    const key = source.id + '/' + entry.id
    const shared = this.scans.get(key)
    if (!fresh && !signal && shared) return shared
    // 显式刷新必须看到点击之后的状态，不能复用已经开始的枚举。后台发现可共享最新扫描。
    const previous = this.lastScan.get(source.id) ?? Promise.resolve()
    const job = previous.catch(() => {}).then(() => this.scan(member, source, entry, signal, options.onlyFile)).finally(() => {
      if (this.scans.get(key) === job) this.scans.delete(key)
      if (this.lastScan.get(source.id) === job) this.lastScan.delete(source.id)
    })
    this.lastScan.set(source.id, job)
    if (!signal) this.scans.set(key, job)
    return job
  }

  /** 首层先返回。已列出的子目录在后台补齐，前台打开同一层复用正在进行的扫描。 */
  private async indexChildren(member: Member, source: Source) {
    if (this.indexing.has(source.id)) return
    this.indexing.add(source.id)
    try {
      const pending = (parent?: string) => this.use(source.id, db =>
        db.prepare('SELECT id FROM entries WHERE folder=1 AND checkedAt IS NULL' + (parent ? ' AND parent=?' : '')).pluck().all(...(parent ? [parent] : [])) as string[])
      const queue = pending()
      while (queue.length) {
        await new Promise<void>(resolve => setImmediate(resolve))
        const key = queue.pop()!
        const current = this.use(source.id, db => {
          this.assertMember(db, member)
          return db.prepare('SELECT * FROM entries WHERE id=? AND checkedAt IS NULL').get(key) as CatalogEntry | undefined
        })
        if (!current) continue
        try { await this.scanOnce(member, source, current) } catch { continue } // 用户打开此层时重试并显示具体错误。
        for (const child of pending(key)) queue.push(child)
      }
    } finally { this.indexing.delete(source.id) }
  }

  async page(member: Member, id: string, folderId: string | null, offset: number, refresh: boolean): Promise<DirectoryPage> {
    const key = folderId ?? ROOT
    const { source, entry } = this.lookup(member, id, key, true)
    let issue: string | undefined
    if (refresh || entry.checkedAt === null) {
      try {
        await this.scanOnce(member, source, entry, { fresh: refresh })
        void this.indexChildren(member, source).catch(() => { /* 解除关联后停止后台工作。 */ })
      } catch (e) { issue = message(e) }
    } else {
      try { await this.location(source, entry) } catch (e) { issue = message(e) }
    }
    return this.use(id, db => {
      this.assertMember(db, member)
      const checked = db.prepare('SELECT checkedAt FROM entries WHERE id=?').get(key) as { checkedAt: number | null } | undefined
      if (!checked) throw new Error('[DIRECTORY_ENTRY_MISSING] 目录项已变化，请返回上一级刷新')
      const total = Number(db.prepare('SELECT count(*) FROM entries WHERE parent=?').pluck().get(key))
      const start = Math.min(offset, Math.max(0, Math.floor((total - 1) / directoryPageSize) * directoryPageSize))
      const items = db.prepare('SELECT id,name,folder,size,stamp FROM entries WHERE parent=? ORDER BY folder DESC,name COLLATE NOCASE,name LIMIT ? OFFSET ?').all(key, directoryPageSize, start) as (Omit<DirectoryEntry,'folder'> & { folder: number })[]
      const missingCount = Number(db.prepare('SELECT count(*) FROM missing_files').pluck().get())
      return { missingCount, fileIssues: fileIssues(db), items: items.map(i => ({ ...i, folder: !!i.folder })), offset: start, total, ...checked, issue }
    })
  }

  async refreshTree(member: Member, id: string, signal: AbortSignal, retryOnly = false, progress?: (checked: number, failed: number) => void): Promise<DirectoryScanResult> {
    const { source } = this.lookup(member, id, ROOT, true)
    const run = retryOnly ? undefined : this.use(id, db => startMissingCheck(db))
    const observed = new Map<string, string>()
    const queue = retryOnly ? this.use(id, db => db.prepare('SELECT DISTINCT e.parent FROM entries e JOIN verification_issues i ON i.id=e.id').pluck().all() as string[]) : [ROOT]
    let checked = 0, failed = 0, firstIssue: string | undefined
    while (queue.length && !signal.aborted) {
      const key = queue.pop()!
      const entry = this.use(id, db => {
        this.assertMember(db, member)
        return db.prepare('SELECT * FROM entries WHERE id=? AND folder=1').get(key) as CatalogEntry | undefined
      })
      if (!entry) continue // 前台刷新可能已经观察到该目录被移走。
      try { observed.set(entry.path, await this.scanOnce(member, source, entry, { signal })) }
      catch (error) {
        if (signal.aborted) break
        firstIssue ??= (entry.path || source.name) + ' · ' + message(error)
        failed++; progress?.(checked, failed)
        continue
      }
      checked++; progress?.(checked, failed)
      if (retryOnly) continue
      const children = this.use(id, db => db.prepare('SELECT id FROM entries WHERE parent=? AND folder=1').pluck().all(key) as string[])
      for (const child of children) queue.push(child)
    }
    const issues = this.use(id, db => {
      this.assertMember(db, member)
      if (run && !failed && !signal.aborted) finishMissingCheck(db, run, directoryProof(source.root, observed))
      return fileIssues(db)
    })
    return { checked, failed, firstIssue, cancelled: signal.aborted, fileIssues: issues }
  }

  verifiedSelection<T>(member: Member, id: string, choices: { id: string; stamp: string }[], use: (files: { id: string; name: string; size: number; hash: string }[]) => T) {
    return this.use(id, db => db.transaction(() => {
      this.assertMember(db, member)
      const file = db.prepare(`SELECT e.id,e.name,e.size,v.hash FROM entries e JOIN verified_files v ON v.id=e.id
        WHERE e.id=? AND e.folder=0 AND e.stamp=? AND v.stamp=e.stamp`)
      return use(choices.map(choice => {
        const row = file.get(choice.id, choice.stamp) as { id: string; name: string; size: number; hash: string } | undefined
        if (!row) throw new Error('[SPACE_CHANGED] 选定文件已变化，请刷新后重新选择')
        return row
      }))
    }).immediate())
  }

  candidates(member: Member, id: string, suffixes: Set<string>) {
    return this.use(id, db => {
      this.assertMember(db, member)
      const result: Pick<CatalogEntry, 'id' | 'name' | 'path' | 'stamp' | 'size'>[] = []
      for (const row of db.prepare('SELECT id,name,path,stamp,size FROM entries WHERE folder=0 ORDER BY id').iterate() as Iterable<CatalogEntry>) {
        if (!suffixes.size || suffixes.has(extname(row.name).slice(1).toLowerCase())) result.push(row)
      }
      return result
    })
  }

  revisedFiles(member: Member, id: string) {
    return this.use(id, db => {
      this.assertMember(db, member)
      return db.prepare(`SELECT e.id,e.path,v.hash,v.revision FROM verified_files v JOIN entries e ON e.id=v.id
        WHERE v.revision>1 AND e.stamp=v.stamp AND e.folder=0 ORDER BY e.path,e.id`).all() as
        { id: string; path: string; hash: string; revision: number }[]
    })
  }

  missing(member: Member, id: string, offset: number) {
    return this.use(id, db => {
      this.assertMember(db, member)
      const total = Number(db.prepare('SELECT count(*) FROM missing_files').pluck().get())
      const start = Math.min(offset, Math.max(0, Math.ceil(total / directoryPageSize) - 1) * directoryPageSize)
      const items = db.prepare('SELECT id,path,size FROM missing_files ORDER BY missingAt DESC,id LIMIT ? OFFSET ?').all(directoryPageSize, start) as { id: string; path: string; size: number }[]
      return { items, offset: start, total }
    })
  }

  private async readChecked<T>(member: Member, source: Source, entry: CatalogEntry, stamp: string, read: (file: FileHandle) => Promise<{ value: T; hash: string }>) {
    if (entry.stamp !== stamp) throw new Error('文件已变化，请刷新目录')
    const path = await this.location(source, entry)
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    try {
      const verify = (st: BigIntStats) => {
        if (!st.isFile() || stampOf(st) !== stamp) throw new Error('文件已变化，请刷新目录')
      }
      verify(await file.stat({ bigint: true }))
      const { value, hash } = await read(file)
      await this.location(source, entry)
      verify(await lstat(path, { bigint: true }))
      let changed = false
      const revision = this.use(source.id, db => db.transaction(() => {
        this.assertMember(db, member)
        if (db.prepare('SELECT stamp FROM entries WHERE id=?').pluck().get(entry.id) !== stamp) throw new Error('文件已变化，请刷新目录')
        if (this.contentChanged) {
          const previous = db.prepare('SELECT hash FROM verified_files WHERE id=?').pluck().get(entry.id)
          changed = previous !== undefined && previous !== hash
        }
        db.prepare('DELETE FROM verification_issues WHERE id=?').run(entry.id)
        return db.prepare(`INSERT INTO verified_files(id,hash,revision,stamp) VALUES (?,?,1,?)
          ON CONFLICT(id) DO UPDATE SET hash=excluded.hash,stamp=excluded.stamp,
          revision=verified_files.revision+(verified_files.hash<>excluded.hash) RETURNING revision`).pluck().get(entry.id, hash, stamp) as number
      }).immediate())
      if (changed) this.contentChanged?.(source.id, entry.id)
      return { value, version: { hash, revision } }
    } finally { await file.close() }
  }

  async recheck(member: Member, id: string, fileId: string) {
    const { source, entry } = this.lookup(member, id, fileId, false)
    const parent = this.lookup(member, id, entry.parent!, true).entry
    // 先按同目录的移动和原子替换规则核实身份，只核对所选文件的内容。
    await this.scanOnce(member, source, parent, { fresh: true, onlyFile: fileId })
    this.lookup(member, id, fileId, false)
  }

  async verify(member: Member, id: string, fileId: string, stamp: string, signal?: AbortSignal): Promise<DirectoryVerification> {
    const { source, entry } = this.lookup(member, id, fileId, false)
    const result = await this.readChecked(member, source, entry, stamp, async file => {
      const digest = createHash('sha256')
      const chunk = Buffer.allocUnsafe(Math.min(entry.size, 256 * 1024))
      for (let position = 0; position < entry.size;) {
        signal?.throwIfAborted()
        const { bytesRead } = await file.read(chunk, 0, Math.min(chunk.length, entry.size - position), position)
        if (!bytesRead) throw new Error('文件已变化，请刷新目录')
        digest.update(chunk.subarray(0, bytesRead))
        position += bytesRead
      }
      return { value: undefined, hash: digest.digest('hex') }
    })
    return result.version
  }

  async image(member: Member, id: string, fileId: string, stamp: string) {
    const { source, entry } = this.lookup(member, id, fileId, false)
    if (!directoryImage(entry.name)) throw new Error('暂不支持这种图片预览')
    if (entry.size > maxPreview) throw new Error('简易预览支持 32 MiB 以内的图片')
    const result = await this.readChecked(member, source, entry, stamp, async file => {
      const bytes = Buffer.alloc(entry.size)
      for (let offset = 0; offset < bytes.length;) {
        const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset)
        if (!bytesRead) throw new Error('文件已变化，请刷新目录')
        offset += bytesRead
      }
      return { value: bytes, hash: createHash('sha256').update(bytes).digest('hex') }
    })
    return result.value
  }
}
