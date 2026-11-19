import { copyFile } from 'node:fs/promises'
import { posix } from 'node:path'
import type { CorePlugin } from '@resource-manager/plugin-api/core/contracts'
import { blocks, anchorBlock } from './blocks'
import { anchorV1, anchorV2 } from './schemas'
import { formatDuration } from '@resource-manager/plugin-api/format'

/** 局部的代表图最长边：够缩略图和检查器用，不存原图那么大。 */
const MAX_SIDE = 1200

/**
 * 批注插件：局部是一个身份（锚点块 + 笔记、标签……）。
 * 它把原素材的代表图裁出这一块，作为局部自己的代表图；缩略图、色板由预览插件照常接上（设计文档 8.6）。
 */
export const annotatePlugin: CorePlugin = {
  id: 'annotate',
  version: 1,
  blocks,
  dataLifecycle: {
    version: 1,
    disposableRecords: ['anchor'],
    retainedEffects: ['清理局部批注不会删除原素材或原文件；挂有笔记、标签等其他插件数据的局部记录会保留。']
  },
  exportSections: [{
    id: 'annotate.anchor', kind: 'anchor', fields: Object.keys(anchorBlock.fields), order: 10,
    render(data) {
      const quoted = data.type === '文本区间' || data.type === 'PDF摘录' || data.type === '内容摘录'
      const parts: string[] = []
      if (quoted) parts.push(`“${String(data.quote ?? '')}”`)
      if (data.type === 'PDF摘录') {
        const pages = (data.fragments as { page: number }[]).map(fragment => fragment.page)
        parts.push(`PDF 第 ${pages.join('、')} 页`)
      }
      if (data.type === '时间段') parts.push(`${formatDuration(Number(data.start))}–${formatDuration(Number(data.end))}`)
      const inline = parts.join(' —— ')
      return { inline, markdown: quoted ? inline : undefined, content: quoted }
    }
  }],
  // v3 只新增通用内容位置，旧局部字段和枚举原样兼容。
  compatibleSchemas: [anchorV1, anchorV2],
  systems: [
    {
      id: 'annotate.still',
      // 图片、视频的代表图是 10、12；局部身上没有图片块、视频块，由这里负责
      priority: 14,
      has: ['anchor'],
      // 原图的代表图换了（文件被替换），重新裁
      targetInputs: ['still'],
      match: (b) => b.anchor.data.type === '图片区域',
      outputs: ['still'],
      concurrency: 2,
      async run(ctx, id, b) {
        const a = b.anchor.data
        const target = ctx.blocksOf(String(a.target))
        const src = target.still?.data.path
        if (!src) throw new Error('原素材还没有代表图')
        const rel = posix.join(ctx.cacheDir('locals'), `${id}.jpg`)
        await ctx.images.crop({ source: String(src), destination: rel,
          region: { x: Number(a.x), y: Number(a.y), w: Number(a.w), h: Number(a.h) },
          maxSide: MAX_SIDE, quality: 88 }, ctx.signal)
        // 来源序号取锚点和原图代表图的序号之和：两者只增不减，任何一个变了它就变，下游（缩略图、色板）才会重算
        return { still: { path: rel, source: b.anchor.seq + target.still.seq } }
      }
    }
  ],
  // 导出：图片局部、视频片段写出裁好的那一块（代表图）；摘句没有文件，写在索引里
  exporters: [
    {
      priority: 10,
      match: (b) => !!b.anchor && !!b.still,
      place: (_b, title) => ({ folder: '局部', name: `${title}.jpg` }),
      async write(ctx, _id, b, dest) {
        await copyFile(ctx.abs(String(b.still.data.path)), dest)
      }
    }
  ],
  aspect: {
    priority: 30,
    get: (b) => {
      const a = b.anchor?.data.aspect
      return a ? Number(a) : undefined
    }
  }
}

export { annotatePlugin as plugin }
