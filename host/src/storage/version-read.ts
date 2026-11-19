// 纯读取规则；不构造文件空间、不补表，也不登记或修改权限。
import type Database from 'better-sqlite3'
import { existsSync, lstatSync, realpathSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { DiskObservation } from '../shared/space-disk'
import { fingerprint, sameFingerprint } from './disk-observation'
import { fileReference } from '../shared/file-location'

export function versionPath(root: string, reference: string): string {
  let path = realpathSync(root)
  for (const part of fileReference(reference).split('/')) {
    path = join(path, part)
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error('[INVALID_FILE_REFERENCE] 版本位置不能使用符号链接')
  }
  return path
}
export function checkedVersionPath(db: Database.Database, root: string, fileId: string, contentVersion: string): string {
  const version = db.prepare('SELECT path,size,mtime FROM file_versions WHERE fileId=? AND id=?').get(fileId, contentVersion) as { path: string; size: number; mtime: number } | undefined
  if (!version) throw new Error('[NOT_FOUND] 内容版本不存在')
  if (!fileReference(version.path).startsWith('files/')) throw new Error('[INVALID_FILE_REFERENCE] 空间文件位置无效')
  const path = versionPath(root, version.path), value = statSync(path)
  const record = db.prepare('SELECT observation FROM space_disk_observations WHERE version_id=?').get(contentVersion) as { observation: string } | undefined
  const observed = record ? JSON.parse(record.observation) as DiskObservation : undefined
  // 完整检查可能发现 stat 未变的失配；不能再通过原来的 size/mtime 快速读绕过。
  if (observed && observed.state !== 'unchanged') throw new Error('[FILE_CHANGED] 此版本存在磁盘变化，请到文件空间的磁盘检查中处理')
  const verified = observed?.path === version.path && sameFingerprint(observed.fingerprint, fingerprint(value))
  if (!value.isFile() || value.size !== version.size || (observed ? !verified : value.mtimeMs !== version.mtime)) throw new Error('[FILE_CHANGED] 版本内容在应用外发生变化')
  return path
}
export function assertFileAvailable(file: { state: string } | undefined): void {
  if (!file || file.state !== 'available') throw new Error('[FILE_UNAVAILABLE] ' + (file?.state === 'disposed' ? '原件已移到系统废纸篓' : file?.state === 'disposing' ? '原件处置未完成，请在文件空间记录管理中处理' : '原件不可用或已回收'))
}
