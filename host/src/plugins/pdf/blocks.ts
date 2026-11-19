import type { BlockData, BlockKind } from '../../shared/blocks'

/** PDF 块：页数、第一页的大小（点，1/72 英寸）、标题作者。从文件读出，可重建。 */
export const pdfBlock: BlockKind = {
  id: 'pdf',
  plugin: 'pdf',
  title: 'PDF',
  rebuildable: true,
  version: 1,
  fields: {
    pages: { type: 'number', title: '页数', index: true },
    width: { type: 'number', title: '页宽' },
    height: { type: 'number', title: '页高' },
    title: { type: 'text', title: '标题', search: true },
    author: { type: 'text', title: '作者', index: true, search: true }
  }
}

/**
 * PDF 的文字：每一页抽出来接在一起，全文搜索用（扫描版没有文字就没有这一块）。
 * pages 是每一页从第几个字开始：找到的词在第几页。
 */
export const pdfTextBlock: BlockKind = {
  id: 'pdftext',
  plugin: 'pdf',
  title: 'PDF 正文',
  rebuildable: true,
  version: 1,
  fields: {
    content: { type: 'longtext', title: '文字', search: true, pageOffsets: 'pages' },
    pages: { type: 'json', title: '分页' },
    source: { type: 'number', title: '来源序号' }
  }
}

/** 每份 PDF 的续读位置。行为记录不占用撤销历史；缩放仍归本机标签页。 */
export const pdfReadingBlock: BlockKind = {
  id: 'pdfreading', plugin: 'pdf', title: 'PDF 阅读进度',
  rebuildable: false, history: false, captured: true, version: 1,
  fields: {
    page: { type: 'number', title: '读到页码', min: 1 },
    offset: { type: 'number', title: '页内位置', min: 0, max: 1 },
    lastRead: { type: 'date', title: '最后阅读', index: true }
  },
  validate(data) {
    if (!Number.isInteger(data.page)) throw new Error('阅读页码应为正整数')
  }
}

/** 第几个字在第几页（从 1 开始）。 */
export function pageAt(starts: number[], offset: number): number {
  let page = 1
  for (let i = 0; i < starts.length; i++) if (starts[i] <= offset) page = i + 1
  return page
}


export interface ReadingPosition { page: number; offset: number }

/** 页数可能因文件替换改变，旧位置只在合法范围内恢复。 */
export function readingPosition(data: BlockData | undefined, pages: number): ReadingPosition {
  const page = Number(data?.page), offset = Number(data?.offset)
  return {
    page: Math.max(1, Math.min(Math.max(1, pages), Number.isFinite(page) ? Math.floor(page) : 1)),
    offset: Number.isFinite(offset) ? Math.max(0, Math.min(1, offset)) : 0
  }
}

/** 本插件的全部静态定义，由核心和界面共同登记。 */
export const blocks: BlockKind[] = [pdfBlock, pdfTextBlock, pdfReadingBlock]
