import type Database from 'better-sqlite3'
import type { DatabaseStorageInfo, DatabaseCompaction } from '../shared/database-maintenance'

/** 仓库库文件维护；不裁剪业务表、不访问 derived.db 或任何文件空间。 */
export class DatabaseMaintenance {
  constructor(private readonly db: Database.Database) {}

  info(): DatabaseStorageInfo {
    const pageSize = Number(this.db.pragma('main.page_size', { simple: true }))
    return {
      allocatedBytes: Number(this.db.pragma('main.page_count', { simple: true })) * pageSize,
      reusableBytes: Number(this.db.pragma('main.freelist_count', { simple: true })) * pageSize
    }
  }

  compact(): DatabaseCompaction {
    if (this.db.inTransaction) throw new Error('[DATABASE_BUSY] 数据库事务尚未完成，请稍后整理')
    if (!this.checkpoint()) throw new Error('[DATABASE_BUSY] 数据库正在被其他连接读取，请稍后整理')
    const before = this.info()
    // 同步运行在唯一写入核心，不能与其他 JS 数据库写入交错。失败由 SQLite 保持数据库完整。
    this.db.exec('VACUUM main')
    const checkpointPending = !this.checkpoint()
    return { before, after: this.info(), checkpointPending }
  }

  private checkpoint(): boolean {
    const [result] = this.db.pragma('main.wal_checkpoint(TRUNCATE)') as { busy: number }[]
    return result.busy === 0
  }
}
