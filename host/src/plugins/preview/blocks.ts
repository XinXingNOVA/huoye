import type { BlockKind } from '../../shared/blocks'

/**
 * 代表图块：媒体插件与通用加工之间的接口（设计文档 8.6）。
 * 图片直接指向原图；视频截一帧；PDF 渲染第一页；音频取出内嵌封面。
 * 缩略图、色板以及以后的 OCR、语义向量只认它，不关心素材原本是什么媒体。
 * 有多个产出者（每种媒体插件一个），在每个身份上按优先级只有一个生效。
 */
export const stillBlock: BlockKind = {
  id: 'still',
  plugin: 'preview',
  title: '代表图',
  rebuildable: true,
  display: { inspector: false },
  version: 1,
  fields: {
    path: { type: 'text', title: '库内路径', file: true },
    /** 生成它的输入块的写入序号：路径不变而内容变了时，数据也跟着变，下游才会重算。 */
    source: { type: 'number', title: '来源序号' },
    /** 取自视频的哪个时间点（秒）。 */
    at: { type: 'number', title: '时间点', format: 'duration' }
  }
}

/** 缩略图块：派生文件缓存中的缩略图。 */
export const thumbBlock: BlockKind = {
  id: 'thumb',
  plugin: 'preview',
  title: '缩略图',
  rebuildable: true,
  display: { inspector: false },
  version: 1,
  fields: {
    path: { type: 'text', title: '缓存路径', file: true },
    width: { type: 'number', title: '宽', format: 'px' },
    height: { type: 'number', title: '高', format: 'px' },
    source: { type: 'number', title: '来源序号' }
  }
}

export const blocks: BlockKind[] = [stillBlock, thumbBlock]
