import { ingestMetadata } from './ingest'
import type { CorePlugin } from '@resource-manager/plugin-api/core/contracts'
import { blocks, siteOf } from './blocks'

/**
 * 来源插件：接入时输入里带着来源（网页地址），就给新建的身份记下来源块。
 * 它不认识任何一种素材：文字、图片、文件，谁带着来源都一样。
 */
export const sourcePlugin: CorePlugin = {
  id: 'source',
  version: 1,
  blocks,
  dataLifecycle: {
    version: 1,
    disposableRecords: [],
    retainedEffects: ['只摘除素材上的来源网址与站点属性，素材原件保留；保存视图中的来源筛选条件保留。']
  },
  ingestMetadata,
  afterIngest(ctx, id, input, created) {
    // 识别为已有内容时不改：第一次收录的来源才是它的来源
    if (input.metadata?.['source.initial'] !== undefined) return
    const url = input.source?.url?.trim()
    const site = url && siteOf(url)
    if (!created || !url || !site) return
    const title = input.source?.title?.trim()
    ctx.put(id, 'source', { url, site, ...(title ? { title } : {}) })
  }
}

export { sourcePlugin as plugin }
