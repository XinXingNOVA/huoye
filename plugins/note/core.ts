import { ingestMetadata } from './ingest'
import type { CommandContext, CorePlugin } from '@resource-manager/plugin-api/core/contracts'
import { parseInput } from '@resource-manager/plugin-api/operations'
import { blocks } from './blocks'
import { setNoteSchema } from './lib/input'

/**
 * 写笔记：只动 note 块，保留原文（缩进和末尾换行属于 Markdown 内容，不能 trim 掉）。
 * expectedSeq 由调用方从 read_item 的 note 字段取来，能挡住“读完到写之间又被改过”的覆盖。
 */
function setNote(ctx: CommandContext, input: Record<string, unknown>) {
  const { id, text, expectedSeq } = parseInput(setNoteSchema, input)
  if (!ctx.query({ ids: [id] }).ids.includes(id)) throw new Error('[NOT_FOUND] 素材不存在或已在回收站')
  const current = ctx.blocksOf(id).note
  if (expectedSeq !== undefined && (current?.seq ?? null) !== expectedSeq) {
    throw new Error(current
      ? `[NOTE_CHANGED] 笔记已变化（当前 seq ${current.seq}），请重新读取后再写`
      : '[NOTE_CHANGED] 笔记已被删除，请重新读取后再写')
  }
  if (!text.trim()) {
    if (current) ctx.remove(id, 'note')
    return { label: '删除笔记', result: { id, seq: null } }
  }
  ctx.put(id, 'note', { ...(current?.data ?? {}), text })
  return { label: '写入笔记', result: { id, seq: ctx.blocksOf(id).note?.seq ?? null } }
}

export const notePlugin: CorePlugin = {
  id: 'note',
  version: 1,
  blocks,
  dataLifecycle: {
    version: 1,
    disposableRecords: [],
    retainedEffects: ['只摘除素材上的笔记属性，素材本身与其他数据保留；仅含笔记而无主体的混合记录会保留。']
  },
  ingestMetadata,
  commands: { setNote },
  operations: [{
    name: 'set_note', effect: 'data',
    title: '写入笔记',
    command: 'setNote',
    input: setNoteSchema,
    description: '给一项素材写入或替换笔记；text 为空白时删除笔记。建议先 read_item（kinds 含 note）取得笔记的 seq，作为 expectedSeq 传入；内容在读取后被改过会拒绝写入，避免覆盖用户刚写的笔记。返回新的 seq，可在应用内整体撤销。'
  }],
  exportSections: [{
    id: 'note.text', kind: 'note', fields: ['text'], order: 20,
    render(data) {
      const text = String(data.text ?? '').trim()
      return { properties: text ? [{ field: 'text', label: '笔记', value: text, index: false }] : [],
        markdown: text ? text.split('\n').map(line => `> ${line}`).join('\n') : undefined,
        inline: text.replace(/\n+/g, ' ') }
    }
  }]
}

export { notePlugin as plugin }
