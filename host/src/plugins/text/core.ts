import { saveText } from './lib/save'
import { isContentLocator } from '../../plugin-api/content-selection'
import { readFile, writeFile } from 'node:fs/promises'
import type { CorePlugin, ExportContext } from '../../plugin-api/core/contracts'
import type { Blocks } from '../../shared/blocks'
import { isImagePath, mdPath, plainOfMarkdown } from '../../shared/markdown'
import { isEntityId, parseWikiLinks, removeWikiLinks } from '../../shared/wikilink'
import type { SystemContext } from '../../plugin-api/core/contracts'
import { blocks, MAX_TEXT_FILE, TEXT_EXTS } from './blocks'
import { decodeText } from './lib/decode'
import { htmlToMarkdown } from './lib/html'
import { createText, createTextSchema } from './lib/create'

/** 文字的长短决定卡片的形状：一句话是扁的，长文是高的。 */
function aspectOf(content: string): number {
  const n = content.trim().length
  if (n <= 60) return 2
  if (n <= 240) return 1.4
  if (n <= 800) return 1
  return 0.75
}

const contentOf = (b: Blocks) => b.text?.data.content ?? b.body?.data.content

/** 比较原文片段时忽略空白和 Markdown 记号：片段取自排好版的文字，原文是 Markdown 源文。 */
const squash = (s: string) => s.replace(/[\s*_`#>|~[\]()]/g, '')

/** 一篇文字排好版后读得到的字（不含链接、嵌入，和文本区间批注的坐标一致）。 */
function readable(b: Blocks): string | undefined {
  const content = contentOf(b)
  if (content === undefined) return undefined
  return b.body?.data.format === 'plain' ? String(content) : plainOfMarkdown(removeWikiLinks(String(content)))
}

/**
 * 文字里提到的身份：ID 直接用；文件名按文件块找（Obsidian 的 ![[pic.png]]、[[笔记]] 指 笔记.md）。
 * 找不到的不算。按名字找到的是当时的那个：之后才收录进来的同名文件，要等这篇文字再改时才认得出。
 */
function linkTargets(ctx: SystemContext, self: string, content: string): string[] {
  const out = new Set<string>()
  for (const l of parseWikiLinks(content)) {
    const id = isEntityId(l.target) ? l.target : (ctx.findByField('file', 'name', l.target) ?? ctx.findByField('file', 'name', `${l.target}.md`))
    if (id && id !== self) out.add(id)
  }
  return [...out]
}

/**
 * 导出的 Markdown：[[…]] 换成指向一起导出的文件的链接（图片的嵌入还是嵌入）；没一起导出的只留它的字。
 * from：这篇写到哪个文件夹（链接按它算相对路径）。
 */
function exportLinks(ctx: ExportContext, content: string, from: string): string {
  let out = content
  for (const l of parseWikiLinks(content).reverse()) {
    const id = isEntityId(l.target) ? l.target : (ctx.findByField('file', 'name', l.target) ?? ctx.findByField('file', 'name', `${l.target}.md`))
    const label = (l.label ?? (id ? ctx.title(id) : l.target)).replace(/[[\]]/g, ' ')
    const path = id ? ctx.linkTo(id, from) : undefined
    const md = !path ? label : `${l.embed && isImagePath(path) ? '!' : ''}[${label}](${mdPath(path)})`
    out = out.slice(0, l.index) + md + out.slice(l.index + l.length)
  }
  return out
}

/** YAML 头：属性（标签写成 Obsidian 认得的 tags）、笔记。值都写成带引号的字符串，免得被当成别的类型。 */
function frontMatter(ctx: ExportContext, id: string): string {
  const lines = ctx.properties(id).map((p) => {
    const name = p.key ?? p.label
    const key = /^[\p{L}\p{N}_ -]+$/u.test(name) ? name : JSON.stringify(name)
    return `${key}: ${JSON.stringify(p.value)}`
  })
  return lines.length ? `---\n${lines.join('\n')}\n---\n\n` : ''
}

/**
 * 文字插件：两种文字（设计文档 11.7）。
 * 摘录、随手记是文本块，存在库里；文档是文件（.md、.txt），由文件插件收进来，这里读出正文。
 */
export const textPlugin: CorePlugin = {
  id: 'text',
  version: 1,
  blocks,
  commands: { create: createText, save: saveText },
  operations: [{
    effect: 'data',
    name: 'create_text', title: '创建文字素材', command: 'create', input: createTextSchema,
    description: '在当前仓库新建独立文字素材，content 为纯文本或 Markdown（最多 32000 字符）；可附最多 20 个标签及来源网页。来源只作记录，不抓取网页。返回素材 id，可立即搜索读取，整项可在应用中撤销。新请求使用新 requestId；超时重试复用原值，撤销后重试也不重新创建。'
  }],
  recognizers: [
    {
      id: 'text.paste',
      priority: 100,
      match: (input) => input.type === 'text' && input.text.trim().length > 0,
      async ingest(ctx, input) {
        if (input.type !== 'text') throw new Error('不是文本')
        // 网页上复制来的格式转成 Markdown 保留；没有格式时就是纯文字
        const content = (input.html && htmlToMarkdown(input.html)) || input.text
        const id = ctx.createEntity()
        ctx.put(id, 'text', { content })
        return id
      }
    }
  ],
  systems: [
    {
      // 摘录、随手记里的链接
      id: 'text.links',
      priority: 20,
      has: ['text'],
      outputs: ['links'],
      async run(ctx, id, b) {
        const targets = linkTargets(ctx, id, String(b.text.data.content ?? ''))
        return { links: targets.length ? { targets } : null }
      }
    },
    {
      // 文档正文里的链接（文档的文字在文件里，读出来以后再找）
      id: 'text.doclinks',
      priority: 21,
      has: ['body'],
      outputs: ['links'],
      async run(ctx, id, b) {
        const targets = b.body.data.format === 'markdown' ? linkTargets(ctx, id, String(b.body.data.content ?? '')) : []
        return { links: targets.length ? { targets } : null }
      }
    },
    {
      // 文本区间（批注插件的局部）：原文改了以后还找不找得到那一句（失配检测，设计文档 11.10）。
      // 锚点类型由原素材的媒体插件服务：图片插件裁图、视频插件截帧、文字插件找原文
      id: 'text.anchor',
      priority: 22,
      has: ['anchor'],
      needs: ['annotate'],
      targetInputs: ['text', 'body'],
      match: (b) => b.anchor.data.type === '文本区间' || (b.anchor.data.type === '内容摘录' && isContentLocator(b.anchor.data.locator) && b.anchor.data.locator.provider === 'text.quote' && b.anchor.data.locator.version === 1),
      outputs: ['place'],
      async run(ctx, _id, b) {
        const text = readable(ctx.blocksOf(String(b.anchor.data.target)))
        const quote = squash(String(b.anchor.data.quote ?? ''))
        return { place: { found: text !== undefined && !!quote && squash(text).includes(quote) } }
      }
    },
    {
      id: 'text.body',
      priority: 10,
      has: ['file'],
      needs: ['file'],
      // 只看文件的内容：改名不重读（设计文档 11.14）
      inputs: ['file.hash'],
      match: (b) => String(b.file.data.ext) in TEXT_EXTS && Number(b.file.data.size) <= MAX_TEXT_FILE,
      outputs: ['body'],
      async run(ctx, _id, b) {
        const { text, encoding } = decodeText(await readFile(ctx.abs(String(b.file.data.path))))
        return { body: { content: text, format: TEXT_EXTS[String(b.file.data.ext)], encoding, source: b.file.seq } }
      }
    }
  ],
  // 导出：摘录、随手记写成 Markdown（文档本来就是文件，由文件插件原样复制）
  exporters: [
    {
      priority: 10,
      match: (b) => !!b.text,
      place: (_b, title) => ({ folder: '文字', name: `${title}.md` }),
      async write(ctx, id, b, dest) {
        await writeFile(dest, frontMatter(ctx, id) + exportLinks(ctx, String(b.text.data.content ?? ''), '文字'))
      }
    }
  ],
  aspect: {
    priority: 50,
    get: (b) => {
      const c = contentOf(b)
      return c === undefined ? undefined : aspectOf(String(c))
    }
  }
}

export { textPlugin as plugin }
