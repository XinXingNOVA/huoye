// 双链（设计文档 11.9）：文字里的 [[目标]]、[[目标|显示的字]]；前面加 ! 是嵌入（![[目标]]）。
// 目标是身份 ID（选择器插入的，素材改名、重名都不影响），也认文件名（从 Obsidian 带过来的文档里的 ![[pic.png]]）。
// 核心进程（解析出链接，建反向引用）和界面（显示、插入）共用。

export interface WikiLink {
  embed: boolean
  target: string
  label?: string
  /** 在原文里的位置。 */
  index: number
  length: number
}

const PATTERN = /(!?)\[\[([^[\]|\n]+?)(?:\|([^[\]\n]*))?\]\]/g

/** 身份 ID（ULID：26 个 Crockford base32 字符）。 */
export const isEntityId = (s: string) => /^[0-9A-HJKMNP-TV-Z]{26}$/.test(s)

export function parseWikiLinks(text: string): WikiLink[] {
  const out: WikiLink[] = []
  for (const m of text.matchAll(PATTERN)) {
    const label = m[3]?.trim()
    out.push({ embed: m[1] === '!', target: m[2].trim(), label: label || undefined, index: m.index!, length: m[0].length })
  }
  return out
}

/** 从某个位置开始的一个链接（Markdown 渲染时逐个认）。 */
export function wikiLinkAt(text: string, pos: number): WikiLink | undefined {
  const re = new RegExp(PATTERN.source, 'y')
  re.lastIndex = pos
  const m = re.exec(text)
  if (!m) return undefined
  const label = m[3]?.trim()
  return { embed: m[1] === '!', target: m[2].trim(), label: label || undefined, index: pos, length: m[0].length }
}

/** 写进文字里的样子。显示的字里不能有方括号、竖线、换行。 */
export function wikiLinkText(id: string, label: string, embed = false): string {
  const clean = label.replace(/[[\]|\n]+/g, ' ').replace(/\s+/g, ' ').trim()
  return `${embed ? '!' : ''}[[${id}${clean ? `|${clean}` : ''}]]`
}

/** 显示时的字：写了显示的字就用它；目标是文件名就用文件名；只有 ID 时没有字。 */
export const wikiLinkLabel = (l: Pick<WikiLink, 'target' | 'label'>) => l.label ?? (isEntityId(l.target) ? '' : l.target)

/** 去掉链接（文本区间批注的坐标里不含链接、嵌入：它们显示的字会变）。 */
export const removeWikiLinks = (text: string) => text.replace(PATTERN, '')

/** 把链接换成它显示的字（标题、摘要、字数用）。 */
export function stripWikiLinks(text: string): string {
  return text.replace(PATTERN, (_m, _bang, target: string, label?: string) => wikiLinkLabel({ target: target.trim(), label: label?.trim() || undefined }))
}
