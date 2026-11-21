// 仓库的版本接纳。空间提交不参加仓库撤销；本库引用、快照、候选与回执在同一事务提交。
import type { ImportPolicy } from './import-policy'
import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs'
import { basename, extname } from 'node:path'
import { z } from 'zod'
import type { Library } from './library'
import type { Store } from './store'
import type { Registry } from './registry'
import { DirectorySpaces } from '../storage/directory-spaces'
import { directoryCatalogHome, directoryReference, directoryStamp, parseDirectoryReference, withDirectoryHead } from '../storage/directory-reference'
import { parseSpaceReference, spaceReference } from '../storage/space-reference'
import type { FileSpace } from '../storage/file-space'
import { SpaceVersions } from '../storage/space-versions'
import { applyFileVersion } from './apply-file-version'
import { acceptFileUpdateSchema, type AcceptFileUpdate, type FileUpdatePreview, type FileUpdateScan } from '../shared/file-updates'
import { recoverLegacyPublications } from './legacy-publications'

const message = (e: unknown) => e instanceof Error ? e.message : String(e)
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex')
function textSample(name: string, path: string, stamp?: string) {
  if (!/\.(txt|md|markdown|csv|json|lrc)$/i.test(name)) return
  const fd = openSync(path, stamp ? constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0) : 'r')
  const check = () => {
    if (stamp && directoryStamp(fstatSync(fd, { bigint: true })) !== stamp) throw new Error('[SPACE_CHANGED] 原地文件已变化，请重新核对')
  }
  try {
    check()
    const bytes = Buffer.alloc(4096)
    const sample = bytes.subarray(0, readSync(fd, bytes, 0, bytes.length, 0)).toString('utf8')
    check()
    return sample
  } finally { closeSync(fd) }
}

export class FileUpdates {
  private readonly reconciled = new WeakSet<FileSpace>()

  constructor(private lib: Library, private store: Store, private reg: Registry, private changed: (ids: string[], directorySpace?: string) => void) {}
  private file(id: string) {
    const block = this.store.blocksOf(id).file
    if (!block || !this.store.exists(id)) throw new Error('[ITEM_UNAVAILABLE] 素材不存在或没有原文件')
    return block
  }
  private target(reference: string) {
    const parsed = parseSpaceReference(reference)
    if (!parsed?.contentVersion) throw new Error('[VERSION_REFERENCE_REQUIRED] 素材没有明确内容版本引用')
    const space = this.lib.files.bindings!.open(parsed.spaceId), versions = new SpaceVersions(space, `library:${this.lib.id}:${this.lib.files.bindings!.binding(space.id).token}`)
    return { parsed, space, versions }
  }
  async recheck(id: string, notify: (spaceId: string, fileId: string) => void) {
    const path = String(this.file(z.string().min(1).max(200).parse(id)).data.path), ref = parseDirectoryReference(path)
    if (!ref) throw new Error('只有原地文件需要核对目录版本')
    await new DirectorySpaces(directoryCatalogHome()).recheck(this.lib, ref.spaceId, ref.fileId)
    notify(ref.spaceId, ref.fileId)
    if (this.file(id).data.path !== path) throw new Error('本库的文件引用已改变，请重新查看')
    return this.preview(id)
  }
  preview(id: string): FileUpdatePreview {
    z.string().min(1).max(200).parse(id)
    const block = this.file(id), expectedPath = String(block.data.path)
    const directory = parseDirectoryReference(expectedPath)
    if (directory) return withDirectoryHead(this.lib.root, this.lib.id, directory, head => {
      const { spaceId, fileId } = directory, name = basename(head.path)
      const current = { id: head.hash, fileId, name, hash: head.hash, size: head.size, ordinal: head.revision,
        reference: directoryReference(spaceId, fileId, head.hash, name), sample: textSample(name, head.path, head.stamp) }
      const previous = directory.hash === head.hash ? { ...current, reference: expectedPath } : {
        id: directory.hash, fileId, name: basename(expectedPath), hash: directory.hash, size: Number(block.data.size), reference: expectedPath,
        unavailable: '原地文件已被改写，本仓库保留了旧版摘要和大小。' }
      return { id, spaceId, fileId, expectedPath, revision: head.revision, previous, current }
    })
    const { parsed, space, versions } = this.target(expectedPath)
    const file = space.byId(parsed.fileId)
    if (!file || file.state !== 'available') throw new Error('[FILE_UNAVAILABLE] 原件不可用')
    const head = space.db.prepare('SELECT contentVersion FROM file_heads WHERE fileId=?').pluck().get(file.id) as string
    const describe = (contentVersion: string, allowUnavailable = false) => {
      const version = versions.version(file.id, contentVersion)
      const reference = spaceReference(space.id, file.id, version.name, contentVersion)
      let path: string
      try { path = versions.read(file.id, contentVersion) } catch (e) {
        if (!allowUnavailable) throw e
        return { ...version, reference, unavailable: message(e) }
      }
      return { ...version, reference, sample: textSample(version.name, path) }
    }
    return { id, spaceId: space.id, fileId: file.id, expectedPath: String(block.data.path), revision: file.revision,
      previous: describe(parsed.contentVersion!, true), current: describe(head) }
  }
  accept(raw: AcceptFileUpdate, published = false) {
    const input = acceptFileUpdateSchema.parse(raw), signature = digest(['accept_file_version', input])
    const old = this.lib.db.prepare('SELECT signature,result FROM main.operation_receipt WHERE request_id=?').get(input.requestId) as { signature: string; result: string } | undefined
    if (old) {
      if (old.signature !== signature) throw new Error('[REQUEST_ID_CONFLICT] 请求 ID 已用于其他操作')
      return { ...JSON.parse(old.result), replayed: true }
    }
    if (this.lib.db.prepare('SELECT 1 FROM main.ingest_pending WHERE key=?').get(`mcp:${input.requestId}`)) throw new Error('[REQUEST_ID_CONFLICT] 请求 ID 已用于导入')
    const block = this.file(input.id), expectedPath = String(block.data.path)
    if (expectedPath !== input.expectedPath) throw new Error('[ITEM_CHANGED] 本库引用已变化，请重新预览')
    if (this.store.isTrashed(input.id)) throw new Error('[ITEM_TRASHED] 素材已在回收站，未自动恢复或接纳')
    const commit = (apply: () => void) => this.store.batch(() => {
      apply()
      const result = { id: input.id, contentVersion: input.contentVersion, replayed: false }
      this.lib.db.prepare('INSERT INTO main.operation_receipt VALUES (?,?,?,?)').run(input.requestId, signature, JSON.stringify(result), Date.now())
      return result
    })
    const directory = parseDirectoryReference(expectedPath)
    if (directory) {
      const result = withDirectoryHead(this.lib.root, this.lib.id, directory, head => {
        if (head.hash !== input.contentVersion || head.revision !== input.revision) throw new Error('[SPACE_CHANGED] 原地文件已更新，请重新预览')
        if (directory.hash === head.hash) throw new Error('[NO_UPDATE] 本库已采用这份内容')
        const name = basename(head.path), reference = directoryReference(directory.spaceId, directory.fileId, head.hash, name)
        return commit(() => applyFileVersion(this.store, this.reg, input.id, block.data,
          { reference, hash: head.hash, size: head.size, ext: extname(name).slice(1).toLowerCase() }))
      }, true)
      this.changed([input.id], directory.spaceId)
      return result
    }
    const { parsed, space, versions } = this.target(expectedPath)
    const result = space.exclusive(() => commit(() => {
      const file = space.byId(parsed.fileId)!, head = space.db.prepare('SELECT contentVersion FROM file_heads WHERE fileId=?').pluck().get(file.id)
      if (!published && (file.revision !== input.revision || head !== input.contentVersion)) throw new Error('[SPACE_CHANGED] 空间当前版本已变化，请重新预览')
      const version = versions.version(file.id, input.contentVersion)
      versions.read(file.id, version.id)
      const ext = extname(version.name).slice(1).toLowerCase()
      const reference = spaceReference(space.id, file.id, version.name, version.id)
      applyFileVersion(this.store, this.reg, input.id, block.data, { reference, hash: version.hash, size: version.size, ext })
      const queued = this.lib.db.prepare('SELECT content_version FROM main.space_updates WHERE space_id=? AND file_id=?').pluck().get(space.id, file.id) as string | undefined
      if (queued && versions.version(file.id, queued).ordinal <= version.ordinal)
        this.lib.db.prepare('DELETE FROM main.space_updates WHERE space_id=? AND file_id=?').run(space.id, file.id)
    }))
    this.changed([input.id]); return result
  }
  scan(policy: ImportPolicy, spaceId?: string): FileUpdateScan {
    const result: FileUpdateScan = { updated: 0, pending: 0, errors: [] }
    for (const binding of this.lib.files.bindings!.rows().filter(b => b.state === 'active' && (spaceId === undefined || b.id === spaceId))) {
      try {
        const space = this.lib.files.bindings!.open(binding.id)
        const versions = new SpaceVersions(space, `library:${this.lib.id}:${this.lib.files.bindings!.binding(space.id).token}`)
        const recoveryErrors = recoverLegacyPublications(this.lib, this.store, space, input => this.accept(input, true))
        for (const error of recoveryErrors) if (result.errors.length < 20) result.errors.push({ spaceId: space.id, message: error })
        const queue = this.lib.db.prepare(`INSERT INTO main.space_updates VALUES (?,?,?,NULL)
          ON CONFLICT(space_id,file_id) DO UPDATE SET content_version=excluded.content_version,error=NULL`)
        let seq = Number(this.lib.db.prepare('SELECT seq FROM main.space_update_cursor WHERE space_id=?').pluck().get(space.id) ?? 0)
        // 游标只与候选记录一起推进；每页短事务，文件失败不会阻止后续发现。
        for (;;) {
          const changes = versions.changes(seq)
          if (!changes.length) break
          this.lib.db.transaction(() => {
            for (const change of changes) queue.run(space.id, change.fileId, change.contentVersion)
            seq = changes.at(-1)!.seq
            this.lib.db.prepare('INSERT INTO main.space_update_cursor VALUES (?,?) ON CONFLICT(space_id) DO UPDATE SET seq=excluded.seq').run(space.id, seq)
          })()
        }
        // 首次打开核对所有引用。之后只核对本库改过的引用，以及空间日志与旧待办中的文件。
        const scope = this.reconciled.has(space) ? `AND a.file_id IN (
          SELECT file_id FROM temp.space_reference_checks WHERE space_id=@space
          UNION SELECT file_id FROM main.space_updates WHERE space_id=@space)` : ''
        const adopted = this.lib.db.prepare(`SELECT a.file_id,a.entity_id,b.data,b.seq,e.deleted_at FROM main.space_adoptions a
          JOIN main.block b ON b.entity_id=a.entity_id AND b.kind='file' JOIN main.entity e ON e.id=a.entity_id
          WHERE a.space_id=@space ${scope}`).all({ space: space.id }) as { file_id: string; entity_id: string; data: string; seq: number; deleted_at: number | null }[]
        const heads = new Map((space.db.prepare('SELECT fileId,contentVersion FROM file_heads WHERE fileId IN (SELECT value FROM json_each(?))').all(JSON.stringify(adopted.map(a => a.file_id))) as { fileId: string; contentVersion: string }[]).map(h => [h.fileId, h.contentVersion]))
        const references = new Map<string, { id: string; version: string | undefined; seq: number; trashed: boolean }>()
        const reconcile = this.lib.db.prepare(`INSERT INTO main.space_updates VALUES (?,?,?,NULL)
          ON CONFLICT(space_id,file_id) DO UPDATE SET content_version=excluded.content_version,error=CASE WHEN content_version=excluded.content_version THEN error ELSE NULL END`)
        this.lib.db.transaction(() => {
          for (const item of adopted) {
            const parsed = parseSpaceReference(String(JSON.parse(item.data).path))
            if (parsed?.spaceId !== space.id || parsed.fileId !== item.file_id) continue
            references.set(item.file_id, { id: item.entity_id, version: parsed.contentVersion, seq: item.seq, trashed: item.deleted_at !== null })
            const head = heads.get(item.file_id)
            if (head && head !== parsed.contentVersion) reconcile.run(space.id, item.file_id, head)
          }
          this.lib.db.prepare('DELETE FROM temp.space_reference_checks WHERE space_id=?').run(space.id)
        })()
        this.reconciled.add(space)
        const automatic = policy.spaces.some(r => r.spaceId === space.id && r.updates === 'automatic')
        const rows = this.lib.db.prepare('SELECT * FROM main.space_updates WHERE space_id=?').all(space.id) as { file_id: string; content_version: string }[]
        for (const row of rows) {
          const ref = references.get(row.file_id)
          if (!ref || ref.version === row.content_version) {
            this.lib.db.prepare('DELETE FROM main.space_updates WHERE space_id=? AND file_id=?').run(space.id, row.file_id); continue
          }
          const id = ref.id
          result.pending++
          if (!automatic || ref.trashed || space.byId(row.file_id)?.state !== 'available') continue
          try {
            const preview = this.preview(id)
            // 撤销或其他文件块修改后是新的接纳意图；失败回滚后的同状态重试仍沿用请求。
            const accepted = this.accept({ id, expectedPath: preview.expectedPath, contentVersion: preview.current.id, revision: preview.revision,
              requestId: `auto-version-${digest([id, ref.seq, preview.expectedPath, preview.current.id, preview.revision])}` })
            const actual = parseSpaceReference(String(this.store.blocksOf(id).file?.data.path))
            if (actual?.spaceId !== space.id || actual.fileId !== row.file_id || actual.contentVersion !== preview.current.id)
              throw new Error('[ITEM_CHANGED] 回执未使本库引用接纳目标版本，请重新检查')
            if (!accepted.replayed) result.updated++
            result.pending--
          } catch (e) {
            this.lib.db.prepare('UPDATE main.space_updates SET error=? WHERE space_id=? AND file_id=?').run(message(e), space.id, row.file_id)
            if (result.errors.length < 20) result.errors.push({ spaceId: space.id, message: message(e) })
          }
        }
      } catch (e) { if (result.errors.length < 20) result.errors.push({ spaceId: binding.id, message: message(e) }) }
    }
    return result
  }
}
