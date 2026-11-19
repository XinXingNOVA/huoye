import type { BlockKind, Blocks } from './blocks'

type DefinitionOf = (id: string) => BlockKind | undefined
const line = (v: unknown, markdown = false): string => {
  if (typeof v !== 'string') return ''
  const text = v.trim().split('\n')[0]
  return (markdown ? text.replace(/^#+\s*/, '') : text).slice(0, 100)
}

/** 声明优先；旧快照没有 display 时按值类型回退。无需认识具体数据块 ID。 */
export function summaryTitle(blocks: Blocks, kindOf: DefinitionOf, id?: string): string {
  const entries = Object.entries(blocks).map(([kind, block]) => ({ kind, block, def: kindOf(kind) }))
    .sort((a, b) => (a.def?.display?.priority ?? 1000) - (b.def?.display?.priority ?? 1000) || a.kind.localeCompare(b.kind))
  for (const { block, def } of entries) {
    const title = def?.display?.title && line(block.data[def.display.title], def.fields[def.display.title]?.format === 'markdown')
    if (title) return title
  }
  for (const { block, def } of entries.filter(e => e.def && !e.def.rebuildable && (e.def.content || e.def.standalone))) {
    for (const [field, f] of Object.entries(def!.fields)) {
      if (f.file || f.list || (f.type !== 'text' && f.type !== 'longtext')) continue
      const title = line(block.data[field], f.format === 'markdown')
      if (title) return title
    }
  }
  const management = entries.find(e => e.def?.management)
  if (management?.def) return management.def.title
  const label = entries.find(e => e.def?.content || e.def?.standalone) ?? entries[0]
  return `${label?.def?.title ?? label?.kind ?? '记录'}${id ? ` · ${id.slice(-6)}` : ''}`
}

/** 通用卡片的短摘要；完整内容始终由详情展示。 */
export function summaryText(blocks: Blocks, kindOf: DefinitionOf): string {
  for (const [kind, block] of Object.entries(blocks)) {
    const def = kindOf(kind)
    const field = def?.display?.summary ?? Object.keys(def?.fields ?? {}).find(f => def!.fields[f].type === 'longtext')
    const value = field && block.data[field]
    if (typeof value === 'string' && value.trim()) return value.slice(0, 500)
  }
  return Object.keys(blocks).map(k => kindOf(k)?.title ?? k).join(' · ')
}

/** 自动化读取的有界名称候选；不改变显示标题，也不硬编码业务数据块。 */
export function titleCandidates(blocks: Blocks, kindOf: DefinitionOf, kinds?: string[]) {
  return Object.entries(blocks)
    .map(([kind, block]) => ({ kind, block, def: kindOf(kind) }))
    .filter(({ kind, def }) => (!kinds || kinds.includes(kind)) && !!def?.display?.title)
    .sort((a, b) => (a.def?.display?.priority ?? 1000) - (b.def?.display?.priority ?? 1000) || a.kind.localeCompare(b.kind))
    .flatMap(({ kind, block, def }) => {
      const field = def!.display!.title!, value = block.data[field]
      if (typeof value !== 'string') return []
      // 只取首行的有界前缀，不复制整份正文。后续可通过 kind/field 精确读取。
      const prefix = value.slice(0, 301), end = prefix.indexOf('\n'), first = end < 0 ? prefix : prefix.slice(0, end)
      const text = first.slice(0, 300).trim()
      return text ? [{ kind, field, text, truncated: value.length > (end < 0 ? Math.min(300, value.length) : end) }] : []
    }).slice(0, 8)
}
