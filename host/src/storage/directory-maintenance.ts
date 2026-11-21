import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readdirSync, renameSync, rmdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { prepareDirectoryCatalog } from './directory-identity'
import { hasDirectoryAccess, type DirectoryMember } from './directory-members'
import { openDirectoryCatalog } from './directory-spaces'
import type { DirectoryCatalogInfo, MissingCleanupPreview } from '../shared/directory-spaces'

const files = ['catalog.sqlite-wal', 'catalog.sqlite-shm', 'catalog.sqlite-journal', 'catalog.sqlite']
const retiring = '.forget-'
const message = (e: unknown) => e instanceof Error ? e.message : String(e)
const marked = (db: Database.Database) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='directory_retiring'").get()

function contents(dir: string) {
  if (!lstatSync(dir).isDirectory()) throw new Error('登记路径不是本机目录')
  const names = readdirSync(dir)
  let bytes = 0
  for (const name of names) {
    const st = lstatSync(join(dir, name), { throwIfNoEntry: false })
    if (!st) continue
    if (!files.includes(name) || !st.isFile() || st.nlink !== 1) throw new Error('登记目录含有非登记簿文件，请先检查本机目录')
    bytes += st.size
  }
  return { bytes, names }
}

function available(db: Database.Database, member: DirectoryMember) {
  try {
    if (!hasDirectoryAccess(db, member)) return false
    const library = new Database(join(member.root, 'library.db'), { readonly: true, fileMustExist: true, timeout: 300 })
    try { return library.prepare("SELECT value FROM meta WHERE key='library_id'").pluck().get() === member.id }
    finally { library.close() }
  } catch { return false }
}

function checkStaged(dir: string, id: string) {
  const files = contents(dir)
  if (!files.names.length) return
  const db = new Database(join(dir, 'catalog.sqlite'), { readonly: true, fileMustExist: true })
  try {
    if (!marked(db) || db.prepare('SELECT id FROM source').pluck().get() !== id) throw new Error('缺少已确认的登记簿清理记录')
  } finally { db.close() }
}

function missingPlan(db: Database.Database, cutoff: number): MissingCleanupPreview {
  const digest = createHash('sha256'), examples: string[] = []
  let count = 0
  const rows = db.prepare(`SELECT id,path,diskKey,missingAt FROM missing_files m WHERE missingAt<=?
    AND NOT EXISTS (SELECT 1 FROM entries e WHERE e.id=m.id) ORDER BY id`).iterate(cutoff) as Iterable<{id: string; path: string}>
  for (const row of rows) {
    digest.update(JSON.stringify(row))
    if (examples.length < 5) examples.push(row.path)
    count++
  }
  return { count, cutoff, token: digest.digest('hex'), examples }
}

/** 全局维护只操作本机 UUID 登记目录。来源根和仓库路径仅用于检查在线状态。 */
export class DirectoryMaintenance {
  constructor(private home: string) {}

  private use<T>(id: string, run: (db: Database.Database) => T) {
    const dir = join(this.home, z.uuid().parse(id))
    contents(dir)
    const db = openDirectoryCatalog(join(dir, 'catalog.sqlite'))
    try {
      if (db.prepare('SELECT id FROM source').pluck().get() !== id) throw new Error('登记簿身份与目录不匹配')
      prepareDirectoryCatalog(db)
      return run(db)
    } finally { db.close() }
  }

  list(): DirectoryCatalogInfo[] {
    if (!existsSync(this.home)) return []
    const result: DirectoryCatalogInfo[] = []
    for (const name of readdirSync(this.home)) {
      const staged = name.startsWith(retiring), id = staged ? name.slice(retiring.length) : name
      if (!z.uuid().safeParse(id).success) continue
      const base: DirectoryCatalogInfo = { id, name: id, status: 'unreadable', bytes: 0, entries: 0, missing: 0, members: [] }
      try {
        base.bytes = contents(join(this.home, name)).bytes
        if (staged) { checkStaged(join(this.home, name), id); result.push({ ...base, status: 'retiring' }); continue }
        result.push(this.use(id, db => {
          const source = db.prepare('SELECT root,name,device,inode FROM source').get() as { root: string; name: string; device: string; inode: string }
          let status: DirectoryCatalogInfo['status'] = 'offline'
          try {
            const st = lstatSync(source.root, { bigint: true, throwIfNoEntry: false })
            if (st) status = st.isDirectory() && String(st.dev) === source.device && String(st.ino) === source.inode ? 'online' : 'replaced'
          } catch { /* 掉盘和不可访问都不推断为已删除。 */ }
          const members = db.prepare('SELECT id,root FROM members ORDER BY root').all() as DirectoryMember[]
          return { ...base, name: source.name, root: source.root, status: marked(db) ? 'retiring' : status,
            entries: Number(db.prepare('SELECT count(*) FROM entries WHERE folder=0').pluck().get()),
            missing: Number(db.prepare('SELECT count(*) FROM missing_files').pluck().get()),
            members: members.map(member => ({ ...member, available: available(db, member) })) }
        }))
      } catch (e) { result.push({ ...base, error: message(e) }) }
    }
    return result
  }

  removeMember(id: string, member: DirectoryMember) {
    this.use(id, db => db.transaction(() => {
      if (available(db, member)) throw new Error('仓库位置可用，请在该仓库预览并解除关联')
      db.prepare('DELETE FROM members WHERE id=? AND root=?').run(member.id, member.root)
    }).immediate())
  }

  previewMissing(id: string, days: number) {
    const age = z.number().int().min(0).max(36500).parse(days)
    return this.use(id, db => missingPlan(db, Math.floor(Date.now()/1000) - age * 86400))
  }

  cleanMissing(id: string, cutoff: number, token: string) {
    z.number().int().max(Math.floor(Date.now()/1000)).parse(cutoff)
    return this.use(id, db => db.transaction(() => {
      const plan = missingPlan(db, cutoff)
      if (plan.token !== token) throw new Error('缺失清单已变化，请重新预览')
      const candidates = 'SELECT m.id FROM missing_files m WHERE m.missingAt<=? AND NOT EXISTS (SELECT 1 FROM entries e WHERE e.id=m.id)'
      db.prepare('DELETE FROM verified_files WHERE id IN (' + candidates + ')').run(cutoff)
      return db.prepare('DELETE FROM missing_files WHERE id IN (' + candidates + ')').run(cutoff).changes
    }).immediate())
  }

  forget(id: string) {
    z.uuid().parse(id)
    const dir = join(this.home, id), staged = join(this.home, retiring + id)
    if (!existsSync(staged)) {
      if (!existsSync(dir)) return
      this.use(id, db => db.transaction(() => {
        if (db.prepare('SELECT 1 FROM members LIMIT 1').get()) throw new Error('仍有仓库关联这个登记簿')
        // 先封住其他进程的并发关联，再关闭数据库，以便 Windows 也能移动并删除文件。
        db.exec(`CREATE TRIGGER IF NOT EXISTS directory_retiring BEFORE INSERT ON members
          BEGIN SELECT RAISE(ABORT,'此登记簿正在忘记，请在应用设置中完成清理'); END`)
      }).immediate())
      renameSync(dir, staged)
    }
    checkStaged(staged, id)
    const { names } = contents(staged)
    for (const file of files) if (names.includes(file)) unlinkSync(join(staged, file))
    rmdirSync(staged)
  }
}
