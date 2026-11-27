// 插件注册：收集数据块定义、识别器、加工 System，并检查装配是否成立。

import { validateContributions } from '../shared/plugin-plan'
import type { BlockKind, Blocks } from '../shared/blocks'
import { inputSpec, type CorePlugin, type ProcessorSystem, type Recognizer } from './plugin'
import type { Schema } from './schema'
import { jsonSchema } from '../shared/automation'
import { validateCompatibleSchemas } from './schema-compatibility'
import { validateIngestMetadata } from './ingest-metadata'
import { validateQueries } from './business-queries'

function displayProblem(k: BlockKind): string | undefined {
  if (k.display?.priority !== undefined && !Number.isFinite(k.display.priority)) return `数据块 ${k.id} 的呈现优先级无效`
  for (const name of [k.display?.title, k.display?.summary]) {
    if (name === undefined) continue
    const field = k.fields[name]
    if (!field || field.list || field.file || !['text', 'longtext'].includes(field.type)) return `数据块 ${k.id} 的呈现字段 ${name} 必须是单值文字字段`
  }
}

export type SystemInput = { spec: string; kind: string; field?: string }

export interface RegisteredSystem extends ProcessorSystem {
  plugin: string
  pluginVersion: number
  /** 排好序的新鲜度输入。 */
  inputKinds: SystemInput[]
  /** 排好序的、依附目标上的新鲜度输入。 */
  targetKinds: SystemInput[]
}

export class Registry {
  readonly plugins: CorePlugin[]
  private readonly kinds = new Map<string, BlockKind>()
  /** 由数据定义的数据块（例如用户的模板），运行时增减。 */
  private defined = new Map<string, BlockKind>()
  /** 休眠的数据块：插件没有启用，定义来自仓库里存的快照。 */
  private dormant = new Map<string, BlockKind>()
  readonly recognizers: Recognizer[]
  readonly systems: RegisteredSystem[]
  /** 每种数据块的产出者，按 priority 排好序。 */
  private readonly producers = new Map<string, RegisteredSystem[]>()
  private readonly aspects: { priority: number; get(blocks: Blocks): number | undefined }[]

  constructor(plugins: CorePlugin[]) {
    validateContributions(plugins, ['recognizers', 'systems', 'exportSections'])
    this.plugins = plugins
    const errors: string[] = []
    const pluginIds = new Set<string>()
    const operationNames = new Set(['describe_library', 'search_items', 'read_item', 'read_content', 'execute_query'])

    for (const p of plugins) {
      validateCompatibleSchemas(p)
      validateQueries(p)
      validateIngestMetadata(p)
      if (pluginIds.has(p.id)) errors.push(`插件 ${p.id} 重复注册`)
      pluginIds.add(p.id)
      for (const op of p.operations ?? []) {
        if (op.reviewable !== undefined && op.reviewable !== false) errors.push(`操作 ${op.name} 的 reviewable 仅可声明 false`)
        if (op.effect !== undefined && op.effect !== 'data' && op.effect !== 'structure') errors.push(`操作 ${op.name} 的影响类别必须是 data 或 structure`)
        if (!/^[a-z][a-z0-9_]{0,63}$/.test(op.name)) errors.push(`操作名 ${op.name} 无效`)
        if (operationNames.has(op.name)) errors.push(`操作 ${op.name} 重复或占用保留名称`)
        operationNames.add(op.name)
        if ((typeof op.command === 'string') === (typeof op.ingest === 'function')) errors.push(`操作 ${op.name} 必须且只能声明 command 或 ingest`)
        if (op.command !== undefined && !p.commands?.[op.command]) errors.push(`操作 ${op.name} 的命令 ${op.command} 不存在`)
        const schema = jsonSchema(op.input)
        if (schema.type !== 'object' || Object.hasOwn(schema.properties ?? {}, 'requestId')) errors.push(`操作 ${op.name} 需要对象输入，且不能占用 requestId`)
      }
      for (const k of p.blocks ?? []) {
        if (this.kinds.has(k.id)) errors.push(`数据块 ${k.id} 被重复定义`)
        if (k.plugin !== p.id) errors.push(`数据块 ${k.id} 声明的插件 ${k.plugin} 与注册它的插件 ${p.id} 不符`)
        if (k.container && (!k.content || k.rebuildable || k.management)) errors.push(`容器块 ${k.id} 必须是不可重建的内容块`)
        if (k.management && (!k.standalone || k.content || k.rebuildable || k.history === false || Object.values(k.fields).some(f => f.file))) {
          errors.push(`管理数据块 ${k.id} 必须独立、不可重建、保留历史且不能承载原文件或内容`)
        }
        if (k.ownedBy !== undefined) {
          const owner = k.fields[k.ownedBy]
          const fields = Object.values(k.fields)
          if (typeof k.ownedBy !== 'string' || !k.ownedBy || !k.standalone || k.content || k.management || k.rebuildable || k.history === false ||
            owner?.type !== 'ref' || owner.ref !== 'attach' || owner.list || fields.filter(f => f.ref === 'attach').length !== 1 || fields.some(f => f.file)) {
            errors.push(`从属记录 ${k.id} 必须独立、持久、保留历史，只有一个单值归属引用且不能承载原件`)
          }
        }
        if (k.management?.emptyWhen && !k.fields[k.management.emptyWhen]) errors.push(`管理数据块 ${k.id} 的空容器字段不存在`)
        if (k.content && k.rebuildable) errors.push(`内容类数据块 ${k.id} 不能是可重建的`)
        const displayError = displayProblem(k)
        if (displayError) errors.push(displayError)
        for (const [name, f] of Object.entries(k.fields)) {
          if (f.type === 'ref' && !f.ref) errors.push(`数据块 ${k.id} 的引用字段 ${name} 缺少引用类型`)
          if (f.index && f.type === 'json') errors.push(`数据块 ${k.id} 的 json 字段 ${name} 不能建索引`)
        }
        this.kinds.set(k.id, k)
      }
    }

    this.recognizers = plugins
      .flatMap((p) => p.recognizers ?? [])
      .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))

    const resolveInputs = (inputs: string[], kinds: { has(id: string): boolean }) =>
      [...inputs].sort().map(spec => ({ spec, ...inputSpec(spec, kinds) }))
    this.systems = plugins
      .flatMap((p) =>
        (p.systems ?? [])
          // 需要的插件没有启用：这个 System 不装配（它的加工记录由宿主保留）
          .filter((s) => !s.needs?.some((n) => !pluginIds.has(n)))
          .map((s) => ({
          ...s,
          plugin: p.id,
          pluginVersion: p.version,
          inputKinds: resolveInputs(s.inputs ?? s.has, new Set(s.has)),
          targetKinds: resolveInputs(s.targetInputs ?? [], this.kinds)
        }))
      )
      .sort((a, b) => a.priority - b.priority)

    for (const s of this.systems) {
      for (const k of s.has) if (!this.kinds.has(k)) errors.push(`System ${s.id} 识别的数据块 ${k} 未定义`)
      for (const { kind, spec } of s.inputKinds) if (!s.has.includes(kind)) errors.push(`System ${s.id} 的输入 ${spec} 不在识别条件中`)
      for (const { kind, spec } of s.targetKinds) if (!this.kinds.has(kind)) errors.push(`System ${s.id} 依赖的目标上的数据块 ${spec} 未定义`)
      for (const { kind, field, spec } of [...s.inputKinds, ...s.targetKinds]) {
        if (field !== undefined && !Object.hasOwn(this.kinds.get(kind)?.fields ?? {}, field)) errors.push(`System ${s.id} 的输入字段 ${spec} 未定义`)
      }
      if (s.relatedInputs) {
        const { kind, field, ownerField, sourceKinds } = s.relatedInputs
        const def = this.kinds.get(kind), ref = def?.fields[field]
        if (!def || def.rebuildable || ref?.type !== 'ref' || ref.ref !== 'link' ||
          (ownerField !== undefined ? !ownerField || def.ownedBy !== ownerField : !s.has.includes(kind)) ||
          !Array.isArray(sourceKinds) || !sourceKinds.length || sourceKinds.length > 16 ||
          new Set(sourceKinds).size !== sourceKinds.length || sourceKinds.some(k => !this.kinds.has(k))) {
          errors.push(`System ${s.id} 的关联输入必须使用持久块、已声明的归属和有效的来源块`)
        }
      }
      for (const k of s.outputs) {
        const kind = this.kinds.get(k)
        if (!kind) errors.push(`System ${s.id} 产出的数据块 ${k} 未定义`)
        else if (!kind.rebuildable) errors.push(`System ${s.id} 不能产出不可重建的数据块 ${k}`)
        // 多个产出者是允许的：在每个身份上按 priority 仲裁出唯一的写入者
        const list = this.producers.get(k) ?? []
        if (list.some((o) => o.priority === s.priority)) {
          errors.push(`数据块 ${k} 的两个产出者 ${list.find((o) => o.priority === s.priority)!.id} 与 ${s.id} 优先级相同，无法仲裁`)
        }
        list.push(s)
        this.producers.set(k, list)
      }
    }

    this.aspects = plugins
      .flatMap((p) => (p.aspect ? [p.aspect] : []))
      .sort((a, b) => a.priority - b.priority)

    for (const p of plugins) {
      const claimed = new Set<string>()
      for (const section of p.exportSections ?? []) {
        const kind = this.kinds.get(section.kind)
        if (kind?.plugin !== p.id) errors.push(`导出片段 ${section.id} 只能认领本插件的数据块`)
        if (section.order !== undefined && !Number.isFinite(section.order)) errors.push(`导出片段 ${section.id} 排序无效`)
        for (const field of section.fields) {
          const key = `${section.kind}.${field}`
          if (!kind?.fields[field]) errors.push(`导出片段 ${section.id} 的字段 ${key} 不存在`)
          if (claimed.has(key)) errors.push(`导出片段重复认领 ${key}`)
          claimed.add(key)
        }
      }
      if (p.defines && this.kinds.get(p.defines.kind)?.plugin !== p.id) {
        errors.push(`插件 ${p.id} 用来定义数据块的 ${p.defines.kind} 不是它自己的数据块`)
      }
    }

    if (errors.length) throw new Error(`插件装配失败：\n${errors.join('\n')}`)
  }

  kind(id: string): BlockKind | undefined {
    return this.kinds.get(id) ?? this.defined.get(id) ?? this.dormant.get(id)
  }

  requireKind(id: string): BlockKind {
    const k = this.kind(id)
    if (!k) throw new Error(`未知的数据块 ${id}`)
    return k
  }

  allKinds(): BlockKind[] {
    return [...this.kinds.values(), ...this.defined.values(), ...this.dormant.values()]
  }

  /** 插件用代码定义的数据块。 */
  pluginKinds(): BlockKind[] {
    return [...this.kinds.values()]
  }

  /** 由数据定义的数据块。 */
  definedKinds(): BlockKind[] {
    return [...this.defined.values()]
  }

  /** 运行时才知道的数据块：由数据定义的，加上休眠的。界面从核心进程取这些。 */
  runtimeKinds(): BlockKind[] {
    return [...this.defined.values(), ...this.dormant.values()]
  }

  setDormant(kinds: BlockKind[]): void {
    this.dormant = new Map(kinds.filter((k) => !this.kinds.has(k.id) && !this.defined.has(k.id)).map((k) => [k.id, { ...k, dormant: true }]))
  }

  /** 快照回收提交后，撤下已无来源和使用者的休眠定义。 */
  removeDormant(ids: string[]): void {
    for (const id of ids) this.dormant.delete(id)
  }

  /** 用来定义数据块的那些数据块，以及定义它们的插件。 */
  definers(): (NonNullable<CorePlugin['defines']> & { plugin: string })[] {
    return this.plugins.flatMap((p) => (p.defines ? [{ plugin: p.id, ...p.defines }] : []))
  }

  /**
   * 换上一组由数据定义的数据块。不合规的（和插件的数据块重名、可重建、索引 json 字段）跳过并报告，
   * 不让一份写坏的定义拖垮整个素材库。
   */
  setDefined(kinds: { plugin: string; kind: BlockKind }[], strict = false): string[] {
    const problems: string[] = []
    const next = new Map<string, BlockKind>()
    for (const { plugin, kind: k } of kinds) {
      if (this.kinds.has(k.id) || next.has(k.id) || (this.dormant.has(k.id) && this.dormant.get(k.id)!.plugin !== plugin)) problems.push(`数据块 ${k.id} 重名`)
      else if (k.plugin !== plugin) problems.push(`数据块 ${k.id} 声明的插件 ${k.plugin} 与定义它的插件 ${plugin} 不符`)
      else if (k.rebuildable || k.content || k.container || k.ownedBy !== undefined) problems.push(`由数据定义的数据块 ${k.id} 必须不可重建、非内容类`)
      else if (Object.values(k.fields).some((f) => f.index && f.type === 'json')) problems.push(`数据块 ${k.id} 的 json 字段不能建索引`)
      else if (displayProblem(k)) problems.push(displayProblem(k)!)
      else next.set(k.id, k)
    }
    if (strict && problems.length) throw new Error(problems.join('\n'))
    this.defined = next
    return problems
  }

  schemaOf(kind: string): Schema {
    return this.requireKind(kind).rebuildable ? 'derived' : 'main'
  }

  contentKinds(): BlockKind[] {
    return this.allKinds().filter((k) => k.content)
  }

  aspectOf(blocks: Blocks): number | undefined {
    for (const a of this.aspects) {
      const v = a.get(blocks)
      if (v !== undefined && Number.isFinite(v) && v > 0) return v
    }
    return undefined
  }

  /**
   * 这个身份上，某种数据块的写入者：满足识别条件、未被停用、priority 最小的产出者。
   * 对应框架里 EXCLUSIVE 的含义——同一实体上只有一个权威。
   */
  authorityFor(kind: string, blocks: Blocks, blockedSystems: ReadonlyMap<string, string>): RegisteredSystem | undefined {
    return (this.producers.get(kind) ?? []).find(
      (s) => !blockedSystems.has(s.id) && s.has.every((k) => blocks[k]) && (!s.match || s.match(blocks))
    )
  }

  producersOf(kind: string): RegisteredSystem[] {
    return this.producers.get(kind) ?? []
  }

  migration(kind: string) {
    const k = this.requireKind(kind)
    return this.plugins.find((p) => p.id === k.plugin)?.migrations?.[kind]
  }

  compatibleVersion(kind: string, version: number): boolean {
    const k = this.requireKind(kind)
    return !!this.plugins.find(p => p.id === k.plugin)?.compatibleSchemas?.some(old => old.id === kind && old.version === version)
  }
}
