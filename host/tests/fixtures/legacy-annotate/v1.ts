import type { BlockKind } from '../../../src/shared/blocks'

/**
 * 锚点的类型。值的结构由类型决定：图片区域用 x、y、w、h，时间段用 start、end，
 * 文本区间用原文片段和前后文（quote、prefix、suffix，offset 只是提示）。
 * 怎么从原素材取出这一部分（裁图、截帧、找那一句），由原素材的媒体插件负责（设计文档 11.2）。
 */
export const ANCHOR_TYPES = ['图片区域', '时间段', '文本区间'] as const

/**
 * 锚点块：局部自己成为一个身份，这块数据说明它是谁的哪一部分（设计文档 4.5、11.2）。
 * 依附引用原素材：原素材进回收站，局部跟着进去。
 * 内容类：局部和素材一样出现在"全部"里，能挂笔记、标签、模板，能被搜索——收藏的常常不是整个素材，而是其中一块。
 * 区域用原图的比例坐标（0~1），和显示的大小无关；时间段用秒。
 */
export const anchorBlock: BlockKind = {
  id: 'anchor',
  plugin: 'annotate',
  title: '局部',
  rebuildable: false,
  content: true,
  version: 1,
  fields: {
    target: { type: 'ref', title: '原素材', ref: 'attach', index: true },
    type: { type: 'enum', title: '类型', options: [...ANCHOR_TYPES], index: true },
    x: { type: 'number', title: '左' },
    y: { type: 'number', title: '上' },
    w: { type: 'number', title: '宽' },
    h: { type: 'number', title: '高' },
    start: { type: 'number', title: '起点', format: 'duration' },
    end: { type: 'number', title: '终点', format: 'duration' },
    /**
     * 文本区间：存原文片段而不只是位置——原文改了以后按片段（加上前后文分辨重复的）重新找到它。
     * 位置是排好版的文字里的字符位置（不含链接、嵌入），只用来在几处一样的片段里挑最近的。
     */
    quote: { type: 'longtext', title: '原文', search: true },
    prefix: { type: 'text', title: '前文' },
    suffix: { type: 'text', title: '后文' },
    offset: { type: 'number', title: '位置' },
    /** 局部的宽高比（区域按原图像素算，时间段就是视频的）：卡片在缩略图出来之前就按它占位。 */
    aspect: { type: 'number', title: '宽高比' }
  }
}

/**
 * 定位块：局部在原素材里还找不找得到（失配检测，设计文档 11.10）。可重建。
 * 由认识原素材的插件检查（文字插件按原文片段找那一句）；原素材变了就重新检查。
 */
export const placeBlock: BlockKind = {
  id: 'place',
  plugin: 'annotate',
  title: '定位',
  rebuildable: true,
  version: 1,
  fields: {
    found: { type: 'boolean', title: '找得到', index: true }
  }
}
