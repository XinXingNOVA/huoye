// 异步文件编辑用例：准备字节、条件发布、接纳分开；插件不处理实际存储路径。
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'
import type { Library } from './library'
import type { Store } from './store'
import type { Registry } from './registry'
import { SpaceVersions } from '../storage/space-versions'
import { parseDirectoryReference } from '../storage/directory-reference'
import { parseSpaceReference, spaceReference } from '../storage/space-reference'
import { applyFileVersion } from './apply-file-version'
import { prepareFileEditSchema, commitFileEditSchema, discardFileEditSchema, type PrepareFileEdit, type CommitFileEdit,
  type DiscardFileEdit, type FileEditCapabilities, type FileEditPreview, type FileEditResult } from '../shared/file-edits'
import type { StageVersionInput, VersionCommit } from '../shared/space-versions'

const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex')
const message = (e: unknown) => e instanceof Error ? e.message : String(e)
interface EditRecord {
  id: string; prepareRequest: string; itemId: string; owner: string; signature: string; expectedPath: string; seq: number; spaceId: string; token: string
  mode: 'copy' | 'publish'; name: string; storageName: string; ext: string; target?: StageVersionInput['target']; preview?: FileEditPreview; draftId?: string
  commit?: CommitFileEdit; result?: FileEditResult; discarded?: boolean
}
export class FileEdits {
  private running = new Map<string, AbortController>()
  constructor(private lib: Library, private store: Store, private reg: Registry, private changed: (ids: string[]) => void, private owner = 'local') {}
  stop() { for (const c of this.running.values()) c.abort() }
  cancel(requestId: string) { this.running.get(requestId)?.abort() }
  private async run<T>(requestId: string, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.running.has(requestId)) throw new Error('[EDIT_BUSY] 此操作正在进行')
    const controller = new AbortController(); this.running.set(requestId, controller)
    try { return await fn(controller.signal) } finally { this.running.delete(requestId) }
  }
  private reserve(requestId: string, action: string, input: unknown) {
    const signature = hash([this.owner, action, input])
    const old = this.lib.db.prepare('SELECT signature FROM main.file_edit_requests WHERE request_id=?').pluck().get(requestId)
    if (old && old !== signature) throw new Error('[REQUEST_ID_CONFLICT] 此请求 ID 已用于其他文件编辑阶段或参数')
    if (!old) this.lib.db.prepare('INSERT INTO main.file_edit_requests VALUES (?,?)').run(requestId, signature)
  }
  private save(row: EditRecord) { this.lib.db.prepare('UPDATE main.file_edits SET data=? WHERE id=?').run(JSON.stringify(row), row.id) }
  private read(id: string): EditRecord {
    const data = this.lib.db.prepare('SELECT data FROM main.file_edits WHERE id=?').pluck().get(id) as string | undefined
    if (!data) throw new Error('[NOT_FOUND] 编辑不存在')
    const row: EditRecord = JSON.parse(data)
    if (row.owner !== this.owner) throw new Error('[EDIT_SCOPE] 编辑属于其他调用入口')
    return row
  }
  private service(row: EditRecord) {
    const binding = this.lib.files.bindings!.binding(row.spaceId)
    if (binding.token !== row.token) throw new Error('[EDIT_SCOPE] 空间已重新关联，请重新准备')
    return new SpaceVersions(this.lib.files.bindings!.open(row.spaceId), `library:${this.lib.id}:${binding.token}:edits:${this.owner}`)
  }
  private item(id: string) {
    const file = this.store.blocksOf(id).file
    if (!file || !this.store.exists(id) || this.store.isTrashed(id)) throw new Error('[ITEM_UNAVAILABLE] 素材不存在、已回收或没有原文件')
    this.lib.files.readable(String(file.data.path))
    return file
  }
  capabilities(id: string): FileEditCapabilities {
    const targets = this.lib.files.bindings!.list().filter(s => s.state === 'active' && !s.error && s.versioned && s.mode === 'private').map(s => ({ spaceId: s.id, name: s.name }))
    const result: FileEditCapabilities = { id, publish: { allowed: false }, copyTargets: targets,
      ...(!targets.length ? { copyReason: '请先创建并关联一个新版独享空间，作为独立副本的保存位置。' } : {}) }
    try {
      const file = this.item(id), ref = parseSpaceReference(String(file.data.path))
      if (parseDirectoryReference(String(file.data.path))) throw new Error('原地空间采用只读引用，无法发布修改到原件')
      if (!ref?.contentVersion) throw new Error('[LEGACY_STORAGE_UNSUPPORTED] 此旧引用已停止支持，请使用归档工具迁移副本。')
      result.publish.spaceId = ref.spaceId
      const binding = this.lib.files.bindings!.binding(ref.spaceId), space = this.lib.files.bindings!.open(ref.spaceId)
      new SpaceVersions(space, `library:${this.lib.id}:${binding.token}`).assertPermission('revise')
      if (space.db.prepare('SELECT contentVersion FROM file_heads WHERE fileId=?').pluck().get(ref.fileId) !== ref.contentVersion) throw new Error('请先接纳空间当前版，或将修改另存为独立副本。')
      result.publish.allowed = true
    } catch (e) { result.publish.reason = message(e) }
    try { this.item(id) } catch (e) { result.copyTargets = []; result.copyReason = message(e) }
    return result
  }
  async prepare(raw: PrepareFileEdit): Promise<FileEditPreview> {
    const input = prepareFileEditSchema.parse(raw), signature = hash([this.owner, input])
    this.reserve(input.requestId, 'prepare', input)
    return this.run(input.requestId, async signal => {
      const old = this.lib.db.prepare('SELECT id FROM main.file_edits WHERE request_id=?').pluck().get(input.requestId) as string | undefined
      let row: EditRecord
      if (old) {
        row = this.read(old)
        if (row.signature !== signature) throw new Error('[REQUEST_ID_CONFLICT] 请求 ID 已用于其他编辑')
        if (row.discarded) throw new Error('[EDIT_DISCARDED] 编辑已放弃')
        if (row.preview) return row.preview
      } else {
        const file = this.item(input.id), ref = parseSpaceReference(String(file.data.path)), caps = this.capabilities(input.id)
        if ((input.expectedPath !== undefined && input.expectedPath !== file.data.path) || (input.expectedSeq !== undefined && input.expectedSeq !== file.seq)) throw new Error('[FILE_CHANGED] 编辑开始后文件信息已变化，请保留草稿并重新核对')
        if (input.destination.mode === 'publish' && !caps.publish.allowed) throw new Error(caps.publish.reason)
        const spaceId = input.destination.mode === 'publish' ? ref!.spaceId : input.destination.spaceId
        if (input.destination.mode === 'copy' && !caps.copyTargets.some(s => s.spaceId === spaceId)) throw new Error('[COPY_TARGET_REQUIRED] 请指定已关联的新版独享空间')
        const space = this.lib.files.bindings!.open(spaceId)
        row = { id: randomUUID(), prepareRequest: input.requestId, itemId: input.id, owner: this.owner, signature, expectedPath: String(file.data.path), seq: file.seq,
          spaceId, token: this.lib.files.bindings!.binding(spaceId).token, mode: input.destination.mode, name: String(file.data.name), storageName: basename(String(file.data.path).replaceAll('\\', '/')), ext: String(file.data.ext).toLowerCase(),
          ...(input.destination.mode === 'publish' ? { target: { fileId: ref!.fileId, revision: space.byId(ref!.fileId)!.revision } } : {}) }
        this.lib.db.prepare('INSERT INTO main.file_edits VALUES (?,?,?)').run(row.id, input.requestId, JSON.stringify(row))
      }
      const versions = this.service(row)
      let temp: string | undefined
      try {
        let source: string, content: StageVersionInput['content']
        if (input.content.type === 'text') {
          if (!/^(txt|md|markdown|csv|json|lrc|html|xml|svg|yaml|yml)$/i.test(row.ext)) throw new Error('[TEXT_FORMAT_REQUIRED] 此文件类型不能使用文本写入，请提供同格式替换文件')
          temp = await mkdtemp(join(tmpdir(), 'rm-file-edit-'))
          source = join(temp, 'content.' + row.ext); const bytes = Buffer.from(input.content.text)
          await writeFile(source, bytes, { signal, mode: 0o600 })
          content = { name: row.storageName, hash: createHash('sha256').update(bytes).digest('hex'), size: bytes.length }
        } else if (input.content.type === 'current') {
          if (row.mode !== 'copy') throw new Error('原内容复制只用于另存独立副本')
          source = this.lib.files.readable(row.expectedPath)
          const file = this.item(row.itemId)
          if (file.data.path !== row.expectedPath || file.seq !== row.seq) throw new Error('[FILE_CHANGED] 文件已变化')
          content = { name: row.storageName, hash: String(file.data.hash), size: Number(file.data.size) }
        } else {
          source = input.content.path
          if (extname(source).slice(1).toLowerCase() !== row.ext) throw new Error('[FORMAT_MISMATCH] 编辑必须保持原文件格式')
        }
        const stage = await versions.stage({ spaceId: row.spaceId, source, content, target: row.target, requestId: `edit-stage-${row.id}` }, { signal })
        const preview = versions.preview(stage.draft.id)
        row.draftId = stage.draft.id
        row.preview = { editId: row.id, id: row.itemId, mode: row.mode, spaceId: row.spaceId, name: row.name,
          size: preview.draft.size!, hash: preview.draft.hash!, previewToken: preview.previewToken }
        this.save(row); return row.preview
      } finally { if (temp) await rm(temp, { recursive: true, force: true }) }
    })
  }
  async commit(raw: CommitFileEdit): Promise<FileEditResult> {
    const input = commitFileEditSchema.parse(raw)
    this.reserve(input.requestId, 'commit', input)
    return this.run(input.editId, async signal => {
      const row = this.read(input.editId)
      if (!row.preview || !row.draftId || row.discarded) throw new Error('[EDIT_NOT_READY] 编辑尚未准备或已放弃')
      if (row.commit && hash(row.commit) !== hash(input)) throw new Error('[REQUEST_ID_CONFLICT] 此编辑已使用其他提交参数')
      if (input.previewToken !== row.preview.previewToken) throw new Error('[PREVIEW_CHANGED] 预览凭据不一致')
      const versions = this.service(row), commitInput = { spaceId: row.spaceId, draftId: row.draftId, previewToken: input.previewToken, requestId: input.requestId }
      if (row.result && row.result.library.state !== 'pending') return row.result
      const receipt = versions.commitReceipt(commitInput)
      if (!receipt) {
        const file = this.item(row.itemId)
        if (file.data.path !== row.expectedPath || file.seq !== row.seq) throw new Error('[ITEM_CHANGED] 准备后素材文件信息已变化，请重新准备')
        if (row.mode === 'copy' && versions.space.info().mode !== 'private') throw new Error('[COPY_TARGET_CHANGED] 副本目标已不再独享，请重新准备')
      }
      row.commit = input
      this.lib.db.transaction(() => {
        this.save(row)
        // 副本只替换既有素材；失败／重启也不能被自动新增收录抢走。
        if (row.mode === 'copy') this.lib.db.prepare("INSERT INTO main.space_import_seen VALUES (?,?,'seen',NULL) ON CONFLICT(space_id,file_id) DO UPDATE SET state='seen',error=NULL").run(row.spaceId, versions.getDraft(row.draftId!).fileId)
      })()
      const result = receipt ?? await versions.commit(commitInput, { signal })
      return this.finish(row, result)
    })
  }
  private finish(row: EditRecord, space: VersionCommit): FileEditResult {
    try {
      const versions = this.service(row), current = this.store.blocksOf(row.itemId).file
      if (!current || this.store.isTrashed(row.itemId) || current.data.path !== row.expectedPath || current.seq !== row.seq) {
        row.result = { space, library: { state: 'skipped', error: '空间已发布；素材已被修改或回收，保留当前选择。' } }
        this.save(row); return row.result
      }
      versions.read(space.fileId, space.contentVersion)
      const version = versions.version(space.fileId, space.contentVersion), ext = row.ext
      this.store.batch(() => {
        const reference = spaceReference(space.spaceId, version.fileId, version.name, version.id)
        applyFileVersion(this.store, this.reg, row.itemId, current.data, { reference, hash: version.hash, size: version.size, ext })
        this.lib.db.prepare('INSERT INTO main.space_adoptions VALUES (?,?,?) ON CONFLICT(space_id,file_id) DO UPDATE SET entity_id=excluded.entity_id').run(space.spaceId, space.fileId, row.itemId)
        row.result = { space, library: { state: 'accepted' } }; this.save(row)
      })
      this.changed([row.itemId]); return row.result!
    } catch (e) { return { space, library: { state: 'pending', error: message(e) } } }
  }
  discard(raw: DiscardFileEdit) {
    const input = discardFileEditSchema.parse(raw)
    const id = input.editId ?? this.lib.db.prepare('SELECT id FROM file_edits WHERE request_id=?').pluck().get(input.prepareRequestId) as string | undefined
    if (!id) { this.reserve(input.requestId, 'discard', input); return }
    const row = this.read(id)
    if (row.commit && this.service(row).commitReceipt({ spaceId: row.spaceId, draftId: row.draftId!, previewToken: row.commit.previewToken, requestId: row.commit.requestId })) throw new Error('编辑已发布，不能放弃；请用原参数重试确认接纳结果')
    this.reserve(input.requestId, 'discard', input)
    if (this.running.has(row.id) || this.running.has(row.prepareRequest)) throw new Error('[EDIT_BUSY] 编辑正在提交，请先取消或等待结果')
    if (row.draftId) this.service(row).discard(row.draftId, input.requestId)
    row.discarded = true; this.save(row)
  }
  recover(spaceId?: string) {
    const pending = this.lib.db.prepare("SELECT data FROM main.file_edits WHERE json_extract(data,'$.owner')=? AND json_type(data,'$.commit')='object' AND json_extract(data,'$.result') IS NULL AND coalesce(json_extract(data,'$.discarded'),0)=0 AND (? IS NULL OR json_extract(data,'$.spaceId')=?)").all(this.owner, spaceId ?? null, spaceId ?? null) as { data: string }[]
    for (const entry of pending) {
      const row: EditRecord = JSON.parse(entry.data)
      if (!row.commit || !row.draftId || this.running.has(row.id)) continue
      try {
        const receipt = this.service(row).commitReceipt({ spaceId: row.spaceId, draftId: row.draftId, previewToken: row.commit.previewToken, requestId: row.commit.requestId })
        if (receipt) this.finish(row, receipt)
      } catch { /* 离线／解除保留意图；没有回执绝不后台发布。 */ }
    }
  }
  /** 只供宿主权限路由查询，不把空间身份交给远端自报。 */
  target(editId: string) { const row = this.read(editId); return { spaceId: row.spaceId, mode: row.mode } }
}
