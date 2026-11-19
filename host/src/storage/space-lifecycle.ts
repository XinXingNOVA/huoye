// 空间的独立生命周期：只处理文件目录，不读取仓库业务数据，不依赖窗口或 MCP。
import { createHash } from 'node:crypto'
import { spaceReference } from './space-reference'
import { basename } from 'node:path'
import { FileSpace, type SpaceFile } from './file-space'
import { SpaceVersions } from './space-versions'
import { spacePageSchema, type SpaceMutationInput, type SpaceMutationPreview,
  type SpaceMutationPreviewInput, type SpaceMutationResult, type SpacePage, type SpacePageInput } from '../shared/file-spaces'

export interface SpaceFileSelection { ids: string[]; exclude?: boolean }
const hidden = 'id IN (SELECT file_id FROM space_file_records WHERE archived_at IS NOT NULL)'
function scopeWhere(scope: 'active' | 'recycled' | 'records', recordScope = 'current') {
  const recordFilter = recordScope === 'all' ? '' : recordScope === 'archived' ? ' AND (' + hidden + ')' : ' AND NOT (' + hidden + ')'
  return scope === 'records' ? "(state IN ('disposing','disposed') OR " + hidden + ')' + recordFilter
    : (scope === 'recycled' ? "state='recycled'" : "state NOT IN ('recycled','disposing','disposed')") + ' AND NOT (' + hidden + ')'
}
const selectionWhere = (selection?: SpaceFileSelection) => selection ? ` AND id ${selection.exclude ? 'NOT ' : ''}IN (SELECT value FROM json_each(@ids))` : ''
const message = (e: unknown) => e instanceof Error ? e.message : String(e)
export class SpaceLifecycle {
  constructor(private space: FileSpace, private actor = 'application') {}
  private target(id: string) { if (id !== this.space.id) throw new Error('[FILE_SPACE_IDENTITY] 所选位置不是目标空间') }
  count(scope: 'active' | 'recycled' | 'records', selection?: SpaceFileSelection, recordScope = 'current'): number {
    return Number(this.space.db.prepare(`SELECT count(*) FROM files WHERE ${scopeWhere(scope, recordScope)}${selectionWhere(selection)}`).pluck().get(selection ? { ids: JSON.stringify(selection.ids) } : {}))
  }
  counts() { return { active: this.count('active'), recycled: this.count('recycled'), records: this.count('records'), archived: this.count('records', undefined, 'archived') } }
  page(input: SpacePageInput, selection?: SpaceFileSelection, context = ''): SpacePage {
    return this.space.db.transaction(() => this.readPage(input, selection, context))()
  }
  private readPage(input: SpacePageInput, selection: SpaceFileSelection | undefined, context: string): SpacePage {
    const request = spacePageSchema.parse(input); this.target(request.spaceId)
    if (request.collectFilter && request.collectFilter !== 'all') throw new Error('[LIBRARY_CONTEXT_REQUIRED] 收录筛选需要仓库上下文')
    const version = this.space.info().revision
    if (request.version !== undefined && request.version !== version) throw new Error('[SPACE_CHANGED] 空间已变化，请从首页刷新')
    const snapshot = createHash('sha256').update(JSON.stringify([this.space.id, version, request.scope, request.recordScope, request.search ?? '', context])).digest('hex')
    if (request.snapshot && request.snapshot !== snapshot) throw new Error('[SPACE_CHANGED] 列表或仓库状态已变化，请从首页刷新')
    this.space.db.function('space_search_name', { deterministic: true }, value => basename(String(value)).toLowerCase())
    const where = scopeWhere(request.scope, request.recordScope) + selectionWhere(selection) + (request.search ? ' AND instr(space_search_name(path),@search)>0' : '')
    const params = { ...(selection ? { ids: JSON.stringify(selection.ids) } : {}), ...(request.search ? { search: request.search.toLowerCase() } : {}) }
    const rows = this.space.db.prepare(`SELECT * FROM files WHERE ${where} ORDER BY id LIMIT @limit OFFSET @offset`).all({ ...params, limit: request.limit, offset: request.offset }) as SpaceFile[]
    const total = Number(this.space.db.prepare(`SELECT count(*) FROM files WHERE ${where}`).pluck().get(params))
    let versions: SpaceVersions | undefined
    return { total, version, snapshot, ...(request.includeCounts ? { counts: this.counts() } : {}), ...(request.offset + rows.length < total ? { nextOffset: request.offset + rows.length } : {}), items: rows.map(file => {
      let error: string | undefined, reference: string | undefined
      const contentVersion = this.space.db.prepare('SELECT contentVersion FROM file_heads WHERE fileId=?').pluck().get(file.id) as string | undefined
      if (file.state === 'available') { try { (versions ??= new SpaceVersions(this.space)).read(file.id, contentVersion!); reference = spaceReference(this.space.id, file.id, basename(file.path), contentVersion!) } catch (e) { error = message(e) } }
      else error = file.state === 'recycled' ? '原件已回收' : file.state === 'disposing' ? '原件处置未完成，请到记录管理检查或继续' : file.state === 'disposed' ? '原件已移到系统废纸篓' : '文件未发布或缺失'
      const at = this.space.db.prepare('SELECT recycled_at FROM recycled_files WHERE file_id=?').pluck().get(file.id) as number | undefined
      const record = this.space.db.prepare('SELECT r.archived_at,r.cleaned_at,d.error FROM space_file_records r LEFT JOIN space_disposals d ON d.id=r.disposal_id WHERE r.file_id=?').get(file.id) as { archived_at: number | null; cleaned_at: number | null; error: string | null } | undefined
      return { reference, contentVersion, id: file.id, name: basename(file.path), size: file.size, hash: file.hash, revision: file.revision,
        lifecycle: file.state === 'recycled' || file.state === 'disposing' || file.state === 'disposed' ? file.state : 'active', ...(file.state === 'recycled' ? { recycledAt: at } : {}),
        archivedAt: record?.archived_at ?? undefined, cleanedAt: record?.cleaned_at ?? undefined, disposalError: record?.error ?? undefined,
        state: error || file.state !== 'available' ? 'unavailable' : 'available', error }
    }) }
  }
  preview(input: SpaceMutationPreviewInput): SpaceMutationPreview { return new SpaceVersions(this.space, this.actor).previewLifecycle(input) }
  execute(input: SpaceMutationInput, transfer: { signal?: AbortSignal } = {}): Promise<SpaceMutationResult> { return new SpaceVersions(this.space, this.actor).mutateLifecycle(input, transfer) }
}
