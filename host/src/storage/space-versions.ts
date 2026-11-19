import { assertFileAvailable, checkedVersionPath, versionPath } from './version-read'
// 文件空间的不可变内容与条件发布。不依赖仓库事务、插件或 MCP。
// 旧格式须单独迁移；新格式关联须登记明确版本读取能力。
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, existsSync, realpathSync, statSync } from 'node:fs'
import { mkdir, open, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { FileSpace, type SpaceFile } from './file-space'
import { assertSpaceFormat } from './storage-format'
import { portableFileName } from '../shared/paths'
import { commitVersionSchema, stageVersionSchema, versionRequestId, type ContentVersion, type VersionDraft,
  type StageVersionInput, type CommitVersionInput, type VersionCommit, type SpaceVersionReadiness } from '../shared/space-versions'
import { spaceMutationPreviewSchema, spaceMutationSchema, type SpaceMode, type SpaceMutationPreviewInput, type SpaceMutationPreview,
  type SpaceMutationInput, type SpaceMutationResult } from '../shared/file-spaces'

type DraftRow = VersionDraft & { actor: string; requestId: string; signature: string; path: string; sourceSize: number; sourceMtime: number; pid: number }
type VersionRow = ContentVersion & { path: string; mtime: number }
type Transfer = { signal?: AbortSignal; progress?: (copied: number, total: number) => void }
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const errorText = (e: unknown) => e instanceof Error ? e.message : String(e)
function alive(pid: number) { try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code !== 'ESRCH' } }
function publicDraft(d: DraftRow): VersionDraft {
  return { id: d.id, fileId: d.fileId, baseRevision: d.baseRevision, contentVersion: d.contentVersion, name: d.name, state: d.state, hash: d.hash, size: d.size, error: d.error }
}
async function hashFile(path: string, signal?: AbortSignal, progress?: (copied: number) => void) {
  const hash = createHash('sha256'); let copied = 0
  for await (const chunk of createReadStream(path, { signal })) { hash.update(chunk); copied += chunk.length; progress?.(copied) }
  return hash.digest('hex')
}
async function syncDirectory(path: string) {
  if (process.platform === 'win32') return // Windows 不支持通过普通目录句柄 fsync；必须实机验证恢复行为。
  const handle = await open(path, 'r'); try { await handle.sync() } finally { await handle.close() }
}

export function inspectVersionReadiness(space: FileSpace): SpaceVersionReadiness {
  const blockers: string[] = []
  try { space.assertIdle(); new SpaceVersions(space) } catch (e) { blockers.push(errorText(e)) }
  return { spaceId: space.id, storage: 'versioned', files: Number(space.db.prepare('SELECT count(*) FROM files').pluck().get()), members: space.info().members,
    readyForWarehouseWrites: !blockers.length, blockers, references: 'not-audited',
    versionBytes: Number(space.db.prepare('SELECT coalesce(sum(size),0) FROM file_versions').pluck().get()) }
}

export class SpaceVersions {
  constructor(readonly space: FileSpace, private readonly actor = 'application') {
    this.assertCompatible()
  }
  /** 仅创建新空间，绝不对现有目录执行自动升级。UI 创建采用本入口；不改变已有空间。 */
  static create(root: string, mode: SpaceMode): SpaceVersions {
    FileSpace.create(root, mode)
    const space = new FileSpace(realpathSync(root))
    try {
      return new SpaceVersions(space)
    } catch (e) { space.close(); throw e }
  }
  private assertCompatible() {
    if (this.space.db.prepare("SELECT 1 FROM members m LEFT JOIN version_members v ON m.library_id=v.library_id AND m.token=v.token WHERE v.library_id IS NULL LIMIT 1").get())
      throw new Error('[VERSION_MIGRATION_REQUIRED] 存在未确认版本读取能力的仓库')
    if (existsSync(join(this.space.root, 'library.db')) || existsSync(join(this.space.root, '.file-storage.json')))
      throw new Error('[VERSION_MIGRATION_REQUIRED] 已关联或兼容空间尚不能进入版本写入')
  }
  private assertRevise(baseRevision: number | null) {
    if (baseRevision === null) return
    this.assertPermission('revise')
  }
  assertPermission(permission: 'revise' | 'recycle') {
    this.assertCompatible()
    if (this.actor === 'application') return
    const [, libraryId, token] = this.actor.split(':')
    const allowed = this.space.db.prepare(`SELECT v.${permission} FROM version_members v JOIN members m ON m.library_id=v.library_id AND m.token=v.token WHERE v.library_id=? AND v.token=?`).pluck().get(libraryId, token)
    if (!allowed) throw new Error(`[SPACE_${permission.toUpperCase()}_DENIED] 尚未授权此仓库${permission === 'revise' ? '发布原件新版' : '回收或恢复原件'}，请到空间设置中显式授权`)
  }
  private target(id: string) { if (id !== this.space.id) throw new Error('[FILE_SPACE_IDENTITY] 所选位置不是目标空间') }
  private path(ref: string) { return versionPath(this.space.root, ref) }
  private draft(id: string): DraftRow {
    const row = this.space.db.prepare('SELECT * FROM version_drafts WHERE id=?').get(id) as DraftRow | undefined
    if (!row) throw new Error('[NOT_FOUND] 编辑草稿不存在')
    if (row.actor !== this.actor) throw new Error('[EDIT_SCOPE] 草稿属于其他调用方')
    return row
  }
  getDraft(id: string): VersionDraft { return publicDraft(this.draft(id)) }
  private receipt<T>(requestId: string, signature: string): T | undefined {
    if (this.space.db.prepare('SELECT 1 FROM history_restorations WHERE requestId=?').get(requestId)) throw new Error('[REQUEST_ID_CONFLICT] 请求 ID 已用于历史恢复')
    const row = this.space.db.prepare('SELECT * FROM version_receipts WHERE requestId=?').get(requestId) as { signature: string; result: string } | undefined
    if (!row) return undefined
    if (row.signature !== signature) throw new Error('[REQUEST_ID_CONFLICT] 请求 ID 已用于其他版本操作')
    return { ...JSON.parse(row.result), replayed: true }
  }
  private saveReceipt(requestId: string, signature: string, result: unknown) {
    this.space.db.prepare('INSERT INTO version_receipts VALUES (?,?,?)').run(requestId, signature, JSON.stringify(result))
  }
  private checkBase(fileId: string, base: number | null) {
    if (this.space.db.prepare('SELECT 1 FROM space_file_records WHERE file_id=? AND busy_request IS NOT NULL').get(fileId))
      throw new Error('[DISPOSAL_BUSY] 文件正在处置，请先完成该任务')
    const file = this.space.byId(fileId)
    if (base === null ? !!file : !file || file.revision !== base || file.state !== 'available')
      throw new Error('[VERSION_CONFLICT] 文件已变化或不可用；编辑草稿已保留，请重新处理或另存')
  }
  async stage(input: StageVersionInput, transfer: Transfer = {}): Promise<{ draft: VersionDraft; replayed: boolean }> {
    const request = stageVersionSchema.parse(input); this.target(request.spaceId)
    if (!isAbsolute(request.source)) throw new Error('来源必须是明确选择的绝对文件路径')
    this.assertRevise(request.target?.revision ?? null)
    const signature = digest(['stage', this.actor, request.content ? { ...request, source: undefined } : request]), db = this.space.db
    const prior = this.receipt<{ draft: VersionDraft; replayed: boolean }>(request.requestId, signature)
    if (prior) return prior
    const initial = await stat(request.source)
    if (!initial.isFile()) throw new Error('请选择普通文件')
    if (request.content && initial.size !== request.content.size) throw new Error('[FILE_CHANGED] 来源大小已变化')
    let draft = this.space.exclusive(() => {
      this.assertCompatible()
      this.receipt(request.requestId, signature) // 并发准备完成或跨操作复用请求 ID 时再次核对。
      const old = db.prepare('SELECT * FROM version_drafts WHERE requestId=?').get(request.requestId) as DraftRow | undefined
      if (old) {
        if (old.signature !== signature) throw new Error('[REQUEST_ID_CONFLICT] 请求 ID 已用于其他编辑')
        if (old.state === 'ready' || old.state === 'committed') return old
        if (old.state === 'copying' && alive(old.pid)) throw new Error('[EDIT_BUSY] 草稿正在准备，请稍后查询')
        if (old.state === 'discarded') throw new Error('[EDIT_DISCARDED] 草稿已放弃，请用新请求')
        if (!request.content && (old.sourceSize !== initial.size || old.sourceMtime !== initial.mtimeMs)) throw new Error('[FILE_CHANGED] 来源已变化，请使用新请求')
        db.prepare("UPDATE version_drafts SET state='copying',pid=?,error=NULL WHERE id=?").run(process.pid, old.id)
        return this.draft(old.id)
      }
      const fileId = request.target?.fileId ?? randomUUID(), baseRevision = request.target?.revision ?? null
      this.checkBase(fileId, baseRevision)
      const id = randomUUID(), contentVersion = randomUUID(), name = portableFileName(basename(request.target ? this.space.byId(fileId)!.path : request.content?.name ?? request.source)) || 'file'
      if (Buffer.byteLength(name) > 255) throw new Error('文件名过长')
      const value: DraftRow = { id, fileId, baseRevision, contentVersion, name, state: 'copying', hash: null, size: null, error: null,
        actor: this.actor, requestId: request.requestId, signature, path: `files/.versions/${fileId}/${contentVersion}/${name}`, sourceSize: initial.size, sourceMtime: initial.mtimeMs, pid: process.pid }
      db.prepare(`INSERT INTO version_drafts VALUES (@id,@fileId,@baseRevision,@contentVersion,@name,@state,@hash,@size,@error,
        @requestId,@signature,@path,@sourceSize,@sourceMtime,@pid,@actor)`).run(value)
      return value
    })
    if (draft.state === 'ready' || draft.state === 'committed') return this.receipt<{ draft: VersionDraft; replayed: boolean }>(request.requestId, signature)!
    try {
      const path = this.path(draft.path), temporary = join(dirname(path), '.draft-partial')
      transfer.signal?.throwIfAborted()
      await mkdir(dirname(path), { recursive: true }); this.path(draft.path)
      await rm(temporary, { force: true })
      const handle = await open(temporary, 'wx', 0o600), hash = createHash('sha256'); let copied = 0
      try {
        for await (const bytes of createReadStream(request.source, { signal: transfer.signal })) {
          const chunk = bytes as Buffer; let offset = 0
          while (offset < chunk.length) { const result = await handle.write(chunk, offset, chunk.length - offset); offset += result.bytesWritten }
          copied += chunk.length; hash.update(chunk); transfer.progress?.(copied, initial.size)
        }
        await handle.sync()
      } finally { await handle.close() }
      transfer.signal?.throwIfAborted()
      const end = await stat(request.source)
      if (end.size !== initial.size || end.mtimeMs !== initial.mtimeMs || end.ino !== initial.ino || copied !== initial.size) throw new Error('[FILE_CHANGED] 复制期间来源已变化')
      const contentHash = hash.digest('hex')
      if (request.content && contentHash !== request.content.hash) throw new Error('[FILE_CHANGED] 来源内容已变化')
      // 中断遗留的目标仍只属于这份未发布草稿；不会覆盖任何已登记版本。
      await rename(temporary, path)
      for (let parent = dirname(path); ; parent = dirname(parent)) {
        await syncDirectory(parent)
        if (parent === realpathSync(this.space.root)) break
      }
      return this.space.exclusive(() => {
        this.assertCompatible()
        const current = this.draft(draft.id)
        if (current.state !== 'copying' || current.pid !== process.pid) throw new Error('[EDIT_CHANGED] 草稿状态已变化')
        db.prepare("UPDATE version_drafts SET state='ready',hash=?,size=?,pid=0 WHERE id=?").run(contentHash, copied, draft.id)
        draft = this.draft(draft.id)
        const result = { draft: publicDraft(draft), replayed: false }
        this.saveReceipt(request.requestId, signature, result)
        return result
      })
    } catch (e) {
      db.prepare("UPDATE version_drafts SET state='failed',error=?,pid=0 WHERE id=? AND state='copying' AND pid=?").run(errorText(e), draft.id, process.pid)
      throw e
    }
  }
  preview(draftId: string) {
    this.assertCompatible()
    const draft = this.draft(draftId)
    this.assertRevise(draft.baseRevision)
    if (draft.state !== 'ready') throw new Error('[EDIT_NOT_READY] 草稿尚未就绪或已结束')
    this.checkBase(draft.fileId, draft.baseRevision)
    const file = this.space.byId(draft.fileId)
    return { draft: publicDraft(draft), previewToken: digest([this.space.id, draft.id, draft.fileId, draft.baseRevision, draft.contentVersion, draft.hash, draft.size, file ?? null, this.space.info().mode]) }
  }
  commitReceipt(input: CommitVersionInput): VersionCommit | undefined {
    const request = commitVersionSchema.parse(input); this.target(request.spaceId)
    return this.receipt<VersionCommit>(request.requestId, digest(['commit', this.actor, request]))
  }
  async commit(input: CommitVersionInput, transfer: Transfer = {}): Promise<VersionCommit> {
    const request = commitVersionSchema.parse(input); this.target(request.spaceId)
    const signature = digest(['commit', this.actor, request])
    const prior = this.receipt<VersionCommit>(request.requestId, signature)
    if (prior) return prior
    if (this.space.db.prepare('SELECT 1 FROM version_drafts WHERE requestId=?').get(request.requestId)) throw new Error('[REQUEST_ID_CONFLICT] 请求 ID 已用于准备草稿')
    if (this.preview(request.draftId).previewToken !== request.previewToken) throw new Error('[PREVIEW_CHANGED] 草稿或文件状态已变化，请重新预览')
    const draft = this.draft(request.draftId), path = this.path(draft.path), before = statSync(path)
    if (!before.isFile() || before.size !== draft.size || await hashFile(path, transfer.signal, copied => transfer.progress?.(copied, before.size)) !== draft.hash) throw new Error('[FILE_CHANGED] 草稿内容校验失败，未发布')
    transfer.signal?.throwIfAborted()
    return this.space.exclusive(() => {
      const replay = this.receipt<VersionCommit>(request.requestId, signature)
      if (replay) return replay
      if (this.preview(request.draftId).previewToken !== request.previewToken) throw new Error('[PREVIEW_CHANGED] 草稿或文件状态已变化')
      const now = statSync(this.path(draft.path))
      if (now.size !== before.size || now.mtimeMs !== before.mtimeMs || now.ino !== before.ino) throw new Error('[FILE_CHANGED] 草稿在校验期间变化')
      const db = this.space.db, revision = (draft.baseRevision ?? 0) + 1, createdAt = Date.now()
      const ordinal = Number(db.prepare('SELECT coalesce(max(ordinal),0)+1 FROM file_versions WHERE fileId=?').pluck().get(draft.fileId))
      db.prepare('INSERT INTO file_versions VALUES (?,?,?,?,?,?,?,?,?)').run(draft.contentVersion, draft.fileId, draft.name, draft.hash, draft.size, createdAt, ordinal, draft.path, now.mtimeMs)
      db.prepare(`INSERT INTO files VALUES (?,?,?,?,?,?,'available') ON CONFLICT(id) DO UPDATE SET path=excluded.path,
        hash=excluded.hash,size=excluded.size,mtime=excluded.mtime,revision=excluded.revision,state='available'`).run(draft.fileId, draft.path, draft.hash, draft.size, now.mtimeMs, revision)
      db.prepare('INSERT INTO file_heads VALUES (?,?) ON CONFLICT(fileId) DO UPDATE SET contentVersion=excluded.contentVersion').run(draft.fileId, draft.contentVersion)
      const change = db.prepare('INSERT INTO space_changes(fileId,contentVersion,revision,type,createdAt) VALUES (?,?,?,?,?)')
        .run(draft.fileId, draft.contentVersion, revision, draft.baseRevision === null ? 'added' : 'contentPublished', createdAt)
      db.prepare("UPDATE version_drafts SET state='committed' WHERE id=?").run(draft.id)
      this.space.bump()
      const result: VersionCommit = { requestId: request.requestId, replayed: false, spaceId: this.space.id, fileId: draft.fileId, contentVersion: draft.contentVersion, revision, changeSeq: Number(change.lastInsertRowid) }
      this.saveReceipt(request.requestId, signature, result)
      return result
    })
  }
  version(fileId: string, id: string): ContentVersion {
    const row = this.space.db.prepare('SELECT id,fileId,name,hash,size,createdAt,ordinal FROM file_versions WHERE fileId=? AND id=?').get(fileId, id) as ContentVersion | undefined
    if (!row) throw new Error('[NOT_FOUND] 内容版本不存在')
    return row
  }
  versions(fileId: string, offset = 0, limit = 50): ContentVersion[] {
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('分页无效')
    return this.space.db.prepare('SELECT id,fileId,name,hash,size,createdAt,ordinal FROM file_versions WHERE fileId=? ORDER BY ordinal DESC LIMIT ? OFFSET ?').all(fileId, limit, offset) as ContentVersion[]
  }
  read(fileId: string, contentVersion: string): string {
    this.assertCompatible()
    const file: SpaceFile | undefined = this.space.byId(fileId)
    assertFileAvailable(file)
    return this.checkedVersionPath(fileId, contentVersion)
  }
  private checkedVersionPath(fileId: string, contentVersion: string): string {
    return checkedVersionPath(this.space.db, this.space.root, fileId, contentVersion)
  }
  previewLifecycle(input: SpaceMutationPreviewInput): SpaceMutationPreview {
    const request = spaceMutationPreviewSchema.parse(input); this.target(request.spaceId)
    const space = this.space.info()
    let blocked: string | undefined
    try { this.assertPermission('recycle') } catch (e) { blocked = errorText(e) }
    return { space, action: request.action, version: space.revision, blocked,
      references: { scope: 'unchecked', active: 0, trashed: 0, ids: [], truncated: false },
      files: request.files.map(choice => {
        const file = this.space.byId(choice.id)
        let reason = blocked
        if (this.space.db.prepare('SELECT 1 FROM space_file_records WHERE file_id=? AND busy_request IS NOT NULL').get(choice.id)) reason = '文件有未完成的处置，请先完成该任务'
        if (!file) reason = '文件身份不存在'
        else if (file.revision !== choice.revision) reason = '文件已变化，请重新预览'
        else if (!['available', 'recycled'].includes(file.state)) reason = '文件未就绪'
        else if (request.action === 'recycle' && file.state === 'available') {
          try { this.checkedVersionPath(file.id, this.head(file.id)) } catch (e) { reason = errorText(e) }
        }
        return { id: choice.id, name: file ? basename(file.path) : choice.id, revision: file?.revision ?? choice.revision, eligible: !reason, reason }
      }) }
  }
  head(fileId: string): string {
    const head = this.space.db.prepare('SELECT contentVersion FROM file_heads WHERE fileId=?').pluck().get(fileId) as string | undefined
    if (!head) throw new Error('[NOT_FOUND] 文件身份不存在')
    return head
  }
  async mutateLifecycle(input: SpaceMutationInput, transfer: Transfer = {}): Promise<SpaceMutationResult> {
    const request = spaceMutationSchema.parse(input); this.target(request.spaceId); this.assertPermission('recycle')
    const signature = digest(['lifecycle', this.actor, request])
    const prior = this.receipt<SpaceMutationResult>(request.requestId, signature)
    if (prior) return prior
    if (this.space.db.prepare('SELECT 1 FROM version_drafts WHERE requestId=?').get(request.requestId)) throw new Error('[REQUEST_ID_CONFLICT] 请求 ID 已用于编辑草稿')
    const validate = () => {
      const preview = this.previewLifecycle({ spaceId: request.spaceId, action: request.action, files: request.files })
      if (preview.version !== request.version) throw new Error('[SPACE_CHANGED] 空间已变化，请重新预览')
      if (preview.blocked || preview.files.some(f => !f.eligible)) throw new Error(preview.blocked ?? preview.files.find(f => !f.eligible)!.reason)
    }
    validate()
    // 恢复会重新开放所有已接纳版本。异步校验全部历史字节，之后短事务再次核对状态。
    const checked: { fileId: string; versionId: string; size: number; mtimeMs: number; ino: number }[] = []
    if (request.action === 'restore') for (const choice of request.files) {
      if (this.space.byId(choice.id)!.state !== 'recycled') continue
      for (let offset = 0; ; offset += 100) {
        const rows = this.versions(choice.id, offset, 100)
        for (const version of rows) {
          const path = this.checkedVersionPath(choice.id, version.id), before = statSync(path)
          if (await hashFile(path, transfer.signal) !== version.hash) throw new Error('[FILE_CHANGED] 历史内容校验失败，整批原件未恢复，请核对备份')
          checked.push({ fileId: choice.id, versionId: version.id, size: before.size, mtimeMs: before.mtimeMs, ino: before.ino })
        }
        if (rows.length < 100) break
      }
    }
    transfer.signal?.throwIfAborted()
    return this.space.exclusive(() => {
      this.assertPermission('recycle')
      const replay = this.receipt<SpaceMutationResult>(request.requestId, signature)
      if (replay) return replay
      if (this.space.db.prepare('SELECT 1 FROM version_drafts WHERE requestId=?').get(request.requestId)) throw new Error('[REQUEST_ID_CONFLICT] 请求 ID 已用于编辑草稿')
      validate()
      for (const old of checked) {
        const now = statSync(this.checkedVersionPath(old.fileId, old.versionId))
        if (now.size !== old.size || now.mtimeMs !== old.mtimeMs || now.ino !== old.ino) throw new Error('[FILE_CHANGED] 校验期间历史内容变化')
      }
      const items = request.files.map(choice => {
        const file = this.space.byId(choice.id)!, state = request.action === 'recycle' ? 'recycled' : 'available'
        if (file.state === state) return { id: file.id, revision: file.revision, outcome: 'unchanged' as const }
        this.space.db.prepare('UPDATE files SET state=?,revision=revision+1 WHERE id=?').run(state, file.id)
        if (state === 'recycled') this.space.db.prepare('INSERT INTO recycled_files VALUES (?,?) ON CONFLICT(file_id) DO UPDATE SET recycled_at=excluded.recycled_at').run(file.id, Date.now())
        this.space.db.prepare('INSERT INTO space_changes(fileId,contentVersion,revision,type,createdAt) VALUES (?,?,?,?,?)')
          .run(file.id, this.head(file.id), file.revision + 1, state === 'recycled' ? 'recycled' : 'restored', Date.now())
        this.space.bump()
        return { id: file.id, revision: file.revision + 1, outcome: 'changed' as const }
      })
      const result: SpaceMutationResult = { requestId: request.requestId, replayed: false, spaceId: request.spaceId, action: request.action, items }
      this.saveReceipt(request.requestId, signature, result); return result
    })
  }
  changes(afterSeq = 0, limit = 100) {
    if (!Number.isInteger(afterSeq) || afterSeq < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('变化分页无效')
    return this.space.db.prepare('SELECT * FROM space_changes WHERE seq>? ORDER BY seq LIMIT ?').all(afterSeq, limit) as { seq: number; fileId: string; contentVersion: string; revision: number; type: string; createdAt: number }[]
  }
  discard(draftId: string, requestId: string) {
    versionRequestId.parse(requestId)
    const signature = digest(['discard', this.actor, draftId])
    return this.space.exclusive(() => {
      const prior = this.receipt<{ replayed: boolean; draftId: string }>(requestId, signature)
      if (prior) return prior
      if (this.space.db.prepare('SELECT 1 FROM version_drafts WHERE requestId=?').get(requestId)) throw new Error('[REQUEST_ID_CONFLICT] 请求 ID 已用于草稿')
      const draft = this.draft(draftId)
      if (draft.state === 'committed' || (draft.state === 'copying' && alive(draft.pid))) throw new Error('[EDIT_BUSY] 不能放弃已发布或正在复制的草稿')
      this.space.db.prepare("UPDATE version_drafts SET state='discarded',pid=0 WHERE id=?").run(draftId)
      const result = { replayed: false, draftId }; this.saveReceipt(requestId, signature, result); return result
    })
  }
}

/** 解析明确内容版本。状态取当前文件，内容快照取不可变版本。 */
export function versionFile(db: import('better-sqlite3').Database, file: SpaceFile, contentVersion?: string): SpaceFile {
  const format = Number(db.prepare('SELECT version FROM space').pluck().get())
  assertSpaceFormat(format)
  if (!contentVersion) throw new Error('[VERSION_REFERENCE_REQUIRED] 版本空间必须使用明确内容版本引用')
  const version = db.prepare('SELECT * FROM file_versions WHERE fileId=? AND id=?').get(file.id, contentVersion) as VersionRow | undefined
  if (!version) throw new Error('[NOT_FOUND] 文件内容版本不存在')
  return { ...file, path: version.path, hash: version.hash, size: version.size, mtime: version.mtime }
}

/** 仅由应用空间管理调用；仓库配置和 MCP organize 不能自行提高此权限。 */
export function versionPermissions(space: FileSpace) {
  new SpaceVersions(space)
  const members = space.db.prepare('SELECT m.library_id AS id,m.root,v.revise,v.recycle FROM members m JOIN version_members v ON m.library_id=v.library_id AND m.token=v.token').all() as { id: string; root: string; revise: number; recycle: number }[]
  return { revision: space.info().revision, members: members.map(m => ({ id: m.id, name: basename(m.root), revise: !!m.revise, recycle: !!m.recycle })) }
}
export function setVersionPermission(space: FileSpace, libraryId: string, permission: 'revise' | 'recycle', enabled: boolean, revision: number) {
  if (!['revise', 'recycle'].includes(permission)) throw new Error('无效的空间权限')
  if (typeof libraryId !== 'string' || typeof enabled !== 'boolean' || !Number.isInteger(revision)) throw new Error('授权参数无效')
  return space.exclusive(() => {
    const current = versionPermissions(space)
    if (current.revision !== revision) throw new Error('[SPACE_CHANGED] 空间已变化，请刷新后确认授权')
    if (!current.members.some(m => m.id === libraryId)) throw new Error('[SPACE_NOT_LINKED] 未关联此仓库')
    space.db.prepare(`UPDATE version_members SET ${permission}=? WHERE library_id=?`).run(enabled ? 1 : 0, libraryId); space.bump()
    return versionPermissions(space)
  })
}
