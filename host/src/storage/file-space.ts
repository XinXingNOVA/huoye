// 文件空间目录：身份、模式和关联由空间持有，不保存素材身份与业务数据块。
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { SpaceInfo, SpaceMode } from '../shared/file-spaces'
import { fileReference } from '../shared/file-location'
import { assertSpaceFormat, assertNoLegacyRecovery, legacyStorageError } from './storage-format'
import { versionedSpaceSchema, prepareSpaceSchema } from './file-space-schema'

export const spaceDatabase = '.file-space.db'
export interface SpaceFile {
  id: string; path: string; hash: string; size: number; mtime: number
  revision: number; state: 'pending' | 'available' | 'missing' | 'published' | 'recycled' | 'disposing' | 'disposed'
}

export class FileSpace {
  id!: string
  readonly db: Database.Database
  constructor(readonly root: string, expectedId?: string) {
    assertNoLegacyRecovery(root)
    const marker = join(root, '.migration-owner.json')
    if (existsSync(marker) && !JSON.parse(readFileSync(marker, 'utf8')).complete) throw legacyStorageError()
    const path = join(root, spaceDatabase)
    if (existsSync(path) && realpathSync(path) !== join(realpathSync(root), spaceDatabase)) throw new Error('文件空间登记不能使用符号链接')
    this.db = new Database(path, { fileMustExist: true })
    try {
      const current = this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='space'").get()
        ? this.db.prepare('SELECT id,version FROM space').get() as { id: string; version: number } | undefined : undefined
      if (!current) throw new Error('[FILE_SPACE_IDENTITY] 文件空间初始化未完成或登记无效')
      if (expectedId && current.id !== expectedId) throw new Error('[FILE_SPACE_IDENTITY] 所选位置不是获准的空间')
      assertSpaceFormat(current.version)
      this.assertMaintenance()
      this.db.pragma('busy_timeout = 3000'); this.db.pragma('journal_mode = WAL'); this.db.pragma('synchronous = FULL')
      prepareSpaceSchema(this.db)
      this.id = current.id
    } catch (error) { this.db.close(); throw error }
  }
  close(): void { this.db.close() }
  versioned(): boolean { return Number(this.db.prepare('SELECT version FROM space').pluck().get()) === 4 }
  info(): SpaceInfo {
    const row = this.db.prepare('SELECT id,name,mode,revision FROM space').get() as Omit<SpaceInfo, 'root' | 'members'>
    return { ...row, versioned: this.versioned(), root: this.root, members: Number(this.db.prepare('SELECT count(*) FROM members').pluck().get()) }
  }
  static create(root: string, mode: SpaceMode): SpaceInfo {
    if (mode !== 'private' && mode !== 'shared') throw new Error('无效的空间模式')
    mkdirSync(root) // 不覆盖已有目录，即使它为空。
    const db = new Database(join(root, spaceDatabase))
    try {
      db.pragma('journal_mode = WAL'); db.pragma('synchronous = FULL')
      mkdirSync(join(root, 'files'))
      db.transaction(() => {
        db.exec(versionedSpaceSchema)
        db.prepare('INSERT INTO space (id,owner,version,mode,name) VALUES (?,?,4,?,?)').run(randomUUID(), '', mode, basename(root))
      }).immediate()
    } finally { db.close() }
    const space = new FileSpace(root)
    try {
      return space.info()
    } finally { space.close() }
  }
  changeMode(mode: SpaceMode, revision: number): SpaceInfo {
    this.assertMaintenance()
    return this.db.transaction(() => {
      this.assertMaintenance()
      const info = this.info()
      if (info.revision !== revision) throw new Error('[SPACE_CHANGED] 空间已变化，请刷新后重新确认')
      if (mode !== 'private' && mode !== 'shared') throw new Error('无效的空间模式')
      if (mode === info.mode) return info
      if (mode === 'private' && (info.members > 1 || existsSync(join(this.root, '.file-storage.json')))) throw new Error('仍有多个仓库关联或旧共享登记，不能降为独享')
      this.assertIdle()
      this.db.prepare('UPDATE space SET mode=?, revision=revision+1').run(mode)
      return this.info()
    }).immediate()
  }
  assertIdle(): void {
    const recovery = join(this.root, '.file-recovery')
    if ((existsSync(recovery) && readdirSync(recovery).length) || this.db.prepare("SELECT 1 FROM files WHERE state='pending' LIMIT 1").get()) throw new Error('空间有未完成的文件操作，请先完成恢复或重试')
  }
  connect(libraryId: string, root: string, token: string, versionReader = false): void {
    this.assertMaintenance()
    if (!versionReader) throw new Error('[VERSION_PROTOCOL_REQUIRED] 关联仓库必须支持明确版本引用')
    this.db.transaction(() => {
      this.assertMaintenance()
      const rows = this.db.prepare('SELECT * FROM members').all() as { library_id: string; root: string; token: string }[]
      if (this.info().mode === 'private' && rows.some(row => row.library_id !== libraryId)) throw new Error('[SPACE_PRIVATE] 请先将空间显式转为共享，再关联其他仓库')
      const old = rows.find(row => row.library_id === libraryId)
      if (old && (old.token !== token || (old.root !== root && existsSync(old.root)))) throw new Error('[SPACE_MEMBERSHIP_CONFLICT] 仓库身份或关联凭据重复，请核对仓库副本')
      if (old && old.root !== root) { this.db.prepare('UPDATE members SET root=? WHERE library_id=?').run(root, libraryId); this.bump() }
      if (!old) { this.db.prepare('INSERT INTO members VALUES (?,?,?)').run(libraryId, root, token); this.bump() }
      this.db.prepare('INSERT INTO version_members (library_id,token) VALUES (?,?) ON CONFLICT(library_id) DO UPDATE SET token=excluded.token').run(libraryId, token)
    }).immediate()
  }
  disconnect(libraryId: string, token: string): void {
    this.assertMaintenance()
    this.db.transaction(() => {
      this.assertMaintenance()
      const result = this.db.prepare('DELETE FROM members WHERE library_id=? AND token=?').run(libraryId, token)
      this.db.prepare('DELETE FROM version_members WHERE library_id=? AND token=?').run(libraryId, token)
      if (result.changes) this.bump()
    }).immediate()
  }
  assertMember(libraryId: string, token: string, root?: string): void {
    const member = this.db.prepare('SELECT root FROM members WHERE library_id=? AND token=?').get(libraryId, token) as { root: string } | undefined
    if (member && root && member.root !== root) throw new Error('[SPACE_MEMBERSHIP_CONFLICT] 仓库位置与关联不符，请在原位置移走后显式重新关联；副本不能复用独享权限')
    if (!member) throw new Error('[SPACE_NOT_LINKED] 仓库尚未完成空间关联')
  }
  bump(): void { this.db.exec('UPDATE space SET revision=revision+1') }
  assertMaintenance(): void {
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='space_maintenance'").get()) return
    if (this.db.prepare('SELECT 1 FROM space_maintenance LIMIT 1').get()) throw legacyStorageError()
  }
  exclusive<T>(fn: () => T): T { return this.db.transaction(() => { this.assertMaintenance(); return fn() }).immediate() }

  get(path: string): SpaceFile | undefined {
    return this.db.prepare('SELECT * FROM files WHERE path = ?').get(fileReference(path)) as SpaceFile | undefined
  }
  byId(id: string): SpaceFile | undefined { return this.db.prepare('SELECT * FROM files WHERE id = ?').get(id) as SpaceFile | undefined }
  finishBatch(key: string): void {
    this.db.prepare('DELETE FROM version_import_batches WHERE key=?').run(key)
  }
}
