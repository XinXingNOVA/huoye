import { z } from 'zod'
import type { IngestMetadataDefinition } from '@resource-manager/plugin-api/ingest'

export const ingestMetadata: IngestMetadataDefinition[] = [{
  id: 'note.initial', title: '导入时补充笔记',
  description: '只在笔记不存在或为空白时填入文字，保留 Markdown 原始空白；已有不同笔记保留并返回 preserved。覆盖请另行使用 set_note 和 expectedSeq。',
  input: z.object({ text: z.string().min(1).max(32000).refine(s => !!s.trim(), '笔记不能全为空白') }).strict(),
  apply(ctx, input) {
    const current = ctx.blocksOf().note?.data, text = input.text as string
    if (current?.text === text) return { status: 'unchanged' }
    if (String(current?.text ?? '').trim()) return { status: 'preserved', message: '已保留原有笔记；新笔记未写入' }
    ctx.put('note', { ...current, text })
    return { status: 'applied' }
  }
}]
