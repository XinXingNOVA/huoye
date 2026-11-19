import { copyFile } from 'node:fs/promises'
import { posix } from 'node:path'
import sharp from 'sharp'
import type { CorePlugin } from '../../../src/plugin-api/core/contracts'
import { blocks, anchorBlock } from './blocks'
import { formatDuration } from '../../../src/shared/format'

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
  exportSections: [{
    id: 'annotate.anchor', kind: 'anchor', fields: Object.keys(anchorBlock.fields), order: 10,
    render(data) {
      const quoted = data.type === '文本区间' || data.type === 'PDF摘录'
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
  // v2 只新增 PDF 字段，已有图片、视频和文字锚点保持原样。
  migrations: { anchor: (data) => data },
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
        const input = sharp(ctx.abs(String(src)), { animated: false }).rotate()
        const meta = await input.metadata()
        // rotate() 按 EXIF 方向转正后，宽高可能互换
        const turned = (meta.orientation ?? 1) >= 5
        const W = (turned ? meta.height : meta.width) ?? 0
        const H = (turned ? meta.width : meta.height) ?? 0
        if (!W || !H) throw new Error('读不到原素材的尺寸')
        const left = Math.max(0, Math.floor(Number(a.x) * W))
        const top = Math.max(0, Math.floor(Number(a.y) * H))
        const width = Math.max(1, Math.min(W - left, Math.round(Number(a.w) * W)))
        const height = Math.max(1, Math.min(H - top, Math.round(Number(a.h) * H)))
        const rel = posix.join(ctx.cacheDir('locals'), `${id}.jpg`)
        await sharp(await input.toBuffer())
          .extract({ left, top, width, height })
          .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 88 })
          .toFile(ctx.abs(rel))
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
