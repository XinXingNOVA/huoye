import type { BlockKind } from '../../../src/shared/blocks'

/**
 * 来源块：素材从哪里来（设计文档 13.2）。接入时捕获，不可重建。
 * 从浏览器复制一段文字时剪贴板里带着网页地址；以后网页上拖进来的图、浏览器扩展收录的网页也用它。
 */
export const sourceBlock: BlockKind = {
  id: 'source',
  plugin: 'source',
  title: '来源',
  rebuildable: false,
  captured: true,
  version: 1,
  fields: {
    url: { type: 'text', title: '网址', index: true, format: 'url' },
    /** 网站（域名，去掉 www.）：侧栏按它筛选。 */
    site: { type: 'text', title: '网站', index: true, search: true },
    title: { type: 'text', title: '页面标题', search: true }
  }
}

/** 网址 → 网站。不是网页地址时返回 undefined。 */
export function siteOf(url: string): string | undefined {
  try {
    const u = new URL(url)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined
    return u.hostname.replace(/^www\./, '')
  } catch {
    return undefined
  }
}

/** 本插件的全部静态定义，由核心和界面共同登记。 */
export const blocks: BlockKind[] = [sourceBlock]
