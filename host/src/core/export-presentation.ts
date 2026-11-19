import type { Blocks, FieldDef } from '../shared/blocks'
import type { ExportProperty } from '../plugin-api/core/contracts'
import { formatBytes, formatDuration } from '../shared/format'
import type { Registry } from './registry'

const propertyText = (p: ExportProperty) => `${p.label}：${Array.isArray(p.value) ? p.value.join('、') : p.value}`

/** 合并专用片段和未被认领的通用字段；插件关闭或片段失败时不会吞掉字段。 */
export function exportPresentation(reg: Registry, blocks: Blocks, title: (id: string) => string) {
  const properties: ExportProperty[] = [], markdown: string[] = [], inline: string[] = [], problems: string[] = []
  const claimed = new Set<string>()
  const fallback = new Set<string>()
  let content = false
  const sections = reg.plugins.flatMap(p => p.exportSections ?? [])
    .sort((a, b) => (a.order ?? 1000) - (b.order ?? 1000) || a.id.localeCompare(b.id))
  for (const section of sections) {
    const block = blocks[section.kind]
    if (!block) continue
    try {
      const value = section.render(block.data)
      if (!value) continue
      const props = (value.properties ?? []).map(p => ({ ...p, kind: section.kind }))
      const complete = !!value.content && !!value.markdown?.trim()
      // 完整内容在附属列表里也必须写全，不能用短摘要冒充成功。
      const parts = complete ? [value.markdown!] : value.inline !== undefined ? (value.inline ? [value.inline] : []) : props.map(propertyText)
      for (const field of section.fields) claimed.add(`${section.kind}.${field}`)
      properties.push(...props)
      if (value.markdown) markdown.push(value.markdown)
      inline.push(...parts)
      content ||= complete
    } catch (error) {
      for (const field of section.fields) fallback.add(`${section.kind}.${field}`)
      problems.push(`${section.id}：${error instanceof Error ? error.message : String(error)}；字段改用通用输出`)
    }
  }
  const show = (f: FieldDef, value: unknown): string => {
    if (f.type === 'boolean') return value ? '是' : '否'
    if (f.type === 'date') return new Date(Number(value)).toISOString().slice(0, 10)
    if (f.type === 'number') {
      const n = Number(value)
      if (f.format === 'duration') return formatDuration(n)
      if (f.format === 'bytes') return formatBytes(n)
      if (f.format === 'rating') return '★'.repeat(n)
    }
    if (f.type === 'ref') return title(String(value))
    if (f.type === 'json') return JSON.stringify(value)
    return String(value)
  }
  for (const [kind, block] of Object.entries(blocks)) {
    const def = reg.kind(kind)
    if (!def) continue
    const ordinary = !def.rebuildable && !def.content && !def.standalone && def.history !== false
    const fields = Object.entries(def.fields)
    for (const [field, f] of fields) {
      const value = block.data[field]
      if (!ordinary && !fallback.has(`${kind}.${field}`)) continue
      if (claimed.has(`${kind}.${field}`) || value === undefined || value === null || value === '' || (Array.isArray(value) && !value.length)) continue
      const label = fields.length === 1 && def.template === undefined ? def.title : f.title
      const prop = { kind, field, label, value: Array.isArray(value) ? value.map(v => show(f, v)) : show(f, value) }
      properties.push(prop)
      inline.push(propertyText(prop))
    }
  }
  return { properties, markdown, inline, content, problems }
}
