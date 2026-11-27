import type { CommandContext } from './plugin'
import type { Library } from './library'
import type { Registry } from './registry'
import type { Store } from './store'
import type { History } from './history'
import type { BlockEditing } from './block-editing'
import { runQuery } from './query'
import { invokeCommand } from './commands'

/** 命令、预演与外部 operation 使用同一个上下文；业务校验仍由插件补充。 */
export class PluginCommands {
  private readonly activeBlockSeq

  constructor(private lib: Library, private reg: Registry, private store: Store, private history: History, private editing: BlockEditing) {
    this.activeBlockSeq = lib.db.prepare(`SELECT b.seq FROM main.block b JOIN main.entity e ON e.id=b.entity_id
      WHERE b.entity_id=? AND b.kind=? AND e.deleted_at IS NULL`).pluck()
  }

  context(plugin: string): CommandContext {
    const { reg, store, lib, editing } = this
    return {
      kind: id => reg.kind(id),
      query: q => runQuery(lib.db, reg, q),
      blocksOf: id => store.blocksOf(id),
      expectBlocks: expected => {
        if (!Array.isArray(expected) || !expected.length || expected.length > 1000) throw new Error('[INVALID_INPUT] 版本检查需要 1～1000 条记录')
        for (const item of expected) {
          if (!item || typeof item.id !== 'string' || !item.id || item.id.length > 200 ||
            typeof item.kind !== 'string' || !item.kind || item.kind.length > 200 || !Number.isSafeInteger(item.seq) || item.seq < 1) {
            throw new Error('[INVALID_INPUT] 无效的数据块版本条件')
          }
          if (this.activeBlockSeq.get(item.id, item.kind) !== item.seq) throw new Error('[BLOCK_CHANGED] 记录已更改、回收或移除，请重新读取')
        }
      },
      createEntity: () => store.createEntity(),
      put: (id, kind, data) => {
        const def = reg.requireKind(kind)
        if (def.management && def.plugin !== plugin) throw new Error('只能修改本插件的管理记录')
        editing.put(id, kind, data, plugin)
      },
      remove: (id, kind) => editing.remove(id, kind),
      trash: ids => store.trash(this.materialIds('trash', ids)),
      restore: ids => store.restore(this.materialIds('restore', ids)),
      deleteRecord: id => store.deleteRecord(id, plugin)
    }
  }

  private materialIds(action: 'trash' | 'restore', ids: string[]): string[] {
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 100 || ids.some(id => typeof id !== 'string' || !id.length || id.length > 200)) throw new Error(`[INVALID_INPUT] ${action} 需要 1～100 个素材 ID`)
    const unique = [...new Set(ids)]
    if (unique.some(id => !this.store.exists(id))) throw new Error('[NOT_FOUND] 素材不存在或已彻底删除')
    this.store.lifecycleFamily(unique)
    return unique
  }

  private command(plugin: string, name: string) {
    const fn = this.reg.plugins.find(p => p.id === plugin)?.commands?.[name]
    if (!fn) throw new Error(`插件 ${plugin} 没有命令 ${name}`)
    return fn
  }

  run(plugin: string, name: string, args: Record<string, unknown>): unknown {
    const fn = this.command(plugin, name)
    return this.history.run(r => r.label, () => invokeCommand(fn, this.context(plugin), args), { plugin, operation: name }).result
  }

  preview(plugin: string, name: string, args: Record<string, unknown>): unknown {
    const fn = this.command(plugin, name), rollback = Symbol('preview')
    let result: unknown
    try {
      this.store.batch(() => {
        // 建立和正式执行相同的历史作用域，内部编辑不会另起独立操作；随后整体回滚。
        result = this.history.run(r => r.label, () => invokeCommand(fn, this.context(plugin), args), { plugin, operation: name }).result
        throw rollback
      })
    } catch (e) { if (e !== rollback) throw e }
    return result
  }
}
