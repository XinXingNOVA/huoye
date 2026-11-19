// 模板的编辑与结构演变（设计文档 11.6）：所有入口从核心最新数据执行，避免界面读改写覆盖并发修改。
// 每个命令同时改模板和所有挂着它的素材，在核心里一个事务完成，是一个可撤销的操作；界面先预演拿到影响范围。
// 定义先于数据：先写模板（核心立刻按新定义注册），再按新定义改素材上的值。

import type { Command, CommandContext } from '@resource-manager/plugin-api/core/contracts'
import { FIELD_TYPES, newFieldId, templateKindId, type FieldSpec, type FieldType, type TemplateData } from '../blocks'
import { convertValue, itemsOf, textOf } from './convert'
import { setValuesSchema } from './operations'

const typeTitle = (t: FieldType) => FIELD_TYPES.find((x) => x.id === t)?.title ?? t
const isChoice = (t: FieldType) => t === 'select' || t === 'multi'

function load(ctx: CommandContext, templateId: string): TemplateData {
  if (!ctx.query({ scope: 'all', role: 'management', ids: [templateId] }).ids.length) throw new Error('模板不存在或已删除')
  const t = ctx.blocksOf(templateId).template?.data as unknown as TemplateData | undefined
  if (!t) throw new Error('模板不存在')
  return { title: t.title, fields: (t.fields ?? []).map((f) => ({ ...f, options: f.options && [...f.options] })) }
}

function fieldOf(t: TemplateData, id: unknown): FieldSpec {
  const f = t.fields.find((x) => x.id === id)
  if (!f) throw new Error('字段不存在')
  return f
}

const save = (ctx: CommandContext, templateId: string, t: TemplateData) =>
  ctx.put(templateId, 'template', t as unknown as Record<string, unknown>)

/**
 * 挂着这个模板的身份，包括回收站里的：恢复回来时，数据也要对得上新的定义。
 * 按收录的先后：由已有的值生成选项时，选项的顺序就是它们出现的顺序。
 */
const holders = (ctx: CommandContext, kind: string) => [
  ...ctx.query({ scope: 'all', has: [kind], dir: 'asc' }).ids,
  ...ctx.query({ scope: 'trash', has: [kind], dir: 'asc' }).ids
]

/** 改所有素材上这个字段的值。返回有值的项数、被清空的项数。 */
function rewrite(ctx: CommandContext, kind: string, field: string, fn: (v: unknown) => unknown) {
  let total = 0
  let cleared = 0
  for (const id of holders(ctx, kind)) {
    const data = ctx.blocksOf(id)[kind]?.data
    if (!data || data[field] === undefined) continue
    total++
    const next = fn(data[field])
    if (next === undefined) cleared++
    if (JSON.stringify(next) === JSON.stringify(data[field])) continue
    const out = { ...data }
    if (next === undefined) delete out[field]
    else out[field] = next
    ctx.put(id, kind, out)
  }
  return { total, cleared }
}

const str = (v: unknown, name: string) => {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`缺少${name}`)
  return v.trim()
}

export const commands: Record<string, Command> = {
  setValues: (ctx, raw) => {
    const { template, items } = setValuesSchema.parse(raw)
    const t = load(ctx, template), kind = templateKindId(template)
    if (new Set(items.map(item => item.id)).size !== items.length) throw new Error('同一素材不能重复出现')
    const active = new Set(ctx.query({ scope: 'all', role: 'material', ids: items.map(item => item.id) }).ids)
    for (const item of items) {
      if (!active.has(item.id)) throw new Error('素材不存在或已在回收站')
      const old = ctx.blocksOf(item.id)[kind]
      if ((old?.seq ?? 0) !== item.expectedSeq) throw new Error('字段值已在别处修改，请重新读取后再填写')
      const data = { ...old?.data }
      for (const [key, value] of Object.entries(item.values)) {
        fieldOf(t, key)
        if (value === null) delete data[key]
        else data[key] = value
      }
      ctx.put(item.id, kind, data)
    }
    return { label: `填写模板「${t.title}」（${items.length} 项）`, result: { ids: items.map(item => item.id), kind } }
  },
  createTemplate: (ctx, { title }) => {
    const name = str(title, '模板名称')
    const id = ctx.createEntity()
    save(ctx, id, { title: name, fields: [] })
    return { label: `新建模板「${name}」`, result: { template: id, kind: templateKindId(id) } }
  },

  deleteTemplate: (ctx, { template, expectedAffected }) => {
    const id = str(template, '模板')
    const t = load(ctx, id)
    const kind = templateKindId(id)
    const ids = [...new Set([...holders(ctx, kind), ...ctx.query({ scope: 'trash', role: 'management', has: [kind] }).ids])]
    if (expectedAffected !== undefined && expectedAffected !== ids.length) throw new Error('模板使用数量已变化，请重新打开删除确认')
    for (const holder of ids) ctx.remove(holder, kind)
    ctx.deleteRecord(id)
    return { label: `删除模板「${t.title}」（${ids.length} 项）`, result: { affected: ids.length } }
  },

  renameTemplate: (ctx, { template, title }) => {
    const id = str(template, '模板')
    const t = load(ctx, id)
    const name = str(title, '模板名称')
    save(ctx, id, { ...t, title: name })
    return { label: `把模板「${t.title}」改名为「${name}」` }
  },

  addField: (ctx, { template, title, type }) => {
    const id = str(template, '模板')
    const t = load(ctx, id)
    const name = str(title, '字段名称')
    if (!FIELD_TYPES.some((x) => x.id === type)) throw new Error(`未知的字段类型：${String(type)}`)
    const field: FieldSpec = { id: newFieldId(t.fields), title: name, type: type as FieldType }
    if (isChoice(field.type)) field.options = []
    save(ctx, id, { ...t, fields: [...t.fields, field] })
    return { label: `新建字段「${name}」`, result: { field: field.id } }
  },

  renameField: (ctx, { template, field, title }) => {
    const id = str(template, '模板')
    const t = load(ctx, id)
    const f = fieldOf(t, field)
    const before = f.title
    f.title = str(title, '字段名称')
    save(ctx, id, t)
    return { label: `把字段「${before}」改名为「${f.title}」` }
  },

  addOption: (ctx, { template, field, option }) => {
    const id = str(template, '模板')
    const t = load(ctx, id)
    const f = fieldOf(t, field)
    const name = str(option, '选项')
    if (!isChoice(f.type)) throw new Error('只有单选、多选字段可以添加选项')
    const options = f.options ?? []
    if (options.includes(name)) return { label: '选项已存在' }
    f.options = [...options, name]
    save(ctx, id, t)
    return { label: `添加选项「${name}」` }
  },

  /** 删除字段：模板里去掉，所有素材上的值清空。 */
  deleteField: (ctx, { template, field }) => {
    const id = str(template, '模板')
    const t = load(ctx, id)
    const f = fieldOf(t, field)
    save(ctx, id, { ...t, fields: t.fields.filter((x) => x.id !== f.id) })
    const { total } = rewrite(ctx, templateKindId(id), f.id, () => undefined)
    return { label: `删除字段「${f.title}」`, result: { cleared: total } }
  },

  /** 改字段类型：按规则转换每个值，转换不了的清空。改成单选、多选时，已有的值成为选项。 */
  changeType: (ctx, { template, field, type }) => {
    const id = str(template, '模板')
    const t = load(ctx, id)
    const from = fieldOf(t, field)
    const toType = type as FieldType
    if (!FIELD_TYPES.some((x) => x.id === toType)) throw new Error(`未知的字段类型：${String(type)}`)
    const kind = templateKindId(id)
    const to: FieldSpec = { id: from.id, title: from.title, type: toType }
    if (isChoice(toType)) {
      if (isChoice(from.type)) to.options = from.options ?? []
      else {
        const seen = new Set<string>()
        for (const h of holders(ctx, kind)) {
          for (const item of itemsOf(ctx.blocksOf(h)[kind]?.data[from.id])) {
            const s = textOf(item, from)
            if (s) seen.add(s)
          }
        }
        to.options = [...seen]
      }
    }
    save(ctx, id, { ...t, fields: t.fields.map((x) => (x.id === from.id ? to : x)) })
    const { total, cleared } = rewrite(ctx, kind, from.id, (v) => convertValue(v, from, to))
    return { label: `把「${from.title}」从${typeTitle(from.type)}改成${typeTitle(toType)}`, result: { total, cleared, options: to.options } }
  },

  /** 选项改名；改成已有的选项就是合并。 */
  renameOption: (ctx, { template, field, from, to }) => {
    const id = str(template, '模板')
    const t = load(ctx, id)
    const f = fieldOf(t, field)
    const a = str(from, '原选项')
    const b = str(to, '新选项')
    const options = f.options ?? []
    if (!options.includes(a)) throw new Error(`没有选项「${a}」`)
    if (a === b) return { label: '选项没有变化', result: { total: 0 } }
    const merge = options.includes(b)
    f.options = merge ? options.filter((o) => o !== a) : options.map((o) => (o === a ? b : o))
    save(ctx, id, t)
    const { total } = rewrite(ctx, templateKindId(id), f.id, (v) =>
      Array.isArray(v) ? [...new Set(v.map((x) => (x === a ? b : x)))] : v === a ? b : v
    )
    return { label: merge ? `把选项「${a}」合并到「${b}」` : `把选项「${a}」改名为「${b}」`, result: { total } }
  },

  /** 删除选项：用着它的素材上去掉这个值。 */
  deleteOption: (ctx, { template, field, option }) => {
    const id = str(template, '模板')
    const t = load(ctx, id)
    const f = fieldOf(t, field)
    const o = str(option, '选项')
    f.options = (f.options ?? []).filter((x) => x !== o)
    save(ctx, id, t)
    let used = 0
    rewrite(ctx, templateKindId(id), f.id, (v) => {
      if (Array.isArray(v)) {
        if (!v.includes(o)) return v
        used++
        const rest = v.filter((x) => x !== o)
        return rest.length ? rest : undefined
      }
      if (v !== o) return v
      used++
      return undefined
    })
    return { label: `删除选项「${o}」`, result: { cleared: used } }
  },

  /**
   * 标签升级为模板：新建一个同名模板（还没有字段），带这个标签的素材都挂上它，标签去掉。
   * 依赖标签插件的标签块。
   */
  promoteTag: (ctx, { tag }) => {
    const name = str(tag, '标签')
    const ids = ctx.query({ scope: 'all', where: [{ op: 'eq', kind: 'tags', field: 'values', value: name }] }).ids
    const id = ctx.createEntity()
    save(ctx, id, { title: name, fields: [] })
    const kind = templateKindId(id)
    for (const e of ids) {
      ctx.put(e, kind, {})
      const rest = ((ctx.blocksOf(e).tags?.data.values as string[] | undefined) ?? []).filter((x) => x !== name)
      if (rest.length) ctx.put(e, 'tags', { values: rest })
      else ctx.remove(e, 'tags')
    }
    return { label: `把标签「${name}」升级为模板`, result: { template: id, kind, count: ids.length } }
  }
}
