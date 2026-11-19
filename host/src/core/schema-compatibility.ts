import type { CorePlugin } from '../plugin-api/core/contracts'
import { normalizeBlock, type BlockKind, type BlockData } from '../shared/blocks'
import { canonical, kindSnapshot } from '../shared/external-plugins'
import type { Library } from './library'

/** 只开放不改值的增量结构；不改 ID、归属、生命周期、既有字段类型或引用规则。 */
export function validateCompatibleSchemas(plugin: CorePlugin): void {
  const seen = new Set<string>()
  for (const raw of plugin.compatibleSchemas ?? []) {
    const old = kindSnapshot(raw), next = plugin.blocks?.find(k => k.id === old.id)
    const key = `${old.id}@${old.version}`
    if (!next || old.plugin !== plugin.id || old.rebuildable || next.rebuildable || old.template || next.template || plugin.defines?.kind === old.id ||
      !Number.isInteger(next.version) || !Number.isInteger(old.version) || old.version < 1 || old.version >= next.version || seen.has(key) || plugin.migrations?.[old.id]) throw new Error(`旧定义 ${key} 不能兼容接续`)
    seen.add(key)
    const shape = (k: BlockKind) => { const { fields: _f, version: _v, display: _d, container: _c, allowOnContainer: _a, ...rest } = kindSnapshot(k); return rest }
    if (canonical(shape(old)) !== canonical(shape(next)) || (old.container && !next.container) || (old.allowOnContainer && !next.allowOnContainer)) throw new Error(`旧定义 ${key} 改变了数据归属、容器契约或生命周期`)
    for (const [name, field] of Object.entries(old.fields)) {
      const current = next.fields[name]
      if (!current) throw new Error(`旧字段 ${key}.${name} 被移除`)
      const before = { ...field }, after = { ...current }
      if (before.type === 'enum' && after.type === 'enum' && before.options && after.options && before.options.every(value => after.options!.includes(value))) {
        delete before.options; delete after.options
      }
      if (canonical(before) !== canonical(after)) throw new Error(`旧字段 ${key}.${name} 不能重新解释`)
    }
  }
}

export function acceptsSchema(previous: BlockKind, current: BlockKind | undefined, history: BlockKind[]): boolean {
  if (!current) return false
  const old = canonical(kindSnapshot(previous))
  return old === canonical(kindSnapshot(current)) || history.some(k => k.id === current.id && old === canonical(kindSnapshot(k)))
}

export function unchangedData(kind: BlockKind, data: BlockData): void {
  if (canonical(normalizeBlock(kind, structuredClone(data))) !== canonical(data)) throw new Error(`数据块 ${kind.id} 的兼容接续不能改变原值`)
}

/** 加载预检无写入；不合规的包被停用，旧快照与原记录保持原样。 */
export function preflightCompatibleData(lib: Library, plugin: CorePlugin): void {
  for (const kind of plugin.blocks ?? []) {
    const history = plugin.compatibleSchemas?.filter(k => k.id === kind.id) ?? []
    if (!history.length) continue
    const rows = lib.db.prepare('SELECT data, schema_ver FROM main.block WHERE kind = ? AND schema_ver != ?').all(kind.id, kind.version) as { data: string; schema_ver: number }[]
    for (const row of rows) {
      if (!history.some(k => k.version === row.schema_ver)) throw new Error(`数据块 ${kind.id} 的旧版本 ${row.schema_ver} 未声明`)
      unchangedData(kind, JSON.parse(row.data))
    }
    // 即使记录已经删除，其历史仍需能按当前定义原样重放。
    const previous = lib.db.prepare('SELECT def FROM main.kind_def WHERE id = ?').pluck().get(kind.id) as string | undefined
    if (rows.length || (previous && JSON.parse(previous).version !== kind.version)) {
      // 快照较旧但记录版本已更新的异常／旧库状态，也逐条检查原值。
      for (const row of lib.db.prepare('SELECT data FROM main.block WHERE kind = ? AND schema_ver = ?').all(kind.id, kind.version) as { data: string }[]) unchangedData(kind, JSON.parse(row.data))
      const records = lib.db.prepare('SELECT data, new_data FROM main.block_history WHERE kind = ?').all(kind.id) as { data: string | null; new_data: string | null }[]
      for (const row of records) for (const value of [row.data, row.new_data]) if (value) unchangedData(kind, JSON.parse(value))
    }
  }
}
