import type { CommandContext } from '../plugin-api/core/contracts'
import type { BlockData, BlockKind } from '../shared/blocks'

/** 附加块的历史可按素材回放。身份、定义、原件与依附关系有各自的生命周期。 */
export function reviewableBlock(def?: BlockKind): boolean {
  return !!def && !def.dormant && !def.rebuildable && def.history !== false && !def.management && !def.standalone
    && !def.content && !Object.values(def.fields).some(field => field.file || field.ref === 'attach')
}

/** 同步命令可能混写不留历史的块。记录实际访问范围，稍后凭 requestId 组单仍可判定整笔操作。 */
export function observeReviewCommand(base: CommandContext, verdict: { reviewable: boolean }): CommandContext {
  const sorted = new Map<string, Set<string>>()
  const check = (id: string, kind: string, next?: BlockData) => {
    if (!reviewableBlock(base.kind(kind))) verdict.reviewable = false
    const fields = sorted.get(kind)
    if (!fields || !verdict.reviewable) return
    // 从集合读出排名再回写同一排序键属于整组重排，不能把某一行的旧排名孤立地写回。
    const previous = base.blocksOf(id)[kind]?.data
    for (const field of fields) if (JSON.stringify(previous?.[field]) !== JSON.stringify(next?.[field])) verdict.reviewable = false
  }
  return {
    ...base,
    query: query => {
      if (typeof query.sort === 'object') {
        const { kind, field } = query.sort
        if (!sorted.has(kind)) sorted.set(kind, new Set())
        sorted.get(kind)!.add(field)
      }
      return base.query(query)
    },
    put: (id, kind, data) => { check(id, kind, data); return base.put(id, kind, data) },
    remove: (id, kind) => { check(id, kind); return base.remove(id, kind) },
    createEntity: () => { verdict.reviewable = false; return base.createEntity() },
    trash: ids => { verdict.reviewable = false; return base.trash(ids) },
    restore: ids => { verdict.reviewable = false; return base.restore(ids) },
    deleteRecord: id => { verdict.reviewable = false; return base.deleteRecord(id) }
  }
}
