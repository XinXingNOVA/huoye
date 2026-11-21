import Database from 'better-sqlite3'
import { lstatSync, realpathSync } from 'node:fs'
import { isAbsolute, join, sep } from 'node:path'
import { directoryCatalogHome, directoryStamp } from '../storage/directory-reference'
import { hasDirectoryAccess } from '../storage/directory-members'
import { withSpaceRead, type SpaceBinding } from '../storage/space-bindings'
import { checkedProof, directoryProof, managedAreaProof, readableFolder } from '../storage/missing-check'
import type { Library } from './library'

// 每个分量逐层检查。只有可读目录下的 ENOENT 算缺失，已有文件、符号链接和权限错误都不算。
function absent(root: string, relative: string) {
  const parts = relative.split(sep)
  if (isAbsolute(relative) || parts.some(part => !part || part === '.' || part === '..')) return false
  let parent = root
  for (const part of parts) {
    try { readableFolder(parent) } catch { return false }
    parent = join(parent, part)
    try { lstatSync(parent) }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' }
  }
  return false
}

type MissingFile = { fileId: string; version: string; path: string }
function directoryFiles(lib: Library, spaceId: string, ids?: string[]): MissingFile[] {
  const path = join(directoryCatalogHome(), spaceId, 'catalog.sqlite')
  const catalog = new Database(path, { readonly: true, fileMustExist: true, timeout: 3000 })
  try {
    return catalog.transaction(() => {
      if (!hasDirectoryAccess(catalog, lib)) throw new Error('请先重新关联原地目录')
      const source = catalog.prepare('SELECT root,device,inode FROM source WHERE id=?').get(spaceId) as
        { root: string; device: string; inode: string } | undefined
      if (!source) throw new Error('来源身份已变化，请重新关联')
      const root = readableFolder(source.root)
      if (String(root.dev) !== source.device || String(root.ino) !== source.inode) throw new Error('来源目录离线或已被替换')
      const proof = checkedProof(catalog)
      if (!proof) throw new Error((proof === null ? '上次核对未完成' : '尚无完整核对结果') + '，请在原地目录点「核对整个空间」')
      const stamps = new Map<string, string>()
      for (const rel of catalog.prepare('SELECT path FROM entries WHERE folder=1').pluck().iterate() as Iterable<string>) {
        if (isAbsolute(rel) || rel.split(sep).includes('..')) throw new Error('登记目录位置无效')
        try { stamps.set(rel, directoryStamp(readableFolder(join(source.root, rel)))) }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('子目录在核对后有变化，请再次「核对整个空间」')
          throw error
        }
      }
      if (directoryProof(source.root, stamps) !== proof) throw new Error('目录在核对后有变化，请再次「核对整个空间」')
      const rows = catalog.prepare(`SELECT m.id AS fileId, m.path, v.hash AS version FROM missing_files m
        JOIN verified_files v ON v.id=m.id WHERE NOT EXISTS (SELECT 1 FROM entries e WHERE e.id=m.id)
        AND (@ids IS NULL OR m.id IN (SELECT value FROM json_each(@ids)))`).all({ ids: ids ? JSON.stringify(ids) : null }) as MissingFile[]
      // 仓库可引用更早的 hash；只把最后已核对版本也一致的主文件加入这一批。
      return rows.filter(row => absent(source.root, row.path))
    })()
  } finally { catalog.close() }
}

function managedFiles(lib: Library, binding: SpaceBinding, ids?: string[]): MissingFile[] {
  if (binding.state !== 'active') throw new Error('请先重新关联文件空间')
  return withSpaceRead(lib.root, lib.db, binding, (db, root) => db.transaction(() => {
    const directory = realpathSync(root)
    const proof = checkedProof(db), area = managedAreaProof(directory)
    if (proof !== area) throw new Error((proof === null ? '上次检查未完成' : '尚无适用于当前位置的完成记录') + '，请在「磁盘检查」重新检查')
    // 本库旧版本有新版可接纳、空间回收站及处置中的原件，各自使用自己的恢复流程。
    const rows = db.prepare(`SELECT v.fileId, v.id version, v.path FROM space_disk_observations o
      JOIN missing_check c ON c.run=json_extract(o.observation,'$.scanRun')
      JOIN file_versions v ON v.id=o.version_id JOIN file_heads h ON h.fileId=v.fileId AND h.contentVersion=v.id
      JOIN files f ON f.id=v.fileId AND f.state='available'
      WHERE json_extract(o.observation,'$.state')='missing' AND json_extract(o.observation,'$.path')=v.path
      AND NOT EXISTS (SELECT 1 FROM space_file_records r WHERE r.file_id=f.id AND r.busy_request IS NOT NULL)
      AND (@ids IS NULL OR v.fileId IN (SELECT value FROM json_each(@ids)))`).all({ ids: ids ? JSON.stringify(ids) : null }) as MissingFile[]
    if (rows.some(row => row.path.startsWith('files/.versions/'))) readableFolder(join(directory, 'files', '.versions'))
    return rows.filter(row => row.path.startsWith('files/') && absent(directory, row.path.split('/').join(sep)))
  })())
}

export function missingMessage(error: unknown) {
  const code = (error as NodeJS.ErrnoException)?.code
  if (code === 'ENOENT' || code === 'SQLITE_CANTOPEN') return '文件空间或本机登记簿离线，请检查位置与关联'
  if (code === 'EACCES' || code === 'EPERM') return '没有足够权限核对目录，请检查访问权限'
  return error instanceof Error ? error.message : String(error)
}

export function missingFile(missing: Map<string, MissingFile>, ref: { fileId: string; hash?: string; contentVersion?: string }) {
  const file = missing.get(ref.fileId)
  return file && file.version === (ref.hash ?? ref.contentVersion) ? file : undefined
}
export function confirmedMissing(lib: Library, spaceId: string, ids?: string[]) {
  const binding = lib.files.bindings?.rows().find(row => row.id === spaceId)
  const files = binding ? managedFiles(lib, binding, ids) : directoryFiles(lib, spaceId, ids)
  return new Map(files.map(file => [file.fileId, file]))
}
