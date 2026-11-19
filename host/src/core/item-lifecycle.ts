import type { HistoryContext, HistorySource } from '../shared/history'
// 仓库身份的生命周期。不推断文件所有权，不删除空间原件；UI 与 MCP 共用。
import { createHash } from 'node:crypto'
import type { Library } from './library'
import type { Store } from './store'
import type { Purging } from './purge'
import { itemLifecyclePreviewSchema, itemLifecycleSchema, type ItemLifecyclePreviewInput, type ItemLifecycleInput,
  type ItemLifecyclePreview, type ItemLifecycleResult } from '../shared/item-lifecycle'

export class ItemLifecycle {
  constructor(private lib: Library, private store: Store, private purging: Purging,
    private change: (action: 'trash' | 'restore', ids: string[], context: HistoryContext) => void) {}

  preview(input: ItemLifecyclePreviewInput): ItemLifecyclePreview {
    const request = itemLifecyclePreviewSchema.parse(input)
    const all = this.store.withAttached(request.ids).sort()
    this.store.assertMaterials(all)
    if (request.ids.some(id => !this.store.exists(id))) throw new Error('[NOT_FOUND] 素材不存在')
    const entities = this.lib.db.prepare('SELECT id,deleted_at FROM main.entity WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id').all(JSON.stringify(all))
    const blocks = this.lib.db.prepare('SELECT entity_id,kind,seq FROM main.block WHERE entity_id IN (SELECT value FROM json_each(?)) ORDER BY entity_id,kind').all(JSON.stringify(all))
    const purge = request.action === 'purge' ? this.purging.preview(request.ids) : undefined
    // 原始数据、附属关系及回收状态变化会使预览失效；派生缩略图加工不使预览反复失效。
    const previewToken = createHash('sha256').update(JSON.stringify([request, entities, blocks, purge])).digest('hex')
    return { action: request.action, previewToken, selected: request.ids.length, affected: all.length,
      originals: 'preserved', undoable: request.action !== 'purge', ...(purge ? { purge } : {}) }
  }

  receipt(input: ItemLifecycleInput): ItemLifecycleResult | undefined {
    const request = itemLifecycleSchema.parse(input), { requestId, previewToken, ...selection } = request
    const signature = createHash('sha256').update(JSON.stringify(['item-lifecycle', selection, previewToken])).digest('hex')
    const old = this.lib.db.prepare('SELECT signature,result FROM main.operation_receipt WHERE request_id=?').get(requestId) as { signature: string; result: string } | undefined
    if (old) {
      if (old.signature !== signature) throw new Error('[REQUEST_ID_CONFLICT] 请求 ID 已用于其他操作')
      return { ...JSON.parse(old.result), replayed: true }
    }
    return undefined
  }

  execute(input: ItemLifecycleInput, source: HistorySource = 'application'): ItemLifecycleResult {
    const request = itemLifecycleSchema.parse(input), { requestId, previewToken, ...selection } = request
    const old = this.receipt(request)
    if (old) return old
    const signature = createHash('sha256').update(JSON.stringify(['item-lifecycle', selection, previewToken])).digest('hex')
    if (this.lib.db.prepare('SELECT 1 FROM main.ingest_pending WHERE key=?').get(`mcp:${requestId}`)) throw new Error('[REQUEST_ID_CONFLICT] 请求 ID 已用于导入')
    return this.store.batch(() => {
      if (this.preview(selection).previewToken !== previewToken) throw new Error('[PREVIEW_CHANGED] 素材已变化，请重新预览')
      const before = this.lib.db.prepare('SELECT id,deleted_at FROM main.entity WHERE id IN (SELECT value FROM json_each(?))').all(JSON.stringify(this.store.withAttached(request.ids))) as { id: string; deleted_at: number | null }[]
      const purge = request.action === 'purge' ? this.purging.run(request.ids) : undefined
      if (!purge) this.change(request.action as 'trash' | 'restore', request.ids, { source, operation: `items.${request.action}`, requestId })
      const ids = purge?.ids ?? before.filter(row => this.store.isTrashed(row.id) !== (row.deleted_at !== null)).map(row => row.id)
      const result: ItemLifecycleResult = { requestId, replayed: false, action: request.action, ids, originals: 'preserved', ...(purge ? { purge } : {}) }
      this.lib.db.prepare('INSERT INTO main.operation_receipt VALUES (?,?,?,?)').run(requestId, signature, JSON.stringify(result), Date.now())
      return result
    })
  }
}
