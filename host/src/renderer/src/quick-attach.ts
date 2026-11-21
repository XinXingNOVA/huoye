import { fieldTitle, enumTitle, kindTitle } from '../../plugin-api/ui/locale'
import { uiText } from '../../shared/i18n/interface-display'
// 快速附加的建议（设计文档 11.5）：由数据块定义生成，和编辑器一样是值类型自带的。
// 每条建议都是一个查询：应用它 = 放入这个查询（10.7 的准入与写入）。
// 纯逻辑，不依赖页面，测试直接调用。

import type { BlockKind, FieldDef } from '../../shared/blocks'
import { splitConditions, type KindInfo, type Query } from '../../shared/query'

export interface AttachContext {
  kinds: BlockKind[]
  /** 文本字段已有的取值，按使用次数排好（和侧栏分面同一份数据）。键是 kind.field。 */
  values: Record<string, string[]>
  /** 保存的视图：带写入条件的就是配方。 */
  views: { id: string; title: string; query: Query }[]
  kindOf(id: string): KindInfo | undefined
}

export interface Suggestion {
  key: string
  /** 做什么，例如"状态：进行中"。 */
  label: string
  /** 写到哪里，例如"状态""模板""视图"。 */
  target: string
  query: Query
  score: number
}

/** 能快速附加的数据块：能手动写、挂在素材上的。 */
export const attachable = (k: BlockKind) => !k.rebuildable && !k.content && !k.standalone && !k.captured && !k.dormant

/** 能附加的字段：建了索引的（能成为查询条件），长文本、json 不行。 */
const attachableField = (f: FieldDef) => !!f.index && f.type !== 'json' && f.type !== 'longtext' && f.type !== 'ref' && f.type !== 'color'

const norm = (s: string) => s.toLowerCase().replace(/[:：]/g, ' ').replace(/\s+/g, ' ').trim()

/** 输入的每个词都出现在 text 里。 */
const matches = (text: string, tokens: string[]) => {
  const t = norm(text)
  return tokens.every((x) => t.includes(x))
}

/** "字段名 值"：输入以字段名开头时，剩下的部分是值。 */
function valueAfter(input: string, names: string[]): string | undefined {
  const i = norm(input)
  for (const n of names.map(norm)) {
    if (i.startsWith(n + ' ')) return input.trim().slice(n.length).replace(/^[\s:：]+/, '').trim() || undefined
  }
  return undefined
}

const eq = (kind: string, field: string, value: string | number | boolean): Query => ({
  scope: 'all',
  where: [{ op: 'eq', kind, field, value }]
})

export function suggest(input: string, ctx: AttachContext, limit = 12): Suggestion[] {
  const tokens = norm(input).split(' ').filter(Boolean)
  const empty = tokens.length === 0
  const out: Suggestion[] = []
  const add = (s: Suggestion) => out.push(s)
  /** 输入的词有落在值本身上（而不只是字段名、模板名上）：这样的建议排在前面。 */
  const hitsValue = (value: string) => tokens.some((t) => norm(value).includes(t))
  // 以字段名开头的输入是要写那个字段，不再当作新标签（包括不能附加的字段，例如长文本）
  const startsWithField = ctx.kinds.some(
    (k) => attachable(k) && Object.keys(k.fields).some(field => valueAfter(input, [fieldTitle(k, field), `${kindTitle(k)} · ${fieldTitle(k, field)}`]) !== undefined)
  )

  for (const k of ctx.kinds) {
    if (!attachable(k)) continue
    // 模板的字段带上模板名；插件的字段（状态、标签）字段名就够了
    const prefix = k.template !== undefined ? `${k.title} · ` : ''

    if (k.template !== undefined && (empty || matches(uiText("模板 {title}", { title: String(k.title) }), tokens))) {
      add({ key: `attach:${k.id}`, label: uiText("挂上「{title}」", { title: String(k.title) }), target: uiText("模板"), query: { scope: 'all', has: [k.id] }, score: empty ? 70 : 90 })
    }

    for (const [field, f] of Object.entries(k.fields)) {
      if (!attachableField(f)) continue
      const title = fieldTitle(k, field)
      const name = prefix + title
      const target = name
      const names = [name, title]

      // 取值有限的：每个选项一条
      const options: (string | boolean)[] = f.type === 'enum' ? (f.options ?? []) : f.type === 'boolean' ? [true, false] : []
      for (const o of options) {
        const shown = typeof o === 'boolean' ? (o ? uiText("是") : uiText("否")) : enumTitle(k, field, o)
        const text = `${name} ${shown}`
        // 什么都没输入时只列插件的单选（例如状态），模板的选项太多，等输入再给
        if (empty ? k.template !== undefined || f.type !== 'enum' : !matches(text, tokens)) continue
        const exact = !empty && norm(input) === norm(shown)
        const score = empty ? 40 : (hitsValue(shown) ? 100 : 60) + (exact ? 20 : 0)
        add({ key: `${k.id}.${field}=${String(o)}`, label: uiText("{name}：{value}", { name, value: shown }), target, query: eq(k.id, field, o), score })
      }
      if (options.length) continue

      // 文本：已有的值
      if (f.type === 'text') {
        const values = ctx.values[`${k.id}.${field}`] ?? []
        values.forEach((v, i) => {
          if (empty ? i >= 5 || !f.list : !matches(`${name} ${v}`, tokens)) return
          const exact = !empty && norm(input) === norm(v)
          const score = empty ? 50 - i : (hitsValue(v) ? 95 : 55) + (exact ? 20 : 0)
          add({ key: `${k.id}.${field}=${v}`, label: uiText("{name}：{value}", { name, value: v }), target, query: eq(k.id, field, v), score })
        })
        if (empty) continue
        // 新的值：写了字段名时都可以；文本列表（标签）不写字段名也可以，作为默认的自由输入
        const typed = valueAfter(input, names)
        const value = typed ?? (f.list && f.format !== 'url' && !startsWithField ? input.trim() : undefined)
        if (!value || values.some((v) => norm(v) === norm(value))) continue
        if (f.format === 'url' && !/^https?:\/\//i.test(value)) continue
        add({
          key: `${k.id}.${field}=new:${value}`,
          label: uiText("{name}：{value}", { name, value: typed ? value : uiText("新建「{value}」", { value }) }),
          target,
          query: eq(k.id, field, value),
          score: typed ? 85 : 30
        })
        continue
      }

      // 数字（包括评分）：写了字段名、后面是数字
      if (f.type === 'number' && !empty) {
        const typed = valueAfter(input, names)
        const n = typed === undefined ? NaN : Number(typed)
        if (!Number.isFinite(n)) continue
        if ((f.min !== undefined && n < f.min) || (f.max !== undefined && n > f.max)) continue
        add({ key: `${k.id}.${field}=${n}`, label: uiText("{name}：{value}", { name, value: f.format === 'rating' ? '★'.repeat(n) : n }), target, query: eq(k.id, field, n), score: 85 })
      }
    }
  }

  // 配方：带写入条件的视图，放入它 = 一次写上全部写入条件
  for (const v of ctx.views) {
    const split = splitConditions(v.query, ctx.kindOf)
    if (!split || split.write.length + split.attach.length === 0) continue
    if (!empty && !matches(uiText("视图 配方 {title}", { title: String(v.title) }), tokens)) continue
    const exact = !empty && norm(input) === norm(v.title)
    add({ key: `view:${v.id}`, label: uiText("放入「{title}」", { title: String(v.title) }), target: uiText("视图"), query: v.query, score: (empty ? 60 : 92) + (exact ? 20 : 0) })
  }

  const seen = new Set<string>()
  return out
    .filter((s) => !seen.has(s.key) && seen.add(s.key))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}

/** 需要哪些文本字段的已有取值（打开快速附加时取一次）。 */
export function valueFields(kinds: BlockKind[]): { kind: string; field: string }[] {
  return kinds.filter(attachable).flatMap((k) =>
    Object.entries(k.fields)
      .filter(([, f]) => attachableField(f) && f.type === 'text')
      .map(([field]) => ({ kind: k.id, field }))
  )
}
