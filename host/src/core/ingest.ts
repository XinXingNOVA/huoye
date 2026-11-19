// 接入管线：文件先保存到空间，再同步收录身份、数据与撤销；准备阶段只持久化文件记录和收录草稿。
import type Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import type { ImportReport } from '../shared/import-settings'
import { parseSpaceReference } from '../storage/space-reference'
import { hashFile } from '../storage/file-hash'
import { prepareMetadata, applyMetadata } from './ingest-metadata'
import { readdir, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { LibraryFiles, type FileImport, type StagedFile } from '../storage/library-files'
import { monotonicFactory } from 'ulid'
import { MAX_IMPORT_BYTES, type ImportInput, type IngestInput } from '../shared/ingest-input'
import type { BlockData } from '../shared/blocks'
import type { IngestResult } from '../plugin-api/operations'
import type { IngestContext } from './plugin'
import type { Registry } from './registry'
import type { Store } from './store'

export type IngestPolicy = { spaceId?: string; collect: boolean; reuseFiles?: boolean }
type Draft = {
  index: number; input: IngestInput; id: string; created: Set<string>
  writes: { id: string; kind: string; data: BlockData }[]
  files: StagedFile[]
  identity?: { spaceId: string; fileId: string }
}

export class Ingesting {
  private tail: Promise<unknown> = Promise.resolve()
  private stopped = false
  private newId = monotonicFactory()
  constructor(private files: LibraryFiles, private reg: Registry, private store: Store, private db: Database.Database) {}

  /** 已发布空间文件复用同一收录事务；不再复制，也不按哈希合并不同空间身份。 */
  adoptRegistered<T>(entries: { spaceId: string; fileId: string; file: BlockData; input: IngestInput }[], commit: (apply: () => IngestResult) => T): T {
    const drafts: Draft[] = entries.map((entry, index) => {
      const id = this.newId()
      return { index, id, created: new Set([id]), writes: [{ id, kind: 'file', data: entry.file }], files: [], input: entry.input,
        identity: { spaceId: entry.spaceId, fileId: entry.fileId } }
    })
    return this.accept(drafts, [], commit, { key: `adopt:${this.newId()}`, signature: '' })
  }

  stop(): void { this.stopped = true }
  private guard(): void { if (this.stopped) throw new Error('[LIBRARY_CLOSED] 仓库已关闭，未提交的收录已取消') }

  /** 同一仓库的 UI / 外部收录排队，避免并发的哈希去重竞争。commit 必须同步。 */
  run<T>(inputs: ImportInput[], expandDirectories: boolean, commit: (apply: () => ImportReport) => T, request?: { key: string; signature: string }, policy: IngestPolicy = { collect: true }): Promise<T> {
    const signature = createHash('sha256').update(JSON.stringify(inputs, (_key, value) => value instanceof Uint8Array ? createHash('sha256').update(value).digest('hex') : value)).digest('hex')
    const attempt = request ?? { key: `ui:${signature}`, signature }
    return this.enqueue(() => this.prepare(inputs, expandDirectories, commit, attempt, policy))
  }

  enqueue<T>(fn: () => T | Promise<T>): Promise<T> {
    const task = this.tail.then(() => { this.guard(); return fn() })
    this.tail = task.catch(() => {})
    return task
  }

  private find(kind: string, field: string, value: string | number, spaceId?: string): string | undefined {
    if (kind !== 'file' || field !== 'hash' || !spaceId) return this.store.findByField(kind, field, value)
    const rows = this.db.prepare("SELECT b.entity_id,b.data FROM main.field_index f JOIN main.block b ON b.entity_id=f.entity_id AND b.kind=f.kind WHERE f.kind='file' AND f.field='hash' AND f.txt=?").all(value) as { entity_id: string; data: string }[]
    return rows.find(row => {
      const path = String(JSON.parse(row.data).path), parsed = parseSpaceReference(path)
      return !!parsed?.contentVersion && parsed.spaceId === spaceId
    })?.entity_id
  }

  private async prepare<T>(inputs: ImportInput[], expandDirectories: boolean, commit: (apply: () => ImportReport) => T, attempt: { key: string; signature: string }, policy: IngestPolicy): Promise<T> {
    this.guard()
    const pending = this.db.prepare('SELECT * FROM main.ingest_pending WHERE key = ?').get(attempt.key) as { signature: string; data: string } | undefined
    const savedPolicy = pending && JSON.parse(pending.data).policy as IngestPolicy | undefined
    if (savedPolicy) policy = savedPolicy
    // 只有实际导入才释放复制批次；收录已有空间文件没有创建批次，不遍历其他空间清理。
    const accept = (drafts: Draft[], errors: IngestResult['errors']) => {
      const result = this.accept(drafts, errors, commit, attempt, policy)
      try { this.files.finishImport(attempt.key) } catch (e) { console.error('[file-space] 文件回执清理待重试', e) }
      return result
    }
    if (pending) {
      if (pending.signature !== attempt.signature) throw new Error('[REQUEST_ID_CONFLICT] 同一 requestId 不能用于不同操作')
      const saved = JSON.parse(pending.data) as { drafts?: (Omit<Draft, 'created'> & { created: string[] })[]; errors: IngestResult['errors'] }
      if (saved.drafts) {
        const drafts = saved.drafts.map(d => ({ ...d, created: new Set(d.created) }))
        // 仓库提交成功但清理回执前退出：不要重新创建素材或再次应用附加内容。
        if (drafts.length && drafts.every(d => this.store.exists(d.id))) {
          this.clearPending(attempt.key)
        } else {
          const ready = drafts.every(d => d.files.every(f => {
            try {
              if (hashFile(this.files.readable(f.reference)) !== f.hash) return false
              return true
            } catch { return false }
          }))
          if (ready) return accept(drafts, saved.errors)
        }
      }
    }
    policy = { ...policy, spaceId: policy.spaceId ?? (inputs.some(i => i.type !== 'text') ? this.files.bindings?.default().binding.id : undefined) }
    if (policy.spaceId) this.files.bindings!.open(policy.spaceId)
    const expanded = expandDirectories ? await expandInputs(inputs) : inputs
    expanded.forEach(input => prepareMetadata(this.reg, input.metadata))
    this.db.prepare('INSERT OR IGNORE INTO main.ingest_pending VALUES (?,?,?)').run(attempt.key, attempt.signature, JSON.stringify({ policy }))
    const target = policy.spaceId
    const drafts: Draft[] = [], errors: IngestResult['errors'] = []
    const stagedFields = new Map<string, string>()
    const stagedBlocks = new Map<string, BlockData>()
    const fieldKey = (kind: string, field: string, value: string | number) => JSON.stringify([kind, field, value])
    const indexed = (kind: string, data: BlockData) => Object.entries(data).flatMap(([field, value]) =>
      !this.reg.kind(kind)?.fields[field]?.index ? [] : (Array.isArray(value) ? value : [value])
        .filter((v): v is string | number => typeof v === 'string' || typeof v === 'number').map(v => fieldKey(kind, field, v)))
    const lookups: { kind: string; field: string; value: string | number; id: string | undefined }[] = []
    let staging: FileImport | undefined
    const stage = () => {
      return staging ??= this.files.beginImport(attempt.key, target)
    }
    try {
      for (const [index, raw] of expanded.entries()) {
        this.guard()
        let input: IngestInput
        try {
          if (raw.type === 'bytes') {
            if (!(raw.bytes instanceof Uint8Array) || !raw.bytes.byteLength || raw.bytes.byteLength > MAX_IMPORT_BYTES) {
              throw new Error('无路径文件必须有内容，且不能超过 32 MB')
            }
            const path = await stage().input(index, raw.name, raw.bytes)
            input = { type: 'file', path, metadata: raw.metadata, ...(raw.source ? { source: raw.source } : {}) }
          } else input = raw
        } catch (e) {
          errors.push({ index, message: e instanceof Error ? e.message : String(e) }); continue
        }
        const draft: Draft = { index, input, id: '', created: new Set(), writes: [], files: [] }
        const itemLookups: typeof lookups = []
        const ctx: IngestContext = {
          createEntity: () => { this.guard(); const id = this.newId(); draft.created.add(id); return id },
          put: (id, kind, data) => { this.guard(); draft.writes.push({ id, kind, data: structuredClone(data) }) },
          findByField: (kind, field, value) => {
            this.guard()
            const staged = [...draft.writes].reverse().find(w => w.kind === kind &&
              (Array.isArray(w.data[field]) ? (w.data[field] as unknown[]).includes(value) : w.data[field] === value))
            if (staged) return staged.id
            const previous = stagedFields.get(fieldKey(kind, field, value))
            if (previous) return previous
            const id = this.find(kind, field, value, target)
            itemLookups.push({ kind, field, value, id })
            return id
          },
          importFile: async (id, src, name) => {
            this.guard()
            if (!draft.created.has(id)) throw new Error('只能为本次新建的身份收录文件')
            const file = await stage().stage(id, src, name, `${index}:${draft.files.length}`, !policy.collect || policy.reuseFiles)
            this.guard()
            draft.files.push(file)
            return file.reference
          }
        }
        try {
          if (input.type === 'file' && !(await stat(input.path)).isFile()) throw new Error('[NOT_A_FILE] 请指定普通文件，不能收录文件夹或设备')
          this.guard()
          const rec = this.reg.recognizers.find(r => r.match(input))
          if (!rec) throw new Error('[UNSUPPORTED_INPUT] 没有启用的识别器能收录此内容')
          draft.id = await rec.ingest(ctx, input)
          this.guard()
          drafts.push(draft)
          for (const w of draft.writes) {
            const key = JSON.stringify([w.id, w.kind]), before = stagedBlocks.get(key)
            if (before) for (const field of indexed(w.kind, before)) if (stagedFields.get(field) === w.id) stagedFields.delete(field)
            stagedBlocks.set(key, w.data)
            for (const field of indexed(w.kind, w.data)) stagedFields.set(field, w.id)
          }
          lookups.push(...itemLookups)
        } catch (e) {
          this.guard()
          errors.push({ index, message: e instanceof Error ? e.message : String(e) })
        }
      }
      this.guard()
      // 准备期间用户仍可编辑、删除素材。查重依据变了就放弃本次提交，允许原 requestId 重试。
      for (const q of lookups) if (this.find(q.kind, q.field, q.value, target) !== q.id) {
        throw new Error('[INGEST_CHANGED] 准备期间仓库的去重依据已变化，请使用相同 requestId 重试')
      }
      // 准备记录属于仓库，空间回执只存文件事实。先登记待收录，再逐个发布。
      this.db.prepare('INSERT INTO main.ingest_pending VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET data=excluded.data')
        .run(attempt.key, attempt.signature, JSON.stringify({ policy, drafts: drafts.map(d => ({ ...d, created: [...d.created] })), errors }))
      for (const d of drafts) for (const file of d.files) {
        const record = this.files.record(file.reference), spaceId = parseSpaceReference(file.reference)?.spaceId
        if (record && spaceId) this.db.prepare("INSERT INTO main.space_import_seen VALUES (?,?,'seen',NULL) ON CONFLICT(space_id,file_id) DO UPDATE SET state='seen',error=NULL").run(spaceId, record.id)
      }
      return accept(drafts, errors)
    } finally {
      staging?.dispose()
    }
  }

  private clearPending(key: string): void {
    this.db.prepare('DELETE FROM main.ingest_pending WHERE key = ?').run(key)
    this.files.finishImport(key)
  }

  private accept<T>(drafts: Draft[], errors: IngestResult['errors'], commit: (apply: () => ImportReport) => T, attempt: { key: string; signature: string }, policy: IngestPolicy = { collect: true }): T {
    this.guard()
    const plans = drafts.map(d => prepareMetadata(this.reg, d.input.metadata))
    try {
      const result = commit(() => {
        const saved: ImportReport['saved'] = []
        const items: IngestResult['items'] = [], remapped = new Map<string, string>()
        const ctx: IngestContext = {
          createEntity: () => this.store.createEntity(),
          put: (id, kind, data) => { this.validateFile(kind, data); this.store.put(id, kind, data) },
          findByField: (kind, field, value) => this.store.findByField(kind, field, value),
          importFile: async () => { throw new Error('afterIngest 不能异步复制文件') }
        }
        for (const [index, d] of drafts.entries()) {
          if (!this.reg.recognizers.some(r => r.match(d.input))) throw new Error('[UNSUPPORTED_INPUT] 收录插件已停用，请启用后重试')
          // 重试期间可能已有另一项相同内容收录；沿用它并在事务内重新应用 metadata。
          const primary = d.writes.find(w => w.id === d.id && w.kind === 'file')
          const adopted = d.identity && this.db.prepare('SELECT entity_id FROM main.space_adoptions WHERE space_id=? AND file_id=?').pluck().get(d.identity.spaceId, d.identity.fileId) as string | undefined
          const parsed = primary && parseSpaceReference(String(primary.data.path))
          let identity = d.identity ?? (parsed ? { spaceId: parsed.spaceId, fileId: parsed.fileId } : undefined)
          const existing = d.identity ? (adopted && this.store.exists(adopted) ? adopted : undefined) : primary && this.find('file', 'hash', String(primary.data.hash), parsed?.spaceId)
          const id = existing ?? remapped.get(d.id) ?? d.id
          const fileData = primary?.data ?? this.store.blocksOf(id).file?.data ?? drafts.flatMap(other => other.writes).find(w => w.id === id && w.kind === 'file')?.data
          const fileRecord = fileData && this.files.record(String(fileData.path))
          const fileSpaceId = fileData && (parseSpaceReference(String(fileData.path))?.spaceId)
          if (fileRecord && fileSpaceId) {
            if (!identity && policy.reuseFiles) identity = { spaceId: fileSpaceId, fileId: fileRecord.id }
            this.validateFile('file', fileData!)
            saved.push({ index: d.index, spaceId: fileSpaceId, fileId: fileRecord.id, name: String(fileData!.name), outcome: d.files.some(f => !f.reused) ? 'saved' : 'existing' })
            // 写入成功后的显式导入决策优先；后台发现不得再次收录、恢复或应用附加内容。
            this.db.prepare("INSERT INTO main.space_import_seen VALUES (?,?,'seen',NULL) ON CONFLICT(space_id,file_id) DO UPDATE SET state='seen',error=NULL").run(fileSpaceId, fileRecord.id)
            if (!policy.collect && d.input.type === 'file') {
              if (!existing) {
                const raw = this.db.prepare('SELECT data FROM main.space_import_inputs WHERE space_id=? AND file_id=?').pluck().get(fileSpaceId, fileRecord.id) as string | undefined
                const deferred: IngestInput[] = raw ? JSON.parse(raw) : []
                // 重复保存时保留每份来源/附加意图；没有附加信息的重复不扩大记录。
                if (!deferred.length || d.input.source || d.input.metadata) {
                  if (!deferred.some(i => JSON.stringify(i) === JSON.stringify(d.input))) deferred.push(d.input)
                  if (deferred.length > 100) throw new Error('此文件已有过多待收录附加内容，请先完成收录')
                }
                this.db.prepare('INSERT INTO main.space_import_inputs VALUES (?,?,?) ON CONFLICT(space_id,file_id) DO UPDATE SET data=excluded.data').run(fileSpaceId, fileRecord.id, JSON.stringify(deferred))
              }
              continue
            }
          }
          remapped.set(d.id, id)
          if (!existing) for (const created of d.created) this.store.createEntity(Date.now(), created)
          if (!this.store.exists(id)) throw new Error('[INGEST_CHANGED] 接入识别器返回的身份不存在')
          const outcome = !existing && d.created.has(id) ? 'created' : this.store.isTrashed(id) ? 'restored' : 'existing'
          if (outcome === 'restored') this.store.restore([id])
          if (!existing) for (const w of d.writes) {
            if (!this.store.exists(w.id)) throw new Error('[INGEST_CHANGED] 接入识别器写入的身份不存在')
            this.validateFile(w.kind, w.data)
            this.store.put(w.id, w.kind, w.data)
          }
          // 导入重试若按内容合并到另一文件的素材，新增空间文件仍是未收录候选。
          if (identity && (d.identity || !existing)) this.db.prepare('INSERT INTO main.space_adoptions VALUES (?,?,?) ON CONFLICT(space_id,file_id) DO UPDATE SET entity_id=excluded.entity_id').run(identity.spaceId, identity.fileId, id)
          const metadata: NonNullable<IngestResult['items'][number]['metadata']> = {}
          // 新导入入口复用先前只保存的文件时，先兑现其待收录内容，再应用本次明确输入。
          if (identity && !d.identity) {
            const raw = this.db.prepare('SELECT data FROM main.space_import_inputs WHERE space_id=? AND file_id=?').pluck().get(identity.spaceId, identity.fileId) as string | undefined
            for (const original of (raw ? JSON.parse(raw) : []) as IngestInput[]) {
              for (const p of this.reg.plugins) p.afterIngest?.(ctx, id, { ...original, ...(d.input.type === 'file' ? { path: d.input.path } : {}) }, outcome === 'created')
              Object.assign(metadata, applyMetadata(this.reg, this.store, id, outcome, prepareMetadata(this.reg, original.metadata)))
            }
            this.db.prepare('DELETE FROM main.space_import_inputs WHERE space_id=? AND file_id=?').run(identity.spaceId, identity.fileId)
          }
          for (const p of this.reg.plugins) p.afterIngest?.(ctx, id, d.input, outcome === 'created')
          Object.assign(metadata, applyMetadata(this.reg, this.store, id, outcome, plans[index]))
          items.push({ index: d.index, id, outcome, ...(Object.keys(metadata).length ? { metadata } : {}) })
        }
        this.db.prepare('DELETE FROM main.ingest_pending WHERE key = ?').run(attempt.key)
        return { items, errors, processing: 'not_waited', saved, collect: policy.collect, spaceId: policy.spaceId }
      })
      return result
    } catch (error) {
      if (drafts.some(d => d.files.length)) throw new Error(`[FILE_STORED_NOT_ADOPTED] 文件已保存在选定文件空间，仓库尚未收录；请用原请求重试。${error instanceof Error ? error.message : String(error)}`)
      throw error
    }
  }

  private validateFile(kind: string, data: BlockData): void {
    if (kind !== 'file') return
    this.files.validateFile(data)
  }

}

/** UI 文件夹展开为其中的文件；外部操作只接受逐个指定的文件。 */
export async function expandInputs(inputs: ImportInput[]): Promise<ImportInput[]> {
  const out: ImportInput[] = []
  for (const input of inputs) {
    if (input.type !== 'file') { out.push(input); continue }
    try {
      const st = await stat(input.path)
      if (st.isDirectory()) {
        const children = (await readdir(input.path, { withFileTypes: true }))
          .filter(e => !e.name.startsWith('.') && (e.isFile() || e.isDirectory()))
          .map(e => ({ ...input, path: join(input.path, e.name) }))
        out.push(...await expandInputs(children))
      } else if (!basename(input.path).startsWith('.')) out.push(input)
    } catch { out.push(input) } // 留给逐项准备报告错误，不连带丢掉其他有效输入。
  }
  return out
}
