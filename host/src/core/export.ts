import { LibraryFiles } from '../storage/library-files'
// 导出（输出，设计文档 11.12）：把一组素材写成一个文件夹，Obsidian、Typora 都能直接打开。
//
//   <名称>/
//     索引.md   每一项：标题、文件（图片直接嵌进来）、属性（标签、状态、模板字段、来源……）、笔记、它的批注
//     素材/     原文件        文字/  摘录写成 Markdown        局部/  裁好的局部
//
// 一个身份写成什么文件由认识它的插件决定（导出扩展点）；属性由数据块定义生成。
// 输出撤销不了：先预览、再确认；某一项失败就跳过并记下原因，其余照常写。

import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import type Database from 'better-sqlite3'
import { basename, extname, join, posix } from 'node:path'
import type { Blocks } from '../shared/blocks'
import { summaryTitle } from '../shared/title'
import { isImagePath, mdPath } from '../shared/markdown'
import type { ExportPreview, ExportRequest, ExportResult } from '../shared/rpc'
import type { ExportContext, ExportProperty, Exporter } from './plugin'
import type { Registry } from './registry'
import type { Store } from './store'
import { exportPresentation } from './export-presentation'


/** 文件名里不能有的字符换掉，太长的截断。 */
export function safeName(name: string, max = 80): string {
  const s = name.replace(/[/\\:*?"<>|\n\r\t]+/g, ' ').replace(/\s+/g, ' ').trim()
  return (s.length > max ? s.slice(0, max).trim() : s) || '未命名'
}


/** 一项要写到哪里。 */
interface Placed {
  exporter: Exporter
  folder: string
  name: string
  /** 相对导出文件夹。 */
  rel: string
}

export class Exporting {
  constructor(
    private readonly db: Database.Database,
    private readonly reg: Registry,
    private readonly store: Store,
    private readonly files: LibraryFiles,
    private readonly onProgress: (done: number, total: number) => void
  ) {}

  private exporters(): Exporter[] {
    return this.reg.plugins.flatMap((p) => p.exporters ?? []).sort((a, b) => a.priority - b.priority)
  }

  private presentation(id: string) {
    return exportPresentation(this.reg, this.store.blocksOf(id), target => this.titleOf(target, this.store.blocksOf(target), {}))
  }

  /** 依附在这些身份上的局部（批注）：跟着一起导出，写在原素材那一节里。 */
  private localsOf(ids: string[]): Map<string, string[]> {
    const out = new Map<string, string[]>()
    if (!ids.length) return out
    const rows = this.db
      .prepare(
        `SELECT r.entity_id, r.target_id FROM main.ref r JOIN main.entity e ON e.id = r.entity_id AND e.deleted_at IS NULL
         WHERE r.ref_type = 'attach' AND r.target_id IN (SELECT value FROM json_each(?)) ORDER BY e.created_at`
      )
      .raw(true)
      .all(JSON.stringify(ids)) as [string, string][]
    for (const [local, target] of rows) {
      if (!out.has(target)) out.set(target, [])
      out.get(target)!.push(local)
    }
    return out
  }

  /** 选中的 + 跟着一起的批注；每一项写成什么文件、放哪里（重名加编号）。 */
  private plan(ids: string[], titles: Record<string, string>) {
    ids = [...new Set(ids)]
    const chosen = new Set(ids)
    const locals = this.localsOf(ids)
    const extra = [...locals.values()].flat().filter((id) => !chosen.has(id))
    const all = [...new Set([...ids, ...extra])]
    const exporters = this.exporters()
    const placed = new Map<string, Placed>()
    const taken = new Set<string>()
    for (const id of all) {
      const blocks = this.store.blocksOf(id)
      const exporter = exporters.find((e) => e.match(blocks))
      if (!exporter) continue
      const { folder, name } = exporter.place(blocks, this.titleOf(id, blocks, titles))
      const clean = safeName(name)
      const ext = extname(clean)
      const stem = clean.slice(0, clean.length - ext.length)
      let file = clean
      for (let n = 2; taken.has(posix.join(folder, file).toLowerCase()); n++) file = `${stem} (${n})${ext}`
      const rel = posix.join(folder, file)
      taken.add(rel.toLowerCase())
      placed.set(id, { exporter, folder, name: file, rel })
    }
    return { ids, all, locals, placed }
  }

  /** 界面给的标题；没有的（跟着一起的批注）按数据推一个。 */
  private titleOf(id: string, blocks: Blocks, titles: Record<string, string>): string {
    if (titles[id]) return titles[id]
    return summaryTitle(blocks, k => this.reg.kind(k), id)
  }

  preview(ids: string[]): ExportPreview {
    const { ids: selected, all, placed } = this.plan(ids, {})
    const folders = new Map<string, { count: number; bytes: number }>()
    for (const id of all) {
      const p = placed.get(id)
      if (!p) continue
      const f = folders.get(p.folder) ?? { count: 0, bytes: 0 }
      f.count++
      f.bytes += Math.max(0, p.exporter.bytes?.(this.store.blocksOf(id)) ?? 0)
      folders.set(p.folder, f)
    }
    const presentations = all.map(id => ({ id, ...this.presentation(id) }))
    return { items: selected.length, locals: all.length - selected.length,
      folders: [...folders].map(([folder, f]) => ({ folder, ...f })),
      unsupported: presentations.filter(p => !placed.has(p.id) && !p.content).length,
      problems: presentations.flatMap(p => p.problems.map(problem => `${this.titleOf(p.id, this.store.blocksOf(p.id), {})}：${problem}`)) }
  }

  /** 供文件导出器复用的属性，专用属性语义由所属插件提供。 */
  properties(id: string): ExportProperty[] { return this.presentation(id).properties }

  async run(req: ExportRequest): Promise<ExportResult> {
    const { ids, all, locals, placed } = this.plan(req.ids, req.titles)
    let dir = join(req.parent, safeName(req.name))
    for (let n = 2; existsSync(dir); n++) dir = join(req.parent, `${safeName(req.name)} (${n})`)
    await mkdir(dir, { recursive: true })

    const title = (id: string) => this.titleOf(id, this.store.blocksOf(id), req.titles)
    const ctx: ExportContext = {
      abs: (rel) => this.files.readable(rel),
      linkTo: (id, from) => {
        const p = placed.get(id)
        return p ? posix.relative(from || '.', p.rel) : undefined
      },
      findByField: (kind, field, value) => this.store.findByField(kind, field, value),
      properties: (id) => this.properties(id),
      title
    }

    const failed: ExportResult['failed'] = []
    const failedIds = new Map<string, string>()
    let written = 0
    let done = 0
    for (const id of all) {
      const p = placed.get(id)
      const presentation = this.presentation(id)
      if (presentation.problems.length) {
        const reason = presentation.problems.join('；')
        failed.push({ title: title(id), reason }); failedIds.set(id, reason)
      }
      if (!p && !presentation.content) {
        const reason = '没有可用的格式导出器；可使用“取回数据”保留完整记录'
        failed.push({ title: title(id), reason })
        failedIds.set(id, reason)
      }
      if (p) {
        try {
          await mkdir(join(dir, p.folder), { recursive: true })
          await p.exporter.write(ctx, id, this.store.blocksOf(id), join(dir, p.rel))
          written++
        } catch (e) {
          const reason = e instanceof Error ? e.message : String(e)
          failed.push({ title: title(id), reason })
          failedIds.set(id, reason)
          placed.delete(id)
        }
      }
      this.onProgress(++done, all.length)
    }

    await writeFile(join(dir, '索引.md'), this.index(req.name, ids, locals, placed, failedIds, title))
    return { dir, written, failed }
  }

  /** 索引：每一项一节。批注写在它的原素材那一节里；原素材没一起导出的批注自成一节。 */
  private index(
    name: string,
    ids: string[],
    locals: Map<string, string[]>,
    placed: Map<string, Placed>,
    failed: Map<string, string>,
    title: (id: string) => string
  ): string {
    const grouped = new Set([...locals.values()].flat())
    const chosen = new Set(ids)
    const roots = ids.filter(id => !(grouped.has(id) && this.targetsOf(id).some(target => chosen.has(target))))
    const top = [...roots]
    const represented = new Set(roots.flatMap(id => [id, ...(locals.get(id) ?? [])]))
    // 环或多层选择不能让已纳入导出的记录失去索引入口。
    for (const id of [...ids, ...grouped]) if (!represented.has(id)) {
      top.push(id); represented.add(id)
      for (const child of locals.get(id) ?? []) represented.add(child)
    }
    const fileLink = (id: string) => {
      const p = placed.get(id)
      if (!p) return undefined
      return isImagePath(p.name) ? `![${title(id)}](${mdPath(p.rel)})` : `[${basename(p.rel)}](${mdPath(p.rel)})`
    }
    const out = [`# ${name}`, '', `导出于 ${new Date().toISOString().slice(0, 10)}，共 ${top.length} 项。`, '']
    for (const id of top) {
      out.push(`## ${title(id)}`, '')
      const link = fileLink(id)
      if (link) out.push(link, '')
      if (failed.has(id)) out.push(`（没有导出成功：${failed.get(id)}）`, '')
      for (const target of this.targetsOf(id)) out.push(`来自：${placed.has(target) && chosen.has(target) ? `[${title(target)}](#${title(target)})` : title(target)}`, '')
      const presentation = this.presentation(id)
      const props = presentation.properties.filter(p => p.index !== false)
      for (const p of props) out.push(`- ${p.label}：${Array.isArray(p.value) ? p.value.join('、') : p.value}`)
      if (props.length) out.push('')
      for (const markdown of presentation.markdown) out.push(markdown, '')
      const mine = locals.get(id) ?? []
      if (mine.length) {
        out.push('### 附属记录', '')
        for (const l of mine) out.push(`- ${this.localLine(l, fileLink(l))}`)
        out.push('')
      }
    }
    return out.join('\n')
  }

  /** 依附关系属于仓库，不依赖某一种局部数据块。 */
  private targetsOf(id: string): string[] {
    return this.db.prepare(`SELECT target_id FROM main.ref WHERE entity_id = ? AND ref_type = 'attach'
      UNION SELECT target_id FROM derived.ref WHERE entity_id = ? AND ref_type = 'attach'`).pluck().all(id, id) as string[]
  }

  private localLine(id: string, link: string | undefined): string {
    const presentation = this.presentation(id)
    const parts = [...(!presentation.content && link ? [link] : []), ...presentation.inline]
    return (parts.join(' —— ') || this.titleOf(id, this.store.blocksOf(id), {})).replace(/\n/g, '\n  ')
  }
}
