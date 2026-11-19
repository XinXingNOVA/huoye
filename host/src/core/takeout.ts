import { portablePath } from '../shared/paths'
// 记录取回不调用插件的导出器。记录、定义、引用和原文件独立交出，便于继续使用。
import { statSync } from 'node:fs'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { BlockKind, EntityView } from '../shared/blocks'
import type { TakeoutPreview, TakeoutResult } from '../shared/rpc'
import type { Library } from './library'
import type { Registry } from './registry'
import type { Store } from './store'
import { safeName } from './export'

interface Reference { entity_id: string; kind: string; field: string; target_id: string; ref_type: string }
interface Original { id: string; kind: string; field: string; index?: number; path: string }
const message = (e: unknown) => e instanceof Error ? e.message : String(e)
const serializableKind = ({ validate: _, dormant: __, ...kind }: BlockKind) => kind

export class Takeout {
  constructor(private lib: Library, private reg: Registry, private store: Store) {}

  private inside(path: string): string {
    return this.lib.files.readable(path)
  }

  locate(input: { id: string; kind: string; field: string; index?: number }): string {
    const def = this.reg.kind(input.kind)
    const field = def?.fields[input.field]
    if (!def || def.rebuildable || !field?.file) throw new Error('这个字段不是原文件')
    const value = this.store.blocksOf(input.id)[input.kind]?.data[input.field]
    const path = field.list && Array.isArray(value) ? value[input.index ?? 0] : value
    if (typeof path !== 'string') throw new Error('记录中没有这个原文件')
    return this.inside(path)
  }

  private refs(ids: string[]): Reference[] {
    return this.lib.db.prepare(`SELECT * FROM main.ref WHERE entity_id IN (SELECT value FROM json_each(?))
      UNION SELECT * FROM derived.ref WHERE entity_id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(ids), JSON.stringify(ids)) as Reference[]
  }

  private plan(ids: string[]) {
    const selected = [...new Set(ids)]
    if (!selected.length) throw new Error('请选择要取回的记录')
    if (selected.some(id => !this.store.exists(id))) throw new Error('部分记录已不存在，请重新选择')
    const included = new Set(selected)
    // 摘录与原素材一起取回；模板定义也是记录。循环引用通过 Set 收敛。
    for (const id of included) {
      for (const child of this.store.withAttached([id])) included.add(child)
      for (const ref of this.refs([id])) if (ref.ref_type === 'attach' && this.store.exists(ref.target_id)) included.add(ref.target_id)
      for (const kind of Object.keys(this.store.blocksOf(id))) {
        const template = this.reg.kind(kind)?.template
        if (template && this.store.exists(template)) included.add(template)
      }
    }
    const records = this.store.get([...included])
    const definitions = [...new Set(records.flatMap(v => Object.keys(v.blocks)))].flatMap(k => {
      const def = this.reg.kind(k)
      return def ? [serializableKind(def)] : []
    })
    const references = this.refs([...included])
    const external = references.filter(r => !included.has(r.target_id))
    const originals: Original[] = []
    const problems: string[] = []
    for (const record of records) for (const [kind, block] of Object.entries(record.blocks)) {
      const def = this.reg.kind(kind)
      if (!def) { problems.push(`${record.id} / ${kind}：缺少定义，保留原始字段，无法判断文件归属`); continue }
      if (def.rebuildable) continue
      for (const [field, f] of Object.entries(def.fields)) {
        if (!f.file) continue
        const values = f.list && Array.isArray(block.data[field]) ? block.data[field] as unknown[] : [block.data[field]]
        values.forEach((value, index) => {
          if (typeof value === 'string' && value) originals.push({ id: record.id, kind, field, ...(f.list ? { index } : {}), path: value })
        })
      }
    }
    return { selected, records, definitions, references, external, originals, problems }
  }

  preview(ids: string[]): TakeoutPreview {
    const plan = this.plan(ids)
    let files = 0, bytes = 0
    for (const path of new Set(plan.originals.map(f => f.path))) {
      try { bytes += statSync(this.inside(path)).size; files++ }
      catch (error) { plan.problems.push(`${path}：${message(error)}`) }
    }
    return { items: plan.selected.length, related: plan.records.length - plan.selected.length, files, bytes,
      externalReferences: new Set(plan.external.map(r => r.target_id)).size, problems: plan.problems }
  }

  async run(input: { ids: string[]; parent: string; name: string }): Promise<TakeoutResult> {
    // 在任何异步复制前固定记录和定义；复制期间原记录发生变化时明确报告，不伪称完整快照。
    const plan = this.plan(input.ids)
    const name = safeName(input.name)
    let dir = join(input.parent, name)
    for (let n = 1; ; n++) {
      try { await mkdir(dir); break }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        dir = join(input.parent, `${name} (${n + 1})`)
      }
    }
    const files: { source: string; copy?: string; error?: string }[] = []
    for (const path of new Set(plan.originals.map(f => f.path))) {
      try {
        const source = this.inside(path)
        const before = await stat(source)
        const copy = `files/${files.length + 1}/${safeName(basename(portablePath(path)), 180)}`
        await mkdir(join(dir, 'files', String(files.length + 1)), { recursive: true })
        await this.lib.files.copyOut(path, join(dir, copy))
        const after = await stat(source)
        const error = before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino ? '复制期间原文件发生变化，请重新取回' : undefined
        files.push({ source: path, copy, ...(error ? { error } : {}) })
        if (error) plan.problems.push(`${path}：${error}`)
      } catch (error) {
        files.push({ source: path, error: message(error) })
        plan.problems.push(`${path}：${message(error)}`)
      }
    }
    const version = (view?: EntityView) => JSON.stringify(view && { deletedAt: view.deletedAt, blocks: view.blocks })
    for (const before of plan.records) {
      if (version(before) !== version(this.store.get([before.id])[0])) plan.problems.push(`${before.id}：取回期间记录发生变化，请重新取回`)
    }
    const manifest = { format: 'resource-manager-records', version: 1, libraryId: this.lib.id, createdAt: Date.now(),
      selected: plan.selected, records: plan.records, definitions: plan.definitions, references: plan.references,
      externalReferences: plan.external, originalFiles: plan.originals, files, problems: plan.problems,
      scope: { derivedValues: 'snapshot', cachedFiles: false, history: false, libraryConfig: false } }
    await writeFile(join(dir, 'records.json'), JSON.stringify(manifest, null, 2), { flag: 'wx' })
    await writeFile(join(dir, '说明.txt'), '记录取回包\n\nrecords.json 保存身份、完整字段值、定义、引用及原文件映射。files/ 保存原文件的副本。\n包含选中的记录、依附的原素材与摘录、使用的模板。普通关联只保留引用，未包含的对象列在 externalReferences。\n可重建字段保留当时的值，缓存文件不复制。此包不包含操作历史、仓库配置与工作区，也不是可直接打开或自动恢复的完整仓库。\n请检查 records.json 中的 problems；缺失或发生变化的内容会在那里列出。\n', { flag: 'wx' })
    return { dir, items: plan.records.length, files: files.filter(f => f.copy && !f.error).length, problems: plan.problems }
  }
}
