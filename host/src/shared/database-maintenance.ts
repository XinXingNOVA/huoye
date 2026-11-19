/** library.db 的逻辑页占用（含索引及 WAL 中已提交的页）；不另计 WAL 文件体积、派生库或原件。 */
export interface DatabaseStorageInfo {
  allocatedBytes: number
  /** 已删除数据留下、可由后续写入复用的整页；不是可删除素材的大小。 */
  reusableBytes: number
}
export interface DatabaseCompaction {
  before: DatabaseStorageInfo
  after: DatabaseStorageInfo
  /** 整理完成后仍有连接占用 WAL，磁盘回收等待后续检查点。 */
  checkpointPending: boolean
}
