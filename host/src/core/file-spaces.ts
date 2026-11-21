import type { HistorySource } from '../shared/history'
// 仓库只接纳已关联空间的文件；模式、物理位置及成员关系由存储层管理。
import { spaceReferenceIds } from './space-items'
import { SpaceQueries } from './space-queries'
import { createHash } from 'node:crypto'
import { basename, extname } from 'node:path'
import type { Library } from './library'
import type { Store } from './store'
import type { History } from './history'
import type { Ingesting } from './ingest'
import { adoptSpaceSchema, type AdoptSpaceInput, type SpacePage, type SpacePageInput, type SpaceListInput } from '../shared/file-spaces'
import { parseDirectoryReference } from '../storage/directory-reference'
import { spaceReference } from '../storage/space-reference'
import { SpaceLifecycle } from '../storage/space-lifecycle'
import { SpaceHistory } from '../storage/space-history'
import type { SpaceHistoryInput, RestoreVersionInput } from '../shared/space-versions'
import type { SpaceMutationInput, SpaceMutationPreviewInput, SpaceReferences, SpaceUnlinkPreview, SpaceForgetPreview } from '../shared/file-spaces'
import { FILE_MIME } from '../shared/file-metadata'
import type { OperationResult } from '../plugin-api/operations'
import type { IngestInput } from '../shared/ingest-input'

export class LibrarySpaces {
  private operations = new Map<string, AbortController>()
  cancel(requestId: string) { this.operations.get(requestId)?.abort() }
  stop() { for (const controller of this.operations.values()) controller.abort() }
  private async transfer<T>(requestId: string, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.operations.has(requestId)) throw new Error('[EDIT_BUSY] 空间操作正在进行')
    const controller = new AbortController(); this.operations.set(requestId, controller)
    try { return await fn(controller.signal) } finally { this.operations.delete(requestId) }
  }
  private readonly queries: SpaceQueries
  constructor(private lib: Library, private store: Store, private history: History, private ingest: Ingesting, private scope = '') { this.queries = new SpaceQueries(lib) }
  list(input?: SpaceListInput) { return this.queries.list(input) }
  page(input: SpacePageInput): SpacePage { return this.queries.page(input) }
  referencedDirectorySpaces(): string[] {
    // 收录映射可能已过时；包括回收站和休眠业务块中仍然存在的真实引用。
    const spaces = new Set<string>()
    const rows = this.lib.db.prepare(`SELECT j.atom FROM main.block b, json_tree(b.data) j
      WHERE (instr(b.data,'directories') OR instr(b.data,'\\u'))
      AND j.type='text' AND substr(j.atom,1,11)='directories'`).iterate() as Iterable<{ atom: string }>
    for (const { atom } of rows) {
      try {
        const ref = parseDirectoryReference(atom)
        if (ref) spaces.add(ref.spaceId)
      } catch { /* 普通文本也可能以 directories 开头。 */ }
    }
    return [...spaces]
  }

  referenceIds(spaceId: string, fileIds?: string[]): string[] {
    return spaceReferenceIds(this.lib.db, spaceId, fileIds)
  }
  references(spaceId: string, fileIds?: string[]): SpaceReferences {
    const all = this.referenceIds(spaceId, fileIds), trashed = all.filter(id => this.store.isTrashed(id)).length
    return { scope: 'current-library', active: all.length - trashed, trashed, ids: all.slice(0, 100), truncated: all.length > 100 }
  }
  private actor(spaceId: string) { return `library:${this.lib.id}:${this.lib.files.bindings!.binding(spaceId).token}${this.scope}` }
  fileHistory(input: SpaceHistoryInput) { return new SpaceHistory(this.lib.files.bindings!.open(input.spaceId), this.actor(input.spaceId)).page(input) }
  restoreVersion(input: RestoreVersionInput) { return this.transfer(input.requestId, signal => new SpaceHistory(this.lib.files.bindings!.open(input.spaceId), this.actor(input.spaceId)).restore(input, signal)) }
  previewMutation(input: SpaceMutationPreviewInput) {
    const preview = new SpaceLifecycle(this.lib.files.bindings!.open(input.spaceId), this.actor(input.spaceId)).preview(input)
    return { ...preview, references: this.references(input.spaceId, input.files.map(f => f.id)) }
  }
  mutate(input: SpaceMutationInput) {
    const space = this.lib.files.bindings!.open(input.spaceId), service = new SpaceLifecycle(space, this.actor(input.spaceId))
    return this.transfer(input.requestId, async signal => service.execute(input, { signal }))
  }
  unlinkPreview(spaceId: string): SpaceUnlinkPreview {
    const row = this.lib.files.bindings!.binding(spaceId)
    const reason = row.embedded ? '随仓库空间暂不能解除' : row.is_default ? '请先选择其他默认写入空间' : row.state === 'detached' ? '已解除关联' : undefined
    return { spaceId, canUnlink: !reason, reason, references: this.references(spaceId) }
  }
  forgetPreview(spaceId: string): SpaceForgetPreview {
    const bindings = this.lib.files.bindings!, row = bindings.binding(spaceId), reason = bindings.forgetReason(spaceId)
    return { spaceId, name: basename(bindings.path(row)), canForget: !reason, reason, references: this.references(spaceId) }
  }

  adopt(input: AdoptSpaceInput, source: HistorySource = 'application'): OperationResult {
    const request = adoptSpaceSchema.parse(input)
    const signature = createHash('sha256').update(JSON.stringify(['adopt_space_files', request.spaceId, request.files])).digest('hex')
    const old = this.lib.db.prepare('SELECT signature,result FROM main.operation_receipt WHERE request_id=?').get(request.requestId) as { signature: string; result: string } | undefined
    if (old) {
      if (old.signature !== signature) throw new Error('[REQUEST_ID_CONFLICT] 同一 requestId 不能用于不同操作')
      return { requestId: request.requestId, replayed: true, result: JSON.parse(old.result) }
    }
    if (this.lib.db.prepare('SELECT 1 FROM main.ingest_pending WHERE key=?').get(`mcp:${request.requestId}`)) throw new Error('[REQUEST_ID_CONFLICT] 该请求 ID 已用于文件导入')
    const space = this.lib.files.bindings!.open(request.spaceId)
    return space.exclusive(() => this.store.batch(() => {
      const entries = request.files.flatMap(choice => {
        const file = space.byId(choice.id)
        if (!file || file.state !== 'available' || file.revision !== choice.revision) throw new Error('[SPACE_CHANGED] 候选文件已变化或不可用，请刷新后重新选择')
        const name = basename(file.path), ext = extname(name).slice(1).toLowerCase(), path = spaceReference(space.id, file.id, name, space.db.prepare('SELECT contentVersion FROM file_heads WHERE fileId=?').pluck().get(file.id) as string)
        const absolute = this.lib.files.readable(path)
        const deferred = this.lib.db.prepare('SELECT data FROM main.space_import_inputs WHERE space_id=? AND file_id=?').pluck().get(space.id, file.id) as string | undefined
        const originals: IngestInput[] = deferred ? JSON.parse(deferred) : []
        if (!originals.length || choice.metadata) originals.push({ type: 'file', path: absolute, metadata: choice.metadata })
        return originals.map(original => ({ spaceId: space.id, fileId: file.id, file: { name, ext, mime: FILE_MIME[ext] ?? 'application/octet-stream', path, hash: file.hash, size: file.size }, input: { ...original, type: 'file' as const, path: absolute } }))
      })
      {
        const result = this.ingest.adoptRegistered(entries, apply => this.history.run('收录空间文件', apply, { source, operation: 'adopt_space_files', requestId: request.requestId }))
        for (const file of request.files) this.lib.db.prepare('DELETE FROM main.space_import_inputs WHERE space_id=? AND file_id=?').run(space.id, file.id)
        this.lib.db.prepare('INSERT INTO main.operation_receipt VALUES (?,?,?,?)').run(request.requestId, signature, JSON.stringify(result), Date.now())
        return { requestId: request.requestId, replayed: false, result }
      }
    }))
  }
}
