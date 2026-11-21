// 仓库文件定位与缓存管理；原件只通过已关联空间的明确版本访问。
import { constants, createReadStream, existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { copyFile, mkdir, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { FileStorageInfo } from '../shared/file-storage'
import { fileReference, importedFileReference, localFilePath } from '../shared/file-location'
import { FileSpace } from './file-space'
import { SpaceVersions, versionFile } from './space-versions'
import { SpaceBindings, resolveSpaceFile } from './space-bindings'
import { parseSpaceReference, spaceReference } from './space-reference'
import { hashFile } from './file-hash'
import { parseDirectoryReference, readDirectoryReference, withDirectoryHead } from './directory-reference'
import { legacyStorageError } from './storage-format'

export type FileStatus = { state: 'available'; size: number } | { state: 'missing' } | { state: 'unavailable'; reason: string }
const inside = (root: string, path: string) => {
  const back = relative(root, path)
  return back !== '..' && !back.startsWith(`..${sep}`) && !isAbsolute(back)
}
const missing = (e: unknown) => (e as NodeJS.ErrnoException).code === 'ENOENT'
export class LibraryFiles {
  readonly root: string
  bindings?: SpaceBindings
  private owner?: string
  constructor(root: string) { this.root = resolve(root) }
  initialize(): void { this.directory('cache') }
  bind(db: Database.Database, owner: string): void {
    this.owner = owner
    if (!db.prepare("SELECT 1 FROM meta WHERE key='managed_space_root'").get()) throw legacyStorageError()
    this.bindings = new SpaceBindings(db, owner, this.root)
    const expected = db.prepare("SELECT value FROM meta WHERE key='default_file_space'").pluck().get() as string
    const binding = this.bindings.binding(expected), directory = this.bindings.path(binding)
    // 离线仍允许读取仓库业务块；原件访问和导入不得回退另建空间。
    if (!existsSync(join(directory, '.file-space.db'))) return
    const space = this.bindings.open(expected)
    space.connect(owner, realpathSync(this.root), binding.token, true)
  }
  close(): void { this.bindings?.close() }
  record(reference: string) {
    const parsed = parseSpaceReference(reference)
    if (!parsed?.contentVersion || !this.bindings) return undefined
    const space = this.bindings.open(parsed.spaceId), file = space.byId(parsed.fileId)
    return file && versionFile(space.db, file, parsed.contentVersion)
  }
  finishImport(key: string): void {
    for (const row of this.bindings?.rows() ?? []) if (row.state === 'active') {
      try { this.bindings!.open(row.id).finishBatch(`${this.owner}:${key}`) } catch { /* 离线回执保留 */ }
    }
  }
  validateFile(data: Record<string, unknown>): void {
    const reference = fileReference(String(data.path)), directory = parseDirectoryReference(reference)
    if (directory) {
      const file = readDirectoryReference(this.root, this.owner, directory)
      if (file.hash !== data.hash || file.size !== data.size) throw new Error('[FILE_METADATA_MISMATCH] 原地文件登记已变化')
      return
    }
    const file = this.record(reference)
    if (!file || file.hash !== data.hash || file.size !== data.size || file.state !== 'available') {
      throw new Error('[FILE_METADATA_MISMATCH] 文件信息必须来自文件空间；请通过收录或文件编辑操作修改')
    }
    this.readable(reference)
  }
  /** cache 是库内派生路径；所有原件必须有空间身份与内容版本。 */
  resolve(reference: string): string {
    const ref = fileReference(reference)
    if (ref === 'cache' || ref.startsWith('cache/')) return this.resolveLocal(ref)
    const directory = parseDirectoryReference(ref)
    if (directory) return readDirectoryReference(this.root, this.owner, directory).path
    const parsed = parseSpaceReference(ref)
    if (!parsed?.contentVersion) throw legacyStorageError()
    if (this.bindings) return new SpaceVersions(this.bindings.open(parsed.spaceId)).read(parsed.fileId, parsed.contentVersion)
    return resolveSpaceFile(this.root, ref).path
  }
  private resolveLocal(reference: string): string {
    const rel = fileReference(reference), root = realpathSync(this.root)
    let current = this.root
    for (const part of rel.split('/')) {
      current = join(current, part)
      try { lstatSync(current) } catch (error) { if (missing(error)) break; throw error }
      if (!inside(root, realpathSync(current))) throw new Error('[FILE_OUTSIDE_STORAGE] 原文件路径不在仓库内（超出文件存储范围）')
    }
    return localFilePath(this.root, rel)
  }

  readable(reference: string): string {
    const path = this.resolve(reference)
    if (!statSync(path).isFile()) throw new Error('原文件不是普通文件')
    return path
  }

  status(reference: string): FileStatus {
    try {
      const value = statSync(this.resolve(reference))
      if (!value.isFile()) throw new Error('原文件不是普通文件')
      return { state: 'available', size: value.size }
    }
    catch (error) {
      return missing(error) ? { state: 'missing' } : { state: 'unavailable', reason: error instanceof Error ? error.message : String(error) }
    }
  }

  directory(reference: string): string {
    this.assertWritable(reference)
    const path = this.resolveLocal(reference)
    mkdirSync(path, { recursive: true })
    return path
  }

  cacheDir(name: string): string {
    const ref = fileReference(`cache/${name}`)
    this.directory(ref)
    return ref
  }

  resetCache(name: string): string {
    const ref = fileReference(`cache/${name}`)
    rmSync(this.resolve(ref), { recursive: true, force: true })
    return this.directory(ref)
  }

  /** 原子写缓存；此入口不能写原件或仓库数据库。 */
  write(reference: string, data: string | Buffer): void {
    this.assertWritable(reference)
    const target = this.resolveLocal(reference)
    mkdirSync(dirname(target), { recursive: true })
    const temporary = join(dirname(target), `.${randomUUID()}.part`)
    try { writeFileSync(temporary, data, { flag: 'wx' }); renameSync(temporary, target) }
    finally { rmSync(temporary, { force: true }) }
  }
  assertWritable(reference: string): void {
    const ref = fileReference(reference)
    if (ref !== 'cache' && !ref.startsWith('cache/')) throw new Error('[VERSION_PROTOCOL_REQUIRED] 原件只能通过版本协议修改；此接口仅允许缓存写入')
  }
  removeCache(reference: string): void {
    // 仓库清理只触及派生缓存，任何原件或空间引用都不由这里删除。
    if (fileReference(reference).startsWith('cache/')) unlinkSync(this.resolve(reference))
  }

  async copyOut(reference: string, destination: string): Promise<void> {
    await copyFile(this.readable(reference), destination, constants.COPYFILE_EXCL)
  }

  storageInfo(reference: string): FileStorageInfo {
    const directory = parseDirectoryReference(reference)
    if (directory) {
      const info: FileStorageInfo = { storageKind: 'directory', shared: false, state: 'unavailable', spaceId: directory.spaceId, fileId: directory.fileId, canRevise: false, canRecycle: false }
      try {
        return withDirectoryHead(this.root, this.owner, directory, f => {
          const hasUpdate = directory.hash !== f.hash
          return { ...info, spaceName: f.name, storageRoot: f.root, contentVersion: directory.hash,
            currentContentVersion: f.hash, currentOrdinal: f.revision, hasUpdate,
            ...(hasUpdate ? { reason: '原地文件已有新版，本库采用的旧内容当前不可读取。' } : { state: 'available' as const, path: f.path }) }
        })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'DIRECTORY_CHANGED') return { ...info, needsVerification: true, reason: '磁盘上的文件有变化，核对后可预览新版。' }
        if ((error as NodeJS.ErrnoException).code === 'DIRECTORY_NOT_LINKED') return { ...info, associationState: 'detached', reason: '本库未关联此原地目录，可在文件空间重新关联。' }
        return { ...info, state: missing(error) ? 'missing' : 'unavailable', reason: String(error) }
      }
    }
    const parsed = parseSpaceReference(reference)
    const info: FileStorageInfo = { storageKind: parsed ? 'space' : reference.replaceAll('\\', '/').startsWith('shared/') ? 'legacy-shared' : 'legacy-local', shared: false, state: 'unavailable',
      ...(parsed ? { spaceId: parsed.spaceId, fileId: parsed.fileId } : {}) }
    try {
      if (!parsed?.contentVersion) throw legacyStorageError()
      const binding = this.bindings?.binding(parsed.spaceId)
      if (binding) {
        Object.assign(info, { storageRoot: this.bindings!.path(binding), spaceName: basename(this.bindings!.path(binding)), spaceEmbedded: !!binding.embedded, associationState: binding.state })
        Object.assign(info, this.bindings!.permissions(binding.id))
        const space = this.bindings!.open(binding.id), details = space.info(), file = space.byId(parsed.fileId)
        Object.assign(info, { spaceName: details.name, mode: details.mode, shared: details.mode === 'shared', revision: file?.revision, lifecycle: file && ['recycled', 'disposing', 'disposed'].includes(file.state) ? file.state : 'active' })
        if (space.db.prepare('SELECT 1 FROM space_file_records WHERE file_id=? AND cleaned_at IS NOT NULL').get(parsed.fileId))
          throw new Error('[FILE_RECORD_CLEANED] 原件已移到系统废纸篓，版本明细已清理，不能沿原身份恢复')
        if (file) {
          const versions = new SpaceVersions(space), version = versions.version(file.id, parsed.contentVersion), current = versions.versions(file.id, 0, 1)[0]
          Object.assign(info, { contentVersion: version.id, currentContentVersion: current?.id, contentOrdinal: version.ordinal, currentOrdinal: current?.ordinal, hasUpdate: !!current && current.id !== version.id })
        }
      } else {
        const location = resolveSpaceFile(this.root, reference)
        info.path = location.path
        Object.assign(info, { storageRoot: location.root, spaceName: basename(location.root), mode: location.mode, shared: location.mode === 'shared', revision: location.file.revision })
      }
      info.path ??= this.readable(reference)
      return { ...info, state: 'available' }
    } catch (error) { return missing(error) ? { ...info, state: 'missing' } : { ...info, state: 'unavailable', reason: error instanceof Error ? error.message : String(error) } }
  }
  beginImport(key: string = randomUUID(), spaceId?: string): FileImport {
    if (!this.bindings) throw new Error('[SPACE_NOT_LINKED] 导入必须指定已关联文件空间')
    const binding = spaceId ? this.bindings.binding(spaceId) : this.bindings.default().binding
    return new FileImport(this.bindings.open(binding.id), `${this.owner}:${key}`)
  }
}

export interface StagedFile { reference: string; temporary: string; hash: string; reused?: boolean }
/** 文件先独立发布到空间；仓库收录失败保留字节和回执供重试。 */
export class FileImport {
  private readonly directory: string
  private ordinal = 0
  constructor(private space: FileSpace, private key: string) {
    this.directory = mkdtempSync(join(new LibraryFiles(space.root).directory('cache/ingest'), 'pending-'))
  }
  async input(index: number, name: string, bytes: Uint8Array): Promise<string> {
    const path = join(this.directory, 'input', String(index), basename(importedFileReference('input', name)))
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, bytes, { flag: 'wx' })
    return path
  }

  async stage(id: string, source: string, name: string, slot?: string, reuse = false): Promise<StagedFile> {
    const reference = importedFileReference(id, name)
    const temporary = join(this.directory, 'files', String(this.ordinal++))
    await mkdir(dirname(temporary), { recursive: true })
    await copyFile(source, temporary, constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL)
    const digest = createHash('sha256')
    for await (const chunk of createReadStream(temporary)) digest.update(chunk)
    const hash = digest.digest('hex'), size = statSync(temporary).size, safeName = basename(reference)
    {
      const versions = new SpaceVersions(this.space), space = this.space
      if (reuse) {
        const old = space.db.prepare("SELECT f.id,h.contentVersion FROM files f JOIN file_heads h ON h.fileId=f.id WHERE f.hash=? AND f.size=? AND f.state='available' LIMIT 1").get(hash, size) as { id: string; contentVersion: string } | undefined
        if (old && hashFile(versions.read(old.id, old.contentVersion)) === hash) return {
          reference: spaceReference(space.id, old.id, versions.version(old.id, old.contentVersion).name, old.contentVersion), temporary, hash, reused: true
        }
      }
      // 批次完成后释放批次令牌，成功回执永久保留；同一路径再次导入是新的保存意图。
      const batch = space.exclusive(() => {
        space.db.prepare('INSERT OR IGNORE INTO version_import_batches VALUES (?,?)').run(this.key, randomUUID())
        return space.db.prepare('SELECT token FROM version_import_batches WHERE key=?').pluck().get(this.key) as string
      })
      const request = createHash('sha256').update(JSON.stringify([batch, slot ?? String(this.ordinal)])).digest('hex')
      const prepared = await versions.stage({ spaceId: space.id, source: temporary, content: { hash, size, name: safeName }, requestId: `add-${request}` })
      const existing = space.db.prepare('SELECT result FROM version_receipts WHERE requestId=?').pluck().get(`publish-${request}`) as string | undefined
      const result = existing ? JSON.parse(existing) : await versions.commit({ spaceId: space.id, draftId: prepared.draft.id, previewToken: versions.preview(prepared.draft.id).previewToken, requestId: `publish-${request}` })
      return { reference: spaceReference(space.id, result.fileId, safeName, result.contentVersion), temporary, hash }
    }
  }
  dispose(): void { try { rmSync(this.directory, { recursive: true, force: true }) } catch { /* 仅临时副本 */ } }
}
