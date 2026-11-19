import type Database from 'better-sqlite3'
import { existsSync, mkdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { FileSpace } from './file-space'
import { SpaceVersions } from './space-versions'

/** 随库只是位置关系；新版空间仍有自己的目录、身份和版本协议。 */
export function createManagedSpace(db: Database.Database, root: string, owner: string): void {
  const relative = 'file-spaces/default', directory = join(root, relative)
  db.prepare("INSERT OR IGNORE INTO meta VALUES ('managed_space_pending', ?)").run(relative)
  mkdirSync(join(root, 'file-spaces'), { recursive: true })
  const versions = existsSync(directory) ? new SpaceVersions(new FileSpace(directory)) : SpaceVersions.create(directory, 'private')
  const space = versions.space
  try {
    const storedOwner = space.db.prepare('SELECT owner FROM space').pluck().get()
    if (storedOwner && storedOwner !== owner) throw new Error('[FILE_SPACE_IDENTITY] 随库空间属于另一仓库')
    if (space.info().mode !== 'private' || space.db.prepare('SELECT 1 FROM files LIMIT 1').get()) throw new Error('初始化目标不是空的独享空间')
    space.db.prepare('UPDATE space SET owner=?,name=?').run(owner, '随库文件空间')
    const token = space.db.prepare('SELECT token FROM members WHERE library_id=?').pluck().get(owner) as string || randomUUID()
    space.connect(owner, realpathSync(root), token, true)
    space.db.prepare('UPDATE version_members SET revise=1,recycle=1 WHERE library_id=?').run(owner)
    db.transaction(() => {
      db.prepare("INSERT INTO file_spaces VALUES (?,?,?,'active',1,1)").run(space.id, relative, token)
      db.prepare("INSERT OR REPLACE INTO meta VALUES ('managed_space_root',?),('default_file_space',?)").run(relative, space.id)
      db.prepare("DELETE FROM meta WHERE key='managed_space_pending'").run()
    })()
  } finally { space.close() }
}
