import type { BlockKind } from '@resource-manager/plugin-api/blocks'

export const blocks: BlockKind[] = [
  {
    id: 'epub', plugin: 'epub', title: '电子书', rebuildable: true, version: 1,
    fields: {
      title: { type: 'text', title: '书名', search: true }, author: { type: 'text', title: '作者', search: true, index: true },
      language: { type: 'text', title: '语言', index: true }, publisher: { type: 'text', title: '出版社', search: true },
      description: { type: 'longtext', title: '简介', search: true }, sourceHash: { type: 'text', title: '原文件指纹' },
      chapters: { type: 'json', title: '章节' }, toc: { type: 'json', title: '目录' }, characters: { type: 'number', title: '文字长度' },
      documents: { type: 'text', list: true, file: true, title: '章节缓存' }, assets: { type: 'text', list: true, file: true, title: '图片缓存' },
      cover: { type: 'text', title: '封面路径' }, warnings: { type: 'text', list: true, title: '阅读提示' }
    }
  },
  {
    id: 'epubtext', plugin: 'epub', title: '电子书正文', rebuildable: true, version: 1,
    fields: { content: { type: 'longtext', title: '正文', search: true }, truncated: { type: 'boolean', title: '搜索正文已截断' }, sourceHash: { type: 'text', title: '原文件指纹' } }
  },
  {
    id: 'epubreading', plugin: 'epub', title: '电子书阅读进度', rebuildable: false, history: false, captured: true, version: 1,
    fields: {
      sourceHash: { type: 'text', title: '原文件指纹' }, chapter: { type: 'text', title: '章节路径' },
      offset: { type: 'number', title: '章节文字位置', min: 0 }, progress: { type: 'number', title: '全书进度', min: 0, max: 1 },
      lastRead: { type: 'date', title: '最后阅读', index: true }
    }
  },
  {
    id: 'epubbookmarks', plugin: 'epub', title: '电子书书签', rebuildable: false, captured: true, version: 1,
    fields: { items: { type: 'json', title: '书签列表' } }
  }
]
