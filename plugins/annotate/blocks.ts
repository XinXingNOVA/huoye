import { isContentLocator } from '@resource-manager/plugin-api/content-selection'
import type { BlockKind } from '@resource-manager/plugin-api/blocks'

/**
 * 锚点的类型。值的结构由类型决定：图片区域用 x、y、w、h，时间段用 start、end，
 * 文本区间用原文片段和前后文（quote、prefix、suffix，offset 只是提示）。
 * 怎么从原素材取出这一部分（裁图、截帧、找那一句），由原素材的媒体插件负责（设计文档 11.2）。
 */
export const ANCHOR_TYPES = ['图片区域', '时间段', '文本区间', 'PDF摘录', '内容摘录'] as const

export interface PdfRect { x: number; y: number; w: number; h: number }
export interface PdfFragment { page: number; quote: string; rects: PdfRect[] }

/**
 * 锚点块：局部自己成为一个身份，这块数据说明它是谁的哪一部分（设计文档 4.5、11.2）。
 * 依附引用原素材：原素材进回收站，局部跟着进去。
 * 内容类：局部和素材一样出现在"全部"里，能挂笔记、标签、模板，能被搜索——收藏的常常不是整个素材，而是其中一块。
 * 区域用原图的比例坐标（0~1），和显示的大小无关；时间段用秒。
 */
export const anchorBlock: BlockKind = {
  id: 'anchor',
  display: { title: 'quote', summary: 'quote', priority: 20 },
  plugin: 'annotate',
  title: '局部',
  rebuildable: false,
  content: true,
  version: 3,
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
    locator: { type: 'json', title: '来源位置' },
    quote: { type: 'longtext', title: '原文', search: true },
    prefix: { type: 'text', title: '前文' },
    suffix: { type: 'text', title: '后文' },
    offset: { type: 'number', title: '位置' },
    /** PDF 摘录：可跨页，每页若干比例矩形；保留原文和文件指纹，文件变化时不误画。 */
    page: { type: 'number', title: '起始页', min: 1 },
    fragments: { type: 'json', title: 'PDF 页内位置' },
    sourceHash: { type: 'text', title: '原文件指纹' },
    /** 局部的宽高比（区域按原图像素算，时间段就是视频的）：卡片在缩略图出来之前就按它占位。 */
    aspect: { type: 'number', title: '宽高比' }
  },
  validate(data) {
    if(data.type === '内容摘录') {
      if(!data.target || typeof data.quote !== 'string' || !data.quote.trim() || !isContentLocator(data.locator)) throw new Error('内容摘录缺少原文或有效来源位置')
      return
    }
    if (data.type !== 'PDF摘录') return
    if (!data.target || typeof data.quote !== 'string' || !data.quote.trim() || typeof data.sourceHash !== 'string' || !data.sourceHash) throw new Error('PDF 摘录缺少原文或来源')
    if (!Array.isArray(data.fragments) || !data.fragments.length) throw new Error('PDF 摘录缺少页内位置')
    let previous = 0
    for (const f of data.fragments) {
      if (!Number.isInteger(f?.page) || f.page <= previous || typeof f.quote !== 'string' || !f.quote.trim() || !Array.isArray(f.rects) || !f.rects.length) throw new Error('PDF 摘录页码或原文无效')
      previous = f.page
      for (const r of f.rects) {
        if (!r || ![r.x, r.y, r.w, r.h].every((v) => typeof v === 'number' && Number.isFinite(v)) || r.x < 0 || r.y < 0 || r.w <= 0 || r.h <= 0 || r.x + r.w > 1.00001 || r.y + r.h > 1.00001) throw new Error('PDF 标记超出页面')
      }
    }
    if (data.page !== data.fragments[0].page) throw new Error('PDF 摘录起始页不匹配')
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

/** 本插件的全部静态定义，由核心和界面共同登记。 */
export const blocks: BlockKind[] = [anchorBlock, placeBlock]
