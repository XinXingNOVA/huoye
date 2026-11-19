import { assertSpaceSchemaReady } from './file-space-schema'
import { assertFileAvailable, checkedVersionPath } from './version-read'
// 两侧登记分步提交；pending/detaching 保留到显式重试，离线不冒充解除成功。
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import { basename, join, relative, isAbsolute, sep } from 'node:path'
import { FileSpace, type SpaceFile, spaceDatabase } from './file-space'
import { assertSpaceFormat, legacyStorageError } from './storage-format'
import { versionFile } from './space-versions'
import { parseSpaceReference, spaceReference } from './space-reference'
import { fileReference } from '../shared/file-location'
import type { SpaceBindingInfo } from '../shared/file-spaces'

export interface SpaceBinding { id: string; root: string; token: string; state: 'active' | 'pending' | 'detaching' | 'detached'; embedded: number; is_default: number }
export const bindingPath = (root: string, binding: Pick<SpaceBinding, 'embedded' | 'root'>): string => binding.embedded ? join(root, binding.root) : binding.root
export class SpaceBindings {
  private opened = new Map<string, FileSpace>()
  constructor(readonly db: Database.Database, readonly owner: string, readonly root: string) {}
  rows(): SpaceBinding[] { return this.db.prepare('SELECT * FROM main.file_spaces ORDER BY embedded DESC,id').all() as SpaceBinding[] }
  binding(id: string): SpaceBinding {
    const binding = this.db.prepare('SELECT * FROM main.file_spaces WHERE id=?').get(id) as SpaceBinding | undefined
    if (!binding) throw new Error('[SPACE_NOT_LINKED] 此仓库没有关联该文件空间')
    return binding
  }
  path(binding: SpaceBinding): string { return bindingPath(this.root, binding) }
  open(id: string): FileSpace {
    const row = this.binding(id)
    if (row.state !== 'active') throw new Error('[SPACE_NOT_LINKED] 空间关联尚未完成或已解除')
    const root = this.path(row)
    if (!existsSync(join(root, spaceDatabase))) throw new Error('[FILE_SPACE_OFFLINE] 文件空间离线，请重新关联位置')
    let space = this.opened.get(id)
    if (!space) { space = new FileSpace(root); this.opened.set(id, space) }
    if (space.id !== id) { if (!row.embedded) { space.close(); this.opened.delete(id) }; throw new Error('[FILE_SPACE_IDENTITY] 所选位置不是原文件空间') }
    space.assertMember(this.owner, row.token, row.embedded ? undefined : realpathSync(this.root))
    return space
  }
  list(): SpaceBindingInfo[] {
    return this.rows().map(row => {
      const base: SpaceBindingInfo = { id: row.id, root: this.path(row), name: basename(this.path(row)), embedded: !!row.embedded, default: !!row.is_default, state: row.state }
      try {
        const space = this.open(row.id)
        return { ...base, ...space.info(), ...this.permissions(row.id) }
      } catch (e) { return { ...base, error: String(e) } }
    })
  }
  permissions(id: string): { canRevise: boolean; canRecycle: boolean } {
    const row = this.binding(id), space = this.open(id)
    const grant = space.db.prepare('SELECT revise,recycle FROM version_members WHERE library_id=? AND token=?').get(this.owner, row.token) as { revise: number; recycle: number } | undefined
    return { canRevise: !!grant?.revise, canRecycle: !!grant?.recycle }
  }
  connect(root: string, expectedId?: string): string {
    root = realpathSync(root)
    const space = new FileSpace(root, expectedId)
    try {
      // 只有版本读取适配已就绪的宿主可以登记新格式关联。
      const old = this.rows().find(row => row.id === space.id)
      if (old?.embedded) { space.close(); return old.id }
      if (old && old.root !== root && existsSync(join(old.root, spaceDatabase))) throw new Error('同身份空间仍存在于原位置；不自动改用副本')
      if (old?.state === 'detaching') throw new Error('请先完成上次解除，再重新关联')
      const token = old?.token ?? randomUUID()
      this.db.prepare(`INSERT INTO main.file_spaces VALUES (?,?,?,'pending',0,0)
        ON CONFLICT(id) DO UPDATE SET root=excluded.root,state='pending'`).run(space.id, root, token)
      try {
        space.connect(this.owner, realpathSync(this.root), token, true)
      } catch (error) {
        // 空间登记是事务：明确失败时恢复本库原状；成功后的故障仍保留 pending 供重试。
        if (old) this.db.prepare('UPDATE main.file_spaces SET root=?,state=? WHERE id=?').run(old.root, old.state, old.id)
        else this.db.prepare("DELETE FROM main.file_spaces WHERE id=? AND state='pending'").run(space.id)
        throw error
      }
      this.db.prepare("UPDATE main.file_spaces SET state='active' WHERE id=?").run(space.id)
      this.opened.get(space.id)?.close(); this.opened.set(space.id, space)
      return space.id
    } catch (e) { space.close(); throw e }
  }
  setDefault(id: string): void {
    this.open(id)
    this.db.transaction(() => {
      this.db.exec('UPDATE main.file_spaces SET is_default=0')
      this.db.prepare('UPDATE main.file_spaces SET is_default=1 WHERE id=?').run(id)
    })()
  }
  default(): { binding: SpaceBinding; space: FileSpace } {
    const row = this.rows().find(row => row.is_default)
    if (!row) throw new Error('[FILE_SPACE_OFFLINE] 尚未设置默认写入空间')
    return { binding: row, space: this.open(row.id) }
  }
  disconnect(id: string): void {
    const row = this.binding(id)
    // 随库空间使用相对绑定，当前不支持解除。
    if (row.embedded) throw new Error('随库空间暂不支持解除；可以另选默认写入空间')
    if (row.is_default) throw new Error('请先选择其他默认写入空间')
    const root = this.path(row), space = new FileSpace(root)
    try {
      if (space.id !== id) throw new Error('[FILE_SPACE_IDENTITY] 文件空间身份不匹配')
      this.db.prepare("UPDATE main.file_spaces SET state='detaching' WHERE id=?").run(id)
      space.disconnect(this.owner, row.token)
      this.db.prepare("UPDATE main.file_spaces SET state='detached' WHERE id=?").run(id)
      this.opened.get(id)?.close(); this.opened.delete(id)
    } finally { space.close() }
  }
  forgetReason(id: string): string | undefined {
    const row = this.binding(id)
    return row.embedded ? '随库空间不能移除记录' : row.is_default ? '默认写入空间不能移除记录' : row.state !== 'detached' ? '请先完成解除关联，再移除记录' : undefined
  }
  /** 只移除本仓库已解除的关联登记；空间目录可已不存在，不访问它。 */
  forget(id: string): void {
    if (!this.rows().some(row => row.id === id)) return
    const reason = this.forgetReason(id)
    if (reason) throw new Error(reason)
    this.db.prepare("DELETE FROM main.file_spaces WHERE id=? AND state='detached'").run(id)
    this.opened.get(id)?.close(); this.opened.delete(id)
  }
  close(): void { for (const space of this.opened.values()) space.close(); this.opened.clear() }
}

/** 主进程只读会话；每次检查关联和身份，不初始化空间或登记权限。 */
function withSpaceRead<T>(root: string, library: Database.Database, binding: SpaceBinding, read: (space: Database.Database, directory: string, mode: 'private' | 'shared') => T): T {
  const directory = bindingPath(root, binding), path = join(directory, spaceDatabase)
  if (realpathSync(path) !== join(realpathSync(directory), spaceDatabase)) throw new Error('空间目录库不能是符号链接')
  const space = new Database(path, { readonly: true, fileMustExist: true })
  try {
    const info = space.prepare('SELECT id,mode,version FROM space').get() as { id: string; mode: 'private' | 'shared'; version: number }
    assertSpaceFormat(info.version)
    assertSpaceSchemaReady(space)
    if (info.id !== binding.id) throw new Error('[FILE_SPACE_IDENTITY] 空间身份不匹配')
    const owner = library.prepare("SELECT value FROM meta WHERE key='library_id'").pluck().get()
    const member = space.prepare('SELECT root FROM members WHERE library_id=? AND token=?').get(owner, binding.token) as { root: string } | undefined
    if (member && !binding.embedded && member.root !== realpathSync(root)) throw new Error('[SPACE_MEMBERSHIP_CONFLICT] 仓库位置与空间关联不符，请显式重新关联')
    if (!member) throw new Error('[SPACE_NOT_LINKED] 空间未认可此仓库关联')
    return read(space, directory, info.mode)
  } finally { space.close() }
}
export function resolveSpaceFile(root: string, ref: string): { root: string; file: SpaceFile; mode: 'private' | 'shared'; path: string } {
  const parsed = parseSpaceReference(ref)
  if (!parsed?.contentVersion) throw legacyStorageError()
  const library = new Database(join(root, 'library.db'), { readonly: true, fileMustExist: true })
  try {
    const binding = library.prepare("SELECT * FROM file_spaces WHERE id=? AND state='active'").get(parsed.spaceId) as SpaceBinding | undefined
    if (!binding) throw new Error('[SPACE_NOT_LINKED] 此仓库未关联空间')
    return withSpaceRead(root, library, binding, (space, directory, mode) => {
      const file = space.prepare('SELECT * FROM files WHERE id=?').get(parsed.fileId) as SpaceFile | undefined
      assertFileAvailable(file)
      return { root: directory, file: versionFile(space, file!, parsed.contentVersion), mode,
        path: checkedVersionPath(space, directory, parsed.fileId, parsed.contentVersion!) }
    })
  } finally { library.close() }
}

/** 物理路径先按空间和版本登记缩小候选；结果尚须与仓库当前块及可用性核对。 */
export function findSpaceReferences(root: string, library: Database.Database, paths: string[]): string[] {
  const references: string[] = []
  const bindings = library.prepare("SELECT * FROM file_spaces WHERE state='active'").all() as SpaceBinding[]
  for (const binding of bindings) {
    try {
      const directory = realpathSync(bindingPath(root, binding))
      const relatives = paths.flatMap(path => {
        try {
          const rel = relative(directory, path)
          return rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel) ? [fileReference(rel)] : []
        } catch { return [] }
      })
      if (!relatives.length) continue
      withSpaceRead(root, library, binding, space => {
        const query = space.prepare(`SELECT id,fileId,name FROM file_versions WHERE path ${process.platform === 'win32' ? 'COLLATE NOCASE' : ''} IN (SELECT value FROM json_each(?))`)
        for (const version of query.all(JSON.stringify(relatives)) as { id: string; fileId: string; name: string }[]) references.push(spaceReference(binding.id, version.fileId, version.name, version.id))
      })
    } catch { /* 离线或失效关联不参与身份识别；其他空间仍可继续。 */ }
  }
  return references
}
