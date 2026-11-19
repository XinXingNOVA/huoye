// Markdown 的纯文字：去掉记号，只留下读得到的字。摘要、文本区间批注的失配检查共用。

import { stripWikiLinks } from './wikilink'

/** Markdown 链接里的路径：空格、括号转义，汉字照留（Obsidian、Typora 都认）。 */
export const mdPath = (p: string) => p.replace(/ /g, '%20').replace(/\(/g, '%28').replace(/\)/g, '%29')

/** 能直接嵌进 Markdown 里显示的图。 */
export const isImagePath = (p: string) => /\.(png|jpe?g|gif|webp|avif|svg|bmp)$/i.test(p)

/** Markdown 去掉记号，只留下读得到的字（摘要用）。 */
export function plainOfMarkdown(md: string): string {
  return stripWikiLinks(md)
    .replace(/^```.*$/gm, '')
    .replace(/^\s*\|?\s*:?-{3,}.*$/gm, '')
    .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+(\[[ xX]\]\s+)?|\d+\.\s+)/gm, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|~~|`)/g, '')
    .replace(/(^|[^\w*])\*(?!\s)([^*\n]+?)\*/g, '$1$2')
    .replace(/\s*\|\s*/g, ' ')
}
