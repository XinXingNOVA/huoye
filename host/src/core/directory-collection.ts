import { createHash } from 'node:crypto'
import { extname } from 'node:path'
import { z } from 'zod'
import type { Library } from './library'
import type { History } from './history'
import type { Ingesting } from './ingest'
import type { Store } from './store'
import { DirectorySpaces } from '../storage/directory-spaces'
import { directoryCatalogHome, directoryReference, parseDirectoryReference } from '../storage/directory-reference'
import { FILE_MIME } from '../shared/file-metadata'
import { directoryPageSize, type DirectoryUpdatesPage, type DirectoryCollectionResult } from '../shared/directory-spaces'
import { sourceFile } from '../storage/source-file'
import { directoryAdoptSchema, type DirectoryAdoption } from '../shared/source-automation'
import type { OperationResult } from '../shared/automation'

const extensions = z.array(z.string().regex(/^[\p{L}\p{N}_+-]{1,32}$/u)).max(64)
export class DirectoryCollection {
  constructor(private lib: Library, private ingest: Ingesting, private store: Store, private history: History) {}

  private receipt(request: DirectoryAdoption) {
    const signature = createHash('sha256').update(JSON.stringify(['adopt-directory', request])).digest('hex')
    const old = this.lib.db.prepare('SELECT signature,result FROM main.operation_receipt WHERE request_id=?').get(request.requestId) as {signature: string; result: string} | undefined
    if ((old && old.signature !== signature) || this.lib.db.prepare('SELECT 1 FROM main.ingest_pending WHERE key=?').get('mcp:' + request.requestId))
      throw new Error('[REQUEST_ID_CONFLICT] 请求 ID 已用于其他操作')
    return { signature, replay: old ? { requestId: request.requestId, replayed: true, result: JSON.parse(old.result) } : undefined }
  }
  async prepareSelected(raw: DirectoryAdoption) {
    const input = directoryAdoptSchema.parse(raw), spaces = new DirectorySpaces(directoryCatalogHome())
    const { replay } = this.receipt(input)
    if (replay) return replay
    for (const f of input.files) await spaces.verify(this.lib, input.spaceId, f.id, f.stamp)
  }
  commitSelected(raw: DirectoryAdoption, source: 'application' | 'external' = 'external'): OperationResult {
    const input = directoryAdoptSchema.parse(raw), spaces = new DirectorySpaces(directoryCatalogHome())
    const old = this.receipt(input).replay
    if (old) return old
    return spaces.verifiedSelection(this.lib, input.spaceId, input.files, files => this.store.batch(() => {
      const { signature, replay } = this.receipt(input)
      if (replay) return replay
      const entries = files.map((f, i) => this.entry(input.spaceId, f, input.files[i].metadata))
      const result = this.ingest.adoptRegistered(entries, apply => this.history.run('收录原地文件', apply, { source, operation: 'adopt_space_files', requestId: input.requestId }))
      this.lib.db.prepare('INSERT INTO main.operation_receipt VALUES (?,?,?,?)').run(input.requestId, signature, JSON.stringify(result), Date.now())
      return { requestId: input.requestId, replayed: false, result }
    }))
  }
  private entry(spaceId: string, item: { id: string; name: string; size: number; hash: string }, metadata?: DirectoryAdoption['files'][number]['metadata']) {
    const ext = extname(item.name).slice(1).toLowerCase()
    const path = directoryReference(spaceId, item.id, item.hash, item.name)
    return { spaceId, fileId: item.id, file: { path, hash: item.hash, size: item.size, name: item.name, ext, mime: FILE_MIME[ext] ?? 'application/octet-stream' },
      input: { type: 'file' as const, path: this.lib.files.readable(path), metadata } }
  }

  private plan(spaceId: string, suffixes: string[]) {
    const spaces = new DirectorySpaces(directoryCatalogHome())
    const filter = new Set(extensions.parse(suffixes).map(s => s.toLowerCase()))
    const items = spaces.candidates(this.lib, z.uuid().parse(spaceId), filter)
    const known = new Set<string>()
    const adoptions = this.lib.db.prepare(`SELECT a.file_id,json_extract(b.data,'$.path') AS path FROM space_adoptions a
      JOIN block b ON b.entity_id=a.entity_id AND b.kind='file' WHERE a.space_id=?`).iterate(spaceId) as Iterable<{file_id: string; path: string}>
    for (const row of adoptions) {
      const ref = sourceFile(row.path)
      if (ref?.spaceId === spaceId && ref.fileId === row.file_id) known.add(row.file_id)
    }
    const pending = items.filter(i => !known.has(i.id))
    const signature = createHash('sha256').update(JSON.stringify([this.lib.id, spaceId, [...filter].sort()]))
    for (const i of pending) signature.update(JSON.stringify([i.id, i.path, i.stamp]))
    const preview = { token: signature.digest('hex'), pending: pending.length, existing: items.length - pending.length,
      matched: items.length, examples: pending.slice(0, 4).map(i => i.path) }
    return { preview, pending, spaces }
  }

  updates(spaceId: string, offset: number): DirectoryUpdatesPage {
    z.number().int().nonnegative().parse(offset)
    const revised = new DirectorySpaces(directoryCatalogHome()).revisedFiles(this.lib, spaceId)
    if (!revised.length) return { items: [], total: 0, offset: 0 }
    const rows = this.lib.db.prepare(`SELECT a.file_id,a.entity_id,json_extract(b.data,'$.path') AS reference
      FROM space_adoptions a JOIN entity e ON e.id=a.entity_id JOIN block b ON b.entity_id=e.id AND b.kind='file'
      WHERE a.space_id=? AND e.deleted_at IS NULL AND a.file_id IN (SELECT value FROM json_each(?))`)
      .all(spaceId, JSON.stringify(revised.map(file => file.id))) as { file_id: string; entity_id: string; reference: string }[]
    const adopted = new Map(rows.map(row => [row.file_id, row]))
    const pending = revised.flatMap(file => {
      const row = adopted.get(file.id)
      if (!row) return []
      const ref = parseDirectoryReference(row.reference)
      return ref?.spaceId === spaceId && ref.fileId === file.id && ref.hash !== file.hash
        ? [{ id: row.entity_id, path: file.path, revision: file.revision }] : []
    })
    const start = Math.min(offset, Math.max(0, Math.ceil(pending.length / directoryPageSize) - 1) * directoryPageSize)
    return { items: pending.slice(start, start + directoryPageSize), total: pending.length, offset: start }
  }

  preview(spaceId: string, suffixes: string[]) { return this.plan(spaceId, suffixes).preview }

  collect(spaceId: string, suffixes: string[], token: string) {
    return this.ingest.enqueue(async () => {
      const { preview, pending, spaces } = this.plan(spaceId, suffixes)
      if (preview.token !== token) throw new Error('候选文件已变化，请重新预览收录')
      const result: DirectoryCollectionResult = { created: 0, skipped: preview.existing, failed: 0, problems: [] }
      const problem = (path: string, error: unknown, count = 1) => {
        result.failed += count
        if (result.problems.length < 5) result.problems.push(path + ' · ' + (error instanceof Error ? error.message : String(error)))
      }
      // 校验期间不持有仓库写事务。分批提交使大批收录可撤销，重开后按本库已有身份继续。
      for (let start = 0; start < pending.length; start += 50) {
        const entries: Parameters<Ingesting['adoptRegistered']>[0] = []
        for (const item of pending.slice(start, start + 50)) {
          try {
            const { hash } = await spaces.verify(this.lib, spaceId, item.id, item.stamp)
            entries.push(this.entry(spaceId, { ...item, hash }))
          } catch (error) { problem(item.path, error) }
        }
        if (!entries.length) continue
        try {
          const saved = this.store.batch(() => this.ingest.adoptRegistered(entries, apply => this.history.run('收录原地文件', apply)))
          result.created += saved.items.filter(i => i.outcome === 'created').length
          result.skipped += saved.items.filter(i => i.outcome !== 'created').length
        } catch (error) { problem(String(entries[0].file.name), error, entries.length) }
      }
      return result
    })
  }
}
