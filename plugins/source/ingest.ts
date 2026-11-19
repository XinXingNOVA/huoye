import { z } from 'zod'
import type { IngestMetadataDefinition } from '@resource-manager/plugin-api/ingest'
import { siteOf } from './blocks'

export const ingestMetadata: IngestMetadataDefinition[] = [{
  id: 'source.initial', title: '导入时补充来源',
  description: '仅在来源未记录时补充 HTTP/HTTPS 网址与可选标题；已有来源保留，返回 unchanged 或 preserved，不覆盖用户记录。',
  input: z.object({
    url: z.string().trim().min(1).max(2048).refine(url => !!siteOf(url), '来源应为 HTTP 或 HTTPS 网页地址'),
    title: z.string().trim().max(200).optional()
  }).strict(),
  apply(ctx, input) {
    const current = ctx.blocksOf().source?.data
    const url = input.url as string, title = input.title as string | undefined
    if (current?.url) {
      return current.url === url && (title === undefined || current.title === title)
        ? { status: 'unchanged' } : { status: 'preserved', message: '已保留原有来源；新来源未写入' }
    }
    ctx.put('source', { ...current, url, site: siteOf(url)!, ...(title ? { title } : {}) })
    return { status: 'applied' }
  }
}]
