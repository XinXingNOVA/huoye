import { fileReference } from '../shared/file-location'
import { LibraryFiles } from '../storage/library-files'
// 彻底删除（设计文档 11.13）：回收站里的身份真正离开这个库。撤销不了，所以先预览、再确认（和导出一样）。
//
// 一起删的：依附在它们身上的身份（批注），它们的数据块、索引、加工记录，历史里关于它们的记录。
// 留着的：别处指向它们的关联引用（悬空，保留原值），例如文字里的 [[链接]]。
// 原件及空间目录保留；仅清理不再被引用的仓库派生缓存。
// 还有素材用着的模板不删：删了，那些素材上按它填的数据就没有定义了。

import type Database from 'better-sqlite3'
import type { PurgePreview, PurgeResult } from '../shared/rpc'
import type { History } from './history'
import type { Registry } from './registry'
import type { Scheduler } from './scheduler'
import type { Store } from './store'

/** 一组一起删的身份：选中的一项，加上（层层）依附在它上面的。文件都是库内相对路径。 */
interface Group {
  id: string
  members: string[]
  originals: string[]
  caches: string[]
}

function inside(rel: string): string | undefined {
  try { return fileReference(rel) } catch { return undefined }
}

export class Purging {
  constructor(
    private readonly db: Database.Database,
    private readonly reg: Registry,
    private readonly store: Store,
    private readonly history: History,
    private readonly scheduler: Scheduler,
    private readonly files: LibraryFiles
  ) {}

  /** 这个身份占着的文件：不可重建的数据块里的是原文件，可重建的是缓存。 */
  private filesOf(id: string, originals: Set<string>, caches: Set<string>): void {
    for (const [kind, b] of Object.entries(this.store.blocksOf(id))) {
      const def = this.reg.kind(kind)
      if (!def) continue
      for (const [name, f] of Object.entries(def.fields)) {
        if (!f.file) continue
        for (const v of f.list ? ((b.data[name] as unknown[]) ?? []) : [b.data[name]]) {
          const rel = typeof v === 'string' ? inside(v) : undefined
          if (rel) (def.rebuildable ? caches : originals).add(rel)
        }
      }
    }
  }

  /** 这个身份定义的数据块（模板定义的那种），除了一起删的，还有几项在用。 */
  private usersOf(id: string, members: Set<string>): number {
    const kinds = this.reg.allKinds().filter((k) => k.template === id)
    if (!kinds.length) return 0
    const rows = this.db
      .prepare('SELECT DISTINCT entity_id FROM main.block WHERE kind IN (SELECT value FROM json_each(?))')
      .pluck()
      .all(JSON.stringify(kinds.map((k) => k.id))) as string[]
    return rows.filter((e) => !members.has(e)).length
  }

  private plan(ids: string[]): { groups: Group[]; skipped: { id: string; reason: string }[] } {
    const skipped: { id: string; reason: string }[] = []
    const chosen: string[] = []
    for (const id of new Set(ids)) {
      if (!this.store.exists(id)) continue
      if (!this.store.isTrashed(id)) skipped.push({ id, reason: '不在回收站里' })
      else chosen.push(id)
    }
    // 选中的一项依附在另一项上（例如同时选了图片和它的批注）：跟着那一项删，不单独算
    const families = new Map(chosen.map((id) => [id, this.store.withAttached([id])]))
    const covered = new Set([...families.values()].flatMap((f) => f.slice(1)))
    const tops = chosen.filter((id) => !covered.has(id))
    const all = new Set(tops.flatMap((id) => families.get(id)!))

    const groups: Group[] = []
    for (const id of tops) {
      const members = families.get(id)!
      const users = Math.max(...members.map((m) => this.usersOf(m, all)))
      if (users > 0) {
        skipped.push({ id, reason: `还有 ${users} 项用着这个模板` })
        continue
      }
      const originals = new Set<string>()
      const caches = new Set<string>()
      for (const m of members) this.filesOf(m, originals, caches)
      // 图片的代表图就是原图：不当缓存删
      for (const rel of originals) caches.delete(rel)
      groups.push({ id, members, originals: [...originals], caches: [...caches] })
    }
    return { groups, skipped }
  }

  private members(groups: Group[]) {
    const ids = [...new Set(groups.flatMap(g => g.members))]
    const owned = this.store.countOwnedRecords(ids)
    return { ids, locals: ids.length - groups.length, ...(owned ? { ownedRecords: owned } : {}) }
  }

  preview(ids: string[]): PurgePreview {
    const { groups, skipped } = this.plan(ids)
    const retainedFiles = new Set(groups.flatMap(g => g.originals)).size
    const { locals, ownedRecords } = this.members(groups)
    return {
      items: groups.length, locals, ...(ownedRecords ? { ownedRecords } : {}),
      retainedFiles,
      skipped
    }
  }

  run(ids: string[]): PurgeResult {
    const { groups, skipped } = this.plan(ids)
    const failed = [...skipped]
    const family = this.members(groups)
    const members = family.ids
    this.scheduler.cancel(members)
    this.store.batch(() => {
      this.store.purge(members)
      this.history.forget(members)
      this.store.afterCommit(() => this.cleanCaches(groups))
    })
    return { ...family, purged: groups.length, failed }
  }

  private cleanCaches(groups: Group[]): void {
    const candidates = new Set(groups.flatMap(g => g.caches).filter(ref => ref.startsWith('cache/')))
    // 原始块声明的文件始终保留，即使同批另一个身份把它当派生结果。
    for (const group of groups) for (const ref of group.originals) candidates.delete(ref)
    removeUnusedCaches(this.db, this.files, candidates)
  }
}

/** 删除已撤下且库内再无引用的缓存，包括回收站和未启用插件的块。核对失败时保留。 */
export function removeUnusedCaches(db: Database.Database, files: LibraryFiles, candidates: Set<string>): void {
  if (!candidates.size) return
  try {
    const visit = (value: unknown): void => {
      if (typeof value === 'string') {
        const ref = inside(value)
        if (ref) candidates.delete(ref)
      } else if (Array.isArray(value)) {
        for (const child of value) visit(child)
      } else if (value && typeof value === 'object') {
        for (const child of Object.values(value)) visit(child)
      }
    }
    // 只扫一次当前记录；普通字符串恰好命中缓存时也保守保留。
    const rows = db.prepare('SELECT data FROM main.block UNION ALL SELECT data FROM derived.block').iterate() as Iterable<{ data: string }>
    for (const row of rows) {
      visit(JSON.parse(row.data))
      if (!candidates.size) break
    }
  } catch { return }
  for (const ref of candidates) {
    try { files.removeCache(ref) } catch { /* 缓存缺失或无法安全删除。 */ }
  }
}
