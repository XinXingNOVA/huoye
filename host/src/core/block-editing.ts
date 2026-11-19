// 普通数据编辑的共同约束。UI、插件命令与视图准入共用；导入、加工及历史重放使用各自受控的 Store 路径。
import type { BlockData } from '../shared/blocks'
import type { Library } from './library'
import type { Registry } from './registry'
import type { Store } from './store'
import type { History } from './history'

export class BlockEditing {
  constructor(private lib: Library, private reg: Registry, private store: Store, private history: History) {}

  title(kind: string): string { return this.reg.kind(kind)?.title ?? kind }

  private managementLabel(kind: string, data: BlockData): string | undefined {
    const def = this.reg.requireKind(kind), field = def.display?.title
    return def.management && field ? `${def.title}「${String(data[field] ?? '')}」` : undefined
  }

  private editable(kind: string) {
    const def = this.reg.requireKind(kind)
    if (def.rebuildable) throw new Error(`数据块 ${kind} 是可重建的，不能手动编辑`)
    return def
  }

  private existing(id: string): void {
    if (!this.store.exists(id)) throw new Error(`[NOT_FOUND] 身份 ${id} 不存在`)
  }

  private protectFileSnapshot(id: string, data: BlockData): void {
    const old = this.store.blocksOf(id).file?.data
    if (!old || ['path', 'hash', 'size', 'ext', 'mime'].some(field => data[field] !== old[field])) {
      throw new Error('文件信息请通过收录、改名或编辑文件操作修改')
    }
    // 显示名属于仓库，原件离线或已回收也可以改名；这里不重新打开原件。
  }

  put(id: string, kind: string, data: BlockData): void {
    this.existing(id)
    this.editable(kind)
    if (kind === 'file') this.protectFileSnapshot(id, data)
    this.history.run(`修改${this.managementLabel(kind, data) ?? this.title(kind)}`, () => this.store.put(id, kind, data))
  }

  patch(id: string, kind: string, fields: BlockData): void {
    this.existing(id)
    const def = this.editable(kind)
    const names = Object.keys(fields).map(f => def.fields[f]?.title ?? f)
    const label = names.length === 1 && names[0] === def.title ? `修改${def.title}` : `修改${def.title} · ${names.join('、')}`
    this.history.run(label, () => {
      const data = { ...(this.store.blocksOf(id)[kind]?.data ?? {}) }
      for (const [k, v] of Object.entries(fields)) {
        if (v === null || v === undefined || (Array.isArray(v) && v.length === 0)) delete data[k]
        else data[k] = v
      }
      if (kind === 'file') this.protectFileSnapshot(id, data)
      if (Object.keys(data).length === 0 && def.template === undefined && !def.management) this.remove(id, kind)
      else this.put(id, kind, data)
    })
  }

  remove(id: string, kind: string): void {
    this.existing(id)
    this.store.assertMaterials([id])
    if (kind === 'file') throw new Error('文件引用请通过素材回收或文件操作管理')
    if (this.reg.kind(kind)?.rebuildable) throw new Error(`数据块 ${kind} 是可重建的，不能手动移除`)
    // 删除来源后，动态定义可能已撤下；允许清理仍留在素材上的对应块。
    this.history.run(`移除${this.title(kind)}`, () => this.store.remove(id, kind))
  }

  create(blocks: Record<string, BlockData>): string {
    for (const [kind, data] of Object.entries(blocks)) {
      this.editable(kind)
      // 显式创建允许引用已有合法版本；并不替换现有素材的文件或创建新的原件。
      if (kind === 'file') this.lib.files.validateFile(data)
    }
    const named = Object.entries(blocks).map(([kind, data]) => this.managementLabel(kind, data)).find(Boolean)
    const label = named ? `新建${named}` : '新建'
    return this.history.run(label, () => {
      const id = this.store.createEntity()
      for (const [kind, data] of Object.entries(blocks)) this.store.put(id, kind, data)
      return id
    })
  }
}
