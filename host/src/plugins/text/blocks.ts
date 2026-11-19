import type { BlockKind } from '../../shared/blocks'

/**
 * 文本块：一段收录的文字（粘贴、拖进来的摘录，或者自己新建的）。内容类，不可重建，存在库里，没有文件。
 * 内容是 Markdown：网页上复制来的格式（标题、加粗、列表、链接）转成 Markdown 保留；纯文字本身也是 Markdown。
 */
export const textBlock: BlockKind = {
  id: 'text',
  display: { title: 'content', summary: 'content', priority: 50 },
  plugin: 'text',
  title: '文本',
  rebuildable: false,
  content: true,
  version: 1,
  fields: {
    content: { type: 'longtext', title: '内容', search: true, format: 'markdown' }
  }
}

/**
 * 正文块：从文本文件（.md、.txt）里读出来的文字，可重建。文件块才是源头，这里是读出来给显示、搜索用的。
 * 和图片插件读出图片块是一回事：文档是文件，文字插件只是读懂它。
 */
export const bodyBlock: BlockKind = {
  id: 'body',
  plugin: 'text',
  title: '正文',
  rebuildable: true,
  version: 1,
  fields: {
    content: { type: 'longtext', title: '内容', search: true, format: 'markdown' },
    format: { type: 'enum', title: '格式', options: ['markdown', 'plain'], index: true },
    encoding: { type: 'text', title: '编码' },
    source: { type: 'number', title: '来源序号' }
  }
}

/**
 * 链接块：这篇文字提到了谁（[[…]]、![[…]]），从内容里解析出来，可重建。
 * 关联引用（设计文档 4.6）：被提到的进回收站，链接留着；反向引用索引给出"提到它的"。
 */
export const linksBlock: BlockKind = {
  id: 'links',
  plugin: 'text',
  title: '链接',
  rebuildable: true,
  version: 1,
  fields: {
    targets: { type: 'ref', title: '提到', list: true, ref: 'link', index: true }
  }
}

/** 文字插件读得懂的文本文件。 */
export const TEXT_EXTS: Record<string, 'markdown' | 'plain'> = { md: 'markdown', markdown: 'markdown', txt: 'plain' }
/** 再大就不读进库里了（多半不是写给人读的文字）。 */
export const MAX_TEXT_FILE = 2 * 1024 * 1024

/** 本插件的全部静态定义，由核心和界面共同登记。 */
export const blocks: BlockKind[] = [textBlock, bodyBlock, linksBlock]
