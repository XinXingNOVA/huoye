import type { BlockKind } from '@resource-manager/plugin-api/blocks'

// 历史契约不可随当前定义修改；v1 到 v2 只增加 PDF 类型及字段。
export const anchorV1: BlockKind = {
  id: 'anchor',
  plugin: 'annotate',
  title: '局部',
  rebuildable: false,
  content: true,
  version: 1,
  fields: {
    target: { type: 'ref', title: '原素材', ref: 'attach', index: true },
    type: { type: 'enum', title: '类型', options: ['图片区域', '时间段', '文本区间'], index: true },
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

export const anchorV2: BlockKind = {
  id: 'anchor',
  display: { title: 'quote', summary: 'quote', priority: 20 },
  plugin: 'annotate',
  title: '局部',
  rebuildable: false,
  content: true,
  version: 2,
  fields: {
    target: { type: 'ref', title: '原素材', ref: 'attach', index: true },
    type: { type: 'enum', title: '类型', options: ['图片区域', '时间段', '文本区间', 'PDF摘录'], index: true },
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
    /** PDF 摘录：可跨页，每页若干比例矩形；保留原文和文件指纹，文件变化时不误画。 */
    page: { type: 'number', title: '起始页', min: 1 },
    fragments: { type: 'json', title: 'PDF 页内位置' },
    sourceHash: { type: 'text', title: '原文件指纹' },
    /** 局部的宽高比（区域按原图像素算，时间段就是视频的）：卡片在缩略图出来之前就按它占位。 */
    aspect: { type: 'number', title: '宽高比' }
  },
  validate(data) {
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
