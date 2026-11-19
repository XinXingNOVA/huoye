// 仓库关系投影：不让独立文件空间理解素材、回收站或接纳规则。
import { randomUUID } from 'node:crypto'
import type { Library } from './library'
import { spaceListSchema, spacePageSchema, type SpaceListInput, type SpacePageInput, type SpaceBindingInfo } from '../shared/file-spaces'
import { SpaceLifecycle, type SpaceFileSelection } from '../storage/space-lifecycle'
import { parseSpaceReference } from '../storage/space-reference'
import type { FileSpace } from '../storage/file-space'

type Adoption = { fileId: string; collected: string; trashed: boolean; adoptedVersion: string; updateError?: string }
export class SpaceQueries {
  private readonly session = randomUUID()
  constructor(private lib: Library) {}
  private adoptions(spaceId: string, fileIds?: string[]) {
    const rows = this.lib.db.prepare(`SELECT a.file_id,a.entity_id,e.deleted_at,b.data,u.error FROM main.space_adoptions a
      JOIN main.entity e ON e.id=a.entity_id JOIN main.block b ON b.entity_id=e.id AND b.kind='file'
      LEFT JOIN main.space_updates u ON u.space_id=a.space_id AND u.file_id=a.file_id
      WHERE a.space_id=@spaceId ${fileIds ? 'AND a.file_id IN (SELECT value FROM json_each(@ids))' : ''} ORDER BY a.file_id`).all({ spaceId, ...(fileIds ? { ids: JSON.stringify(fileIds) } : {}) }) as { file_id: string; entity_id: string; deleted_at: number | null; data: string; error: string | null }[]
    const result = new Map<string, Adoption>()
    for (const row of rows) {
      const ref = parseSpaceReference(String(JSON.parse(row.data).path))
      if (ref?.spaceId !== spaceId || ref.fileId !== row.file_id || !ref.contentVersion) continue
      result.set(row.file_id, { fileId: row.file_id, collected: row.entity_id, trashed: row.deleted_at !== null, adoptedVersion: ref.contentVersion, updateError: row.error ?? undefined })
    }
    return result
  }
  private groups(space: FileSpace, adopted: Map<string, Adoption>) {
    const heads = new Map((space.db.prepare('SELECT fileId,contentVersion FROM file_heads WHERE fileId IN (SELECT value FROM json_each(?))').all(JSON.stringify([...adopted.keys()])) as { fileId: string; contentVersion: string }[]).map(h => [h.fileId, h.contentVersion]))
    const collected = [...adopted.values()].filter(a => !a.trashed)
    return {
      uncollected: { ids: [...adopted.keys()], exclude: true },
      collected: { ids: collected.map(a => a.fileId) },
      trashed: { ids: [...adopted.values()].filter(a => a.trashed).map(a => a.fileId) },
      outdated: { ids: collected.filter(a => heads.has(a.fileId) && heads.get(a.fileId) !== a.adoptedVersion).map(a => a.fileId) }
    } satisfies Record<string, SpaceFileSelection>
  }
  private counts(service: SpaceLifecycle, groups: ReturnType<SpaceQueries['groups']>) {
    return { ...service.counts(), ...Object.fromEntries(Object.entries(groups).map(([key, selection]) => [key, service.count('active', selection)])) }
  }
  list(input?: SpaceListInput): SpaceBindingInfo[] {
    const request = spaceListSchema.parse(input ?? {})
    return this.lib.files.bindings!.list().map(binding => {
      if (!request.includeCounts || binding.error) return binding
      try {
        const space = this.lib.files.bindings!.open(binding.id)
        return space.db.transaction(() => this.lib.db.transaction(() => ({ ...binding,
          counts: this.counts(new SpaceLifecycle(space), this.groups(space, this.adoptions(space.id))) }))())()
      } catch (error) { return { ...binding, error: String(error) } }
    })
  }
  page(input: SpacePageInput) {
    const request = spacePageSchema.parse(input)
    if (request.scope !== 'active' && request.collectFilter && request.collectFilter !== 'all') throw new Error('[INVALID_INPUT] 收录筛选只用于 active 文件列表')
    const space = this.lib.files.bindings!.open(request.spaceId)
    return space.db.transaction(() => this.lib.db.transaction(() => {
      const service = new SpaceLifecycle(space), filter = request.collectFilter ?? 'all'
      const allAdopted = request.includeCounts || filter !== 'all' ? this.adoptions(space.id) : undefined
      const groups = allAdopted && this.groups(space, allAdopted)
      const revision = [this.session, this.lib.db.prepare('SELECT total_changes()').pluck().get(), this.lib.db.pragma('data_version', { simple: true })]
      const page = service.page({ ...request, collectFilter: undefined, includeCounts: false }, filter === 'all' ? undefined : groups![filter], JSON.stringify([revision, filter]))
      const adopted = allAdopted ?? this.adoptions(space.id, page.items.map(f => f.id))
      return { ...page, ...(request.includeCounts ? { counts: this.counts(service, groups!) } : {}), items: page.items.map(file => {
        const item = adopted.get(file.id)
        return { ...file, ...(item ? { collected: item.collected, trashed: item.trashed, adoptedVersion: item.adoptedVersion, updateError: item.updateError } : {}), collectionState: item ? item.trashed ? 'trashed' as const : 'collected' as const : 'uncollected' as const,
          hasUpdate: !!item && !item.trashed && !!file.contentVersion && item.adoptedVersion !== file.contentVersion }
      }) }
    })())()
  }
}
