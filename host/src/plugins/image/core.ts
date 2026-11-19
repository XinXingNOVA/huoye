import sharp from 'sharp'
import type { CorePlugin } from '../../plugin-api/core/contracts'
import { blocks, IMAGE_EXTS } from './blocks'

export const imagePlugin: CorePlugin = {
  id: 'image',
  version: 2,
  blocks,
  systems: [
    {
      // 读文件头取宽高：很快，最先做，让网格尽早拿到正确的宽高比
      id: 'image.probe',
      priority: 0,
      has: ['file'],
      // 只看文件的内容：改名不重做（设计文档 11.14）
      inputs: ['file.hash'],
      match: (b) => IMAGE_EXTS.has(String(b.file.data.ext)),
      outputs: ['image'],
      async run(ctx, _id, b) {
        const meta = await sharp(ctx.abs(String(b.file.data.path))).metadata()
        if (!meta.width || !meta.height) throw new Error('读不到图片尺寸')
        // EXIF 方向 5~8 表示旋转了 90°，显示时宽高互换
        const rotated = (meta.orientation ?? 1) >= 5
        return {
          image: {
            width: rotated ? meta.height : meta.width,
            height: rotated ? meta.width : meta.height,
            animated: (meta.pages ?? 1) > 1
          }
        }
      }
    },
    {
      // 图片的代表图就是原图本身，不产生新文件；指向原文件的路径，所以改名后要跟着改
      id: 'image.still',
      priority: 10,
      has: ['file', 'image'],
      inputs: ['file'],
      outputs: ['still'],
      async run(_ctx, _id, b) {
        return { still: { path: String(b.file.data.path), source: b.file.seq } }
      }
    }
  ],
  aspect: {
    priority: 10,
    get: (b) => {
      const img = b.image?.data
      return img ? Number(img.width) / Number(img.height) : undefined
    }
  }
}

export { imagePlugin as plugin }
