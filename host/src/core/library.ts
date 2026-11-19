// 素材库：身份与数据所属文件夹；共享文件可依赖另一存储，见设计文档 12.1。

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { prepareLibrarySchema } from './schema'
import { handoffPlayback } from './playback-handoff'
import { handoffPalette } from './palette-handoff'
import { LibraryFiles } from '../storage/library-files'
import { createManagedSpace } from '../storage/managed-space'
import { assertLibraryFormat, assertNoLegacyRecovery } from '../storage/storage-format'

export interface Library {
  root: string
  /** 素材库的固定 ID：库被移动后，应用本地的工作区仍能对应上。 */
  id: string
  db: Database.Database
  files: LibraryFiles
  close(): void
}

/** 这个进程里打开着的库：同一个进程里也不能打开两次。 */
const openHere = new Set<string>()

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    // 进程存在但没有权限发信号，也算活着
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * 仓库锁：同一个仓库同时只能被一个进程打开，否则两个核心进程会同时写同一个数据库。
 * 锁文件里是持有它的进程号；那个进程已经不在了（崩溃留下的），就接管过来。
 */
export function lockLibrary(root: string): () => void {
  const key = resolve(root)
  const file = join(root, '.lock')
  const busy = () => new Error('这个仓库已经在另一个窗口或程序里打开了')
  if (openHere.has(key)) throw busy()
  try {
    writeFileSync(file, String(process.pid), { flag: 'wx' })
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    const holder = Number(readFileSync(file, 'utf8'))
    if (holder && holder !== process.pid && alive(holder)) throw busy()
    writeFileSync(file, String(process.pid))
  }
  openHere.add(key)
  return () => {
    openHere.delete(key)
    try {
      if (Number(readFileSync(file, 'utf8')) === process.pid) unlinkSync(file)
    } catch {
      // 锁文件已经不在了
    }
  }
}

export function openLibrary(root: string, expectedId?: string, initialId?: string): Library {
  let newDatabase = !existsSync(join(root, 'library.db'))
  const files = new LibraryFiles(root)
  mkdirSync(root, { recursive: true })
  const unlock = lockLibrary(root)

  let db: Database.Database | undefined
  try {
    db = new Database(join(root, 'library.db'), { fileMustExist: !!expectedId })
    // 本次已认领目录在 SQLite 建文件后、首事务提交前退出：空数据库可继续。
    if (initialId && !expectedId && !newDatabase && !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' LIMIT 1").get()) newDatabase = true
    const requiredId = expectedId ?? (!newDatabase ? initialId : undefined)
    if (requiredId) {
      let actual: unknown
      try { actual = db.prepare("SELECT value FROM main.meta WHERE key = 'library_id'").pluck().get() } catch { /* 不在未知数据库里建表或迁移 */ }
      if (actual !== requiredId) throw new Error('[LIBRARY_CHANGED] 仓库身份与授权不一致')
    }
    if (!newDatabase) { assertLibraryFormat(db); assertNoLegacyRecovery(root) }
    files.initialize()
    mkdirSync(join(root, 'backups'), { recursive: true })
    db.prepare('ATTACH DATABASE ? AS derived').run(join(root, 'derived.db'))
    for (const s of ['main', 'derived']) {
      db.pragma(`${s}.journal_mode = WAL`)
      // 原始记录承载文件提交标记；其持久性不能弱于空间目录，派生数据仍可重建。
      db.pragma(`${s}.synchronous = ${s === 'main' ? 'FULL' : 'NORMAL'}`)
      // 默认缓存只有约 2MB，十万级素材时查询会频繁读盘
      db.pragma(`${s}.cache_size = -65536`)
      db.pragma(`${s}.mmap_size = 268435456`)
    }
    db.pragma('temp_store = MEMORY')
    db.transaction(() => {
      prepareLibrarySchema(db!)
      handoffPalette(db!)
      handoffPlayback(db!)
      if (newDatabase) db!.prepare("INSERT INTO main.meta (key, value) VALUES ('plugin_defaults_pending', '1')").run()
      db!.prepare("INSERT OR IGNORE INTO main.meta (key, value) VALUES ('library_id', ?)").run(initialId ?? randomUUID())
    })()
    const id = db.prepare("SELECT value FROM main.meta WHERE key = 'library_id'").pluck().get() as string
    if (initialId && id !== initialId) throw new Error('[LIBRARY_CHANGED] 创建任务与仓库身份不一致')
    if (newDatabase || db.prepare("SELECT 1 FROM meta WHERE key='managed_space_pending'").get()) createManagedSpace(db, root, id)
    files.bind(db, id)
    const opened = db
    return {
      root,
      id,
      db: opened,
      files,
      close: () => {
        files.close()
        opened.close()
        unlock()
      }
    }
  } catch (e) {
    // 打不开（例如不是素材库的数据库文件）：放开锁，别留下半开的库
    files.close()
    db?.close()
    unlock()
    throw e
  }
}
