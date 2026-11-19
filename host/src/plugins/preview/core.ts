// 预览插件：不认识任何媒体，只处理代表图。
// 任何媒体插件产出代表图后，自动得到缩略图。

import { posix } from 'node:path'
import { randomUUID } from 'node:crypto'
import { rename, rm } from 'node:fs/promises'
import sharp from 'sharp'
import type { CorePlugin } from '../../plugin-api/core/contracts'
import { blocks } from './blocks'

const THUMB_SIZE = 640

// 派生文件发布后仍使用同一路径（局部重裁、视频重新截帧后会替换内容）。
// libvips 的操作缓存按文件名命中，会读到重写之前的图，算出旧的色板：关掉（每个文件本来也只处理一次）。
sharp.cache(false)

export const previewPlugin: CorePlugin = {
  id: 'preview',
  version: 1,
  blocks,
  dataLifecycle: { version: 1 },
  systems: [
    {
      id: 'preview.thumb',
      priority: 50,
      has: ['still'],
      outputs: ['thumb'],
      async run(ctx, id, b) {
        const rel = posix.join(ctx.cacheDir('thumbs'), `${id}.webp`)
        const temporary = ctx.abs(`${rel}.${randomUUID()}.tmp`)
        try {
          ctx.signal.throwIfAborted()
          const info = await sharp(ctx.abs(String(b.still.data.path)), { animated: false })
            .rotate()
            .resize({ width: THUMB_SIZE, height: THUMB_SIZE, fit: 'inside', withoutEnlargement: true })
            .webp({ quality: 80 })
            .toFile(temporary)
          ctx.signal.throwIfAborted()
          // 色板读取旧缩略图期间仍保持旧文件完整。
          await rename(temporary, ctx.abs(rel))
          return { thumb: { path: rel, width: info.width, height: info.height, source: b.still.seq } }
        } finally { await rm(temporary, { force: true }) }
      }
    }
  ]
}

export { previewPlugin as plugin }
