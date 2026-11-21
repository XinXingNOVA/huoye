import Database from 'better-sqlite3'
import { lstatSync, realpathSync, type BigIntStats } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { hasDirectoryAccess } from './directory-members'
import { fileReference } from '../shared/file-location'
import { portableFileName } from '../shared/paths'

export const directoryStamp = (s: BigIntStats) => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(':')
const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}'
const pattern = new RegExp(`^directories/v1/(${uuid})/(${uuid})/([a-f0-9]{64})/[^/]+$`)
export function parseDirectoryReference(reference: string) {
  const ref = fileReference(reference)
  if (!ref.startsWith('directories/')) return
  const match = pattern.exec(ref)
  if (!match) throw new Error('原地文件引用无效')
  return { spaceId: match[1], fileId: match[2], hash: match[3] }
}
export function directoryReference(spaceId: string, fileId: string, hash: string, name: string) {
  return `directories/v1/${spaceId}/${fileId}/${hash}/${portableFileName(name) || 'file'}`
}
export function directoryCatalogHome() {
  const home = process.env.HUOYE_DIRECTORY_CATALOG
  if (!home) throw new Error('当前进程未连接本机原地目录登记簿')
  return home
}

type DirectoryIdentity = NonNullable<ReturnType<typeof parseDirectoryReference>>
export type DirectoryHead = { path: string; stamp: string; size: number; hash: string; root: string; name: string; revision: number }

/** 预览和接纳只使用仍与磁盘一致的已核对记录。接纳期间锁住登记簿，防止并发核对或解除关联。 */
export function withDirectoryHead<T>(libraryRoot: string, owner: string | undefined, ref: DirectoryIdentity,
  use: (head: DirectoryHead) => T, lock = false): T {
  if (!owner) {
    const db = new Database(join(libraryRoot, 'library.db'), { readonly: true, fileMustExist: true })
    try { owner = db.prepare("SELECT value FROM meta WHERE key='library_id'").pluck().get() as string } finally { db.close() }
  }
  const catalog = new Database(join(directoryCatalogHome(), ref.spaceId, 'catalog.sqlite'), { readonly: !lock, fileMustExist: true, timeout: 3000 })
  const read = () => {
    if (!hasDirectoryAccess(catalog, { id: owner!, root: libraryRoot })) throw Object.assign(new Error('原地目录未关联，请在文件空间重新关联'), { code: 'DIRECTORY_NOT_LINKED' })
    const row = catalog.prepare(`SELECT s.root,s.name,s.device,s.inode,e.path,e.size,e.stamp,v.stamp AS verifiedStamp,v.hash,v.revision
      FROM source s JOIN entries e ON e.id=? AND e.folder=0 JOIN verified_files v ON v.id=e.id
      WHERE s.id=?`).get(ref.fileId, ref.spaceId) as
      {root: string; name: string; device: string; inode: string; path: string; size: number; stamp: string; verifiedStamp: string | null; hash: string; revision: number} | undefined
    if (!row) throw new Error('空间中未找到已核对的文件位置')
    const rootStat = lstatSync(row.root, { bigint: true })
    if (!rootStat.isDirectory() || String(rootStat.dev) !== row.device || String(rootStat.ino) !== row.inode) throw new Error('原地目录离线或被替换')
    const path = join(row.root, row.path), rel = relative(row.root, path)
    if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel) || realpathSync(path) !== path) throw new Error('原地文件位置已变化')
    const stat = lstatSync(path, { bigint: true })
    if (!stat.isFile() || directoryStamp(stat) !== row.verifiedStamp || row.stamp !== row.verifiedStamp)
      throw Object.assign(new Error('原地文件已变化，请核对内容版本'), { code: 'DIRECTORY_CHANGED' })
    return use({ path, stamp: row.stamp, size: row.size, hash: row.hash, root: row.root, name: row.name, revision: row.revision })
  }
  try { return lock ? catalog.transaction(read).immediate() : catalog.transaction(read).deferred() } finally { catalog.close() }
}

export function readDirectoryReference(libraryRoot: string, owner: string | undefined, ref: DirectoryIdentity) {
  return withDirectoryHead(libraryRoot, owner, ref, head => {
    if (ref.hash !== head.hash) throw new Error('原地文件内容与本库收录的版本不同，该版本的原件当前不可读')
    return head
  })
}
