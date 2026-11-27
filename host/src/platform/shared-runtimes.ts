import Database from 'better-sqlite3'
import { accessSync, constants, existsSync, lstatSync, realpathSync, mkdirSync, mkdtempSync, readdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { z } from 'zod'
import { checkManifest, executable, extractRuntime, misplacedDll, type RuntimeManifest } from './runtime-package'
import type { RuntimeInfo, RuntimeIdentity, SharedPrograms } from '../shared/shared-runtimes'

const digestId = z.string().regex(/^[a-f0-9]{64}$/)
interface Row { digest: string; manifest: string; enabled: number; inUse: number }
function alive(pid: number) {
  try { process.kill(pid, 0); return true }
  catch (err) { return (err as NodeJS.ErrnoException).code !== 'ESRCH' }
}

function brokenFiles(directory: string, m: RuntimeManifest) {
  const executables = new Set(m.programs.map(p => executable(p, m.target)))
  return m.files.filter(file => {
    if (file.path.startsWith('licenses/')) return false
    const path = join(directory, file.path)
    try {
      const stat = lstatSync(path)
      if (!stat.isFile() || stat.size !== file.size || realpathSync(path) !== path || misplacedDll(m.target, file.path)) return true
      accessSync(path, executables.has(file.path) && process.platform !== 'win32' ? constants.X_OK : constants.R_OK)
      return false
    } catch { return true }
  }).map(f => f.path)
}

export interface RuntimeSnapshot { programs: SharedPrograms; installed: RuntimeIdentity[]; release(): void }

export class SharedRuntimes {
  private readonly db: Database.Database
  private readonly root: string
  constructor(home: string) {
    this.root = join(home, 'capability-runtimes')
    mkdirSync(this.root, { recursive: true, mode: 0o700 })
    this.root = realpathSync(this.root)
    this.db = new Database(join(this.root, 'catalog.sqlite'))
    this.db.pragma('busy_timeout = 3000')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS packages(digest TEXT PRIMARY KEY, manifest TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS leases(session TEXT NOT NULL, digest TEXT NOT NULL, pid INTEGER NOT NULL, PRIMARY KEY(session,digest));
    `)
    this.db.transaction(() => {
      for (const name of readdirSync(this.root)) {
        const temp = /^\.(installed|removed)-(\d+)-/.exec(name)
        if (temp && !alive(Number(temp[2]))) this.discard(name)
        if (digestId.safeParse(name).success && !this.has(name)) this.discard(name)
      }
    }).immediate()
  }
  private has(digest: string) { return !!this.db.prepare('SELECT 1 FROM packages WHERE digest=?').get(digest) }
  // Rename before asynchronous removal so the same digest can be reinstalled immediately.
  private discard(name: string) {
    const trash = join(this.root, '.removed-' + process.pid + '-' + randomUUID())
    renameSync(join(this.root, name), trash)
    return rm(trash, { recursive: true, force: true }).catch(error => console.warn('[runtimes] 旧文件未能清理', error))
  }
  close() { this.db.close() }
  list(): RuntimeInfo[] {
    const pids = this.db.prepare('SELECT DISTINCT pid FROM leases WHERE pid<>?').pluck().all(process.pid) as number[]
    for (const pid of pids) if (!alive(pid)) this.db.prepare('DELETE FROM leases WHERE pid=?').run(pid)
    const rows = this.db.prepare(`SELECT *, EXISTS(SELECT 1 FROM leases l WHERE l.digest=p.digest) AS inUse
      FROM packages p ORDER BY digest`).all() as Row[]
    return rows.map(row => {
      const m = checkManifest(JSON.parse(row.manifest))
      const broken = brokenFiles(join(this.root, row.digest), m)
      return { ...(broken.length ? { brokenFiles: broken } : {}), digest: row.digest, id: m.id, target: m.target, version: m.version, programs: m.programs,
        bytes: m.files.reduce((n, f) => n + f.size, 0), enabled: !!row.enabled, inUse: !!row.inUse }
    })
  }
  async install(path: string, digest: string) {
    digestId.parse(digest)
    const stage = mkdtempSync(join(this.root, '.installed-' + process.pid + '-'))
    try {
      const item = await extractRuntime(path, digest, stage)
      this.db.transaction(() => {
        const installed = this.list().find(row => row.digest === digest)
        if (installed && !installed.brokenFiles) return
        if (installed?.inUse) throw Error('请先停用损坏的运行包并重载使用它的仓库，再重新安装')
        const dest = join(this.root, digest)
        if (lstatSync(dest, { throwIfNoEntry: false })) this.discard(digest)
        renameSync(stage, dest)
        if (!installed) this.db.prepare('INSERT INTO packages(digest, manifest) VALUES (?,?)').run(digest, item.metadata.toString('utf8'))
      }).immediate()
    } finally { await rm(stage, { recursive: true, force: true }) }
  }
  setEnabled(digest: string, value: boolean) {
    digestId.parse(digest)
    if (typeof value !== 'boolean') throw Error('无效状态')
    this.db.transaction(() => {
      const rows = this.list(), current = rows.find(r => r.digest === digest)
      if (!current) throw Error('运行包未安装')
      const set = this.db.prepare('UPDATE packages SET enabled=? WHERE digest=?')
      if (value) {
        if (current.target !== process.platform + '-' + process.arch) throw Error('运行包与当前系统或架构不符')
        for (const row of rows.filter(r => r.enabled && r.digest !== digest)) {
          if (row.id === current.id) set.run(0, row.digest)
          else if (row.programs.some(p => current.programs.includes(p))) throw Error('请先停用提供同名程序的运行包：' + row.id)
        }
      }
      set.run(Number(value), digest)
    }).immediate()
  }
  async remove(digest: string) {
    digestId.parse(digest)
    this.db.transaction(() => {
      const entry = this.list().find(p => p.digest === digest)
      if (entry?.enabled || entry?.inUse) throw Error('请先停用运行包，并重载或关闭使用它的仓库')
      this.db.prepare('DELETE FROM packages WHERE digest=?').run(digest)
    }).immediate()
    // A concurrent install may already have reclaimed this digest since the commit.
    let cleanup: Promise<void> | undefined
    this.db.transaction(() => {
      if (!this.has(digest) && existsSync(join(this.root, digest))) cleanup = this.discard(digest)
    }).immediate()
    await cleanup
  }
  snapshot(): RuntimeSnapshot {
    const session = randomUUID()
    const programs: SharedPrograms = Object.create(null)
    const installed = this.db.transaction(() => {
      const rows = this.list().filter(row => row.target === process.platform + '-' + process.arch)
      const active = rows.filter(row => row.enabled)
      const pin = this.db.prepare('INSERT INTO leases VALUES (?,?,?)')
      for (const row of active) {
        const bins = row.programs.map(name => executable(name, row.target))
        const common = row.brokenFiles?.find(file => !bins.includes(file))
        for (const [i, name] of row.programs.entries()) {
          const bad = common ?? row.brokenFiles?.find(file => file === bins[i])
          programs[name] = { path: join(this.root, row.digest, bins[i]), digest: row.digest,
            ...(bad ? { problem: '共享运行包 ' + row.id + ' 的 ' + bad + ' 不可用，请重新安装运行包' } : {}) }
        }
        if (row.programs.some(name => !programs[name].problem)) pin.run(session, row.digest, process.pid)
      }
      return rows.map(({ digest, programs }) => ({ digest, programs }))
    }).immediate()
    return { programs, installed, release: () => { this.db.prepare('DELETE FROM leases WHERE session=?').run(session) } }
  }
}
