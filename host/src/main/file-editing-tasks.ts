// 本机工作副本与恢复清单。版本发布／接纳只调用现有核心协议，不在这里写仓库或空间数据库。
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, open, readdir, readFile, rename, rm } from 'node:fs/promises'
import { extname, isAbsolute, join } from 'node:path'
import { z } from 'zod'
import type { CoreApi } from '../shared/rpc'
import { prepareFileEditSchema } from '../shared/file-edits'
import { checkEditingSchema, editingId, startEditingSchema, finishEditingSchema, type EditDestination, type FileEditingTask, type EditingEndCheck } from '../shared/file-editing'
import { canOpenCopy } from '../shared/open-copy'
import { LibraryFiles } from '../storage/library-files'
import { parseSpaceReference } from '../storage/space-reference'
import { observeFile, diskDigest, sameFingerprint, fingerprint } from '../storage/disk-observation'

const hex = z.string().regex(/^[a-f0-9]{64}$/)
const baseSchema = z.object({ path: z.string(), seq: z.number().int().nonnegative(), hash: hex, ordinal: z.number().optional() })
const recordSchema = z.object({
  version: z.literal(1), id: editingId, libraryId: z.string().min(1), itemId: z.string().min(1), name: z.string(),
  ext: z.string().regex(/^[a-z0-9]{0,16}$/), createdAt: z.number(), updatedAt: z.number(), ended: z.boolean(),
  completed: z.boolean().optional(), cleanup: z.object({ reason: z.enum(['saved', 'discarded']), observation: z.string() }).optional(),
  base: baseSchema, savedHash: hex, error: z.string().optional(),
  attempt: z.object({ input: prepareFileEditSchema, hash: hex, size: z.number().nonnegative(),
    preview: z.object({ editId: editingId, id: z.string(), mode: z.enum(['publish', 'copy']), spaceId: editingId,
      name: z.string(), size: z.number(), hash: hex, previewToken: hex }).optional(),
    commit: z.object({ editId: editingId, previewToken: hex, requestId: editingId }).optional(), confirmed: z.boolean().optional()
  }).optional(),
  lastResult: z.object({ space: z.object({ requestId: z.string(), replayed: z.boolean(), spaceId: editingId, fileId: editingId,
    contentVersion: editingId, revision: z.number(), changeSeq: z.number() }), library: z.object({ state: z.enum(['accepted', 'pending', 'skipped']), error: z.string().optional() }) }).optional()
})
type Record = z.infer<typeof recordSchema>
type Methods = 'get' | 'fileStorageInfo' | 'fileEditCapabilities' | 'prepareFileEdit' | 'commitFileEdit' | 'discardFileEdit'
export interface EditingContext {
  id: string; root: string
  api: { [K in Methods]: (...args: Parameters<CoreApi[K]>) => Promise<Awaited<ReturnType<CoreApi[K]>>> }
  assertCurrent(): void
}
const message = (e: unknown) => e instanceof Error ? e.message : String(e)
const missing = (e: unknown) => (e as NodeJS.ErrnoException).code === 'ENOENT'
const digest = (v: string) => createHash('sha256').update(v).digest('hex')

async function syncFile(path: string) { const h = await open(path, 'r'); try { await h.sync() } finally { await h.close() } }
async function syncDirectory(path: string) { if (process.platform !== 'win32') await syncFile(path) }
async function ordinaryDirectory(path: string) {
  const s = await lstat(path)
  if (!s.isDirectory() || s.isSymbolicLink()) throw new Error('[EDIT_PATH] 工作目录不可用')
}
/** 同一次检查生成独立快照，检测外部程序的覆盖保存与原子替换，不能拿稍后变化的工作文件当预览。 */
async function snapshot(source: string, target: string) {
  const before = await lstat(source)
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('来源不是普通文件，不能采用')
  await copyFile(source, target, constants.COPYFILE_EXCL)
  const [copied, after] = await Promise.all([observeFile(target, ''), lstat(source)])
  if (!copied.hash || !sameFingerprint(fingerprint(before), fingerprint(after))) {
    await rm(target, { force: true }); throw new Error('[EDIT_UNSTABLE] 文件在检查期间变化，请等待保存完成后重试')
  }
  await chmod(target, 0o600); await syncFile(target)
  return { hash: copied.hash, size: before.size }
}

export class FileEditingTasks {
  private busy = new Set<string>()
  constructor(private directory: string) {}
  private scope(id: string) { return join(this.directory, digest(id)) }
  private folder(r: Pick<Record, 'libraryId' | 'id'>) { return join(this.scope(r.libraryId), editingId.parse(r.id)) }
  private work(r: Record) {
    const stem = (r.ext ? r.name.replace(/\.[a-z0-9]{1,16}$/i, '') : r.name.replaceAll('.', '_')).replace(/[\x00-\x1f\x7f/\\:*?"<>|]/g, '_').replace(/[. ]+$/g, '').slice(0, 60) || '文件'
    return join(this.folder(r), `编辑-${stem}${r.ext ? '.' + r.ext : ''}`)
  }
  private snapshotPath(r: Record, request: string) { return join(this.folder(r), `${editingId.parse(request)}${r.ext ? '.' + r.ext : ''}`) }
  private async scopeReady(id: string) {
    await mkdir(this.directory, { recursive: true }); await ordinaryDirectory(this.directory)
    await mkdir(this.scope(id), { recursive: true }); await ordinaryDirectory(this.scope(id))
  }
  private async save(r: Record) {
    r.updatedAt = Date.now()
    const folder = this.folder(r); await ordinaryDirectory(folder)
    const temp = join(folder, 'state-' + randomUUID() + '.tmp')
    const h = await open(temp, 'wx', 0o600)
    try { await h.writeFile(JSON.stringify(r)); await h.sync() } finally { await h.close() }
    try { await rename(temp, join(folder, 'state.json')); await syncDirectory(folder) }
    finally { await rm(temp, { force: true }) }
  }
  private async read(libraryId: string, id: string): Promise<Record> {
    await ordinaryDirectory(this.scope(libraryId)); await ordinaryDirectory(this.folder({ libraryId, id }))
    const path = join(this.folder({ libraryId, id }), 'state.json'), s = await lstat(path)
    if (!s.isFile() || s.isSymbolicLink() || s.size > 128 * 1024) throw new Error('[EDIT_RECORD] 编辑登记无法读取')
    const r = recordSchema.parse(JSON.parse(await readFile(path, 'utf8')))
    if (r.id !== id || r.libraryId !== libraryId) throw new Error('[EDIT_SCOPE] 编辑任务不属于当前仓库')
    if (r.attempt && (r.attempt.input.id !== r.itemId || r.attempt.input.content.type !== 'file' || r.attempt.input.content.path !== this.snapshotPath(r, r.attempt.input.requestId))) throw new Error('[EDIT_RECORD] 编辑快照登记不一致')
    return r
  }
  private async rows(id: string) {
    let entries
    try { await ordinaryDirectory(this.scope(id)); entries = await readdir(this.scope(id), { withFileTypes: true }) }
    catch (e) { if (missing(e)) return []; throw e }
    const rows: Record[] = []
    for (const entry of entries) {
      if (!entry.isDirectory() || !editingId.safeParse(entry.name).success) continue
      try { rows.push(await this.read(id, entry.name)) }
      catch (e) { // 未完成创建没有 state；损坏登记不能静默丢掉或覆盖。
        if (!missing(e)) throw new Error(`编辑任务 ${entry.name} 无法读取，工作文件保留：${message(e)}`)
      }
    }
    return rows.sort((a, b) => b.updatedAt - a.updatedAt)
  }
  private async summary(r: Record): Promise<FileEditingTask> {
    const p = r.attempt?.preview
    let sample: string | undefined
    if (p && /^(txt|md|markdown|csv|json|lrc|xml|svg|yaml|yml)$/.test(r.ext)) {
      try {
        const path = this.snapshotPath(r, r.attempt!.input.requestId), s = await lstat(path)
        if (!s.isFile() || s.isSymbolicLink()) throw new Error('预览不可读取')
        const h = await open(path, 'r')
        try { const bytes = Buffer.alloc(4096); const result = await h.read(bytes, 0, bytes.length, 0); sample = bytes.subarray(0, result.bytesRead).toString('utf8') } finally { await h.close() }
      } catch { /* 预览字节暂不可读仍保留任务及重试入口；提交独立核验空间草稿。 */ }
    }
    return { id: r.id, itemId: r.itemId, name: r.name, createdAt: r.createdAt, updatedAt: r.updatedAt, ended: r.ended,
      baseReference: r.base.path, baseOrdinal: r.base.ordinal, canOpen: canOpenCopy('file.' + r.ext), format: r.ext, destination: r.attempt?.input.destination, error: r.error, lastResult: r.lastResult, cleanupReason: r.cleanup?.reason,
      phase: r.cleanup ? 'cleanup' : r.lastResult?.library.state === 'skipped' && !r.attempt ? 'unadopted' : !r.attempt ? 'editing' : r.attempt.confirmed ? r.lastResult?.library.state === 'pending' ? 'pending' : 'saving' : p ? 'ready' : 'preparing',
      ...(p ? { prepared: { token: p.previewToken, hash: p.hash, size: p.size, destination: r.attempt!.input.destination,
        reference: `_file-edits/${r.id}/${r.attempt!.input.requestId}`, sample } } : {}) }
  }
  async get(ctx: EditingContext, id: string) { ctx.assertCurrent(); return this.summary(await this.read(ctx.id, editingId.parse(id))) }
  async list(ctx: EditingContext) { return Promise.all((await this.rows(ctx.id)).filter(r => !r.completed).map(r => this.summary(r))) }
  private async exclusive<T>(key: string, fn: () => Promise<T>) {
    if (this.busy.has(key)) throw new Error('[EDIT_BUSY] 此仓库的编辑任务正在处理，请稍后重试')
    this.busy.add(key); try { return await fn() } finally { this.busy.delete(key) }
  }
  private task<T>(ctx: EditingContext, id: string, fn: (r: Record) => Promise<T>) {
    return this.exclusive(ctx.id, async () => {
      ctx.assertCurrent(); const r = await this.read(ctx.id, editingId.parse(id))
      if (r.completed || r.ended) throw new Error('[EDIT_ENDED] 此任务已经结束')
      try { return await fn(r) } catch (e) { r.error = message(e); await this.save(r); throw e }
    })
  }
  private async item(ctx: EditingContext, id: string) {
    const view = (await ctx.api.get([id]))[0], file = view?.blocks.file
    if (!file || view.deletedAt) throw new Error('[ITEM_UNAVAILABLE] 素材不存在、已回收或没有原文件；工作副本仍保留')
    return file
  }
  async start(ctx: EditingContext, raw: z.infer<typeof startEditingSchema>) {
    const input = startEditingSchema.parse(raw)
    if (input.source && !isAbsolute(input.source)) throw new Error('[EDIT_PATH] 替换文件必须使用本机绝对路径')
    return this.exclusive(ctx.id, async () => {
      ctx.assertCurrent(); await this.scopeReady(ctx.id)
      const existing = (await this.rows(ctx.id)).find(r => !r.completed && !r.ended && r.itemId === input.id)
      if (existing) {
        if (input.source) throw new Error('[EDIT_EXISTS] 已有编辑任务，请先继续或结束它，避免覆盖未保存修改')
        return this.summary(existing)
      }
      const file = await this.item(ctx, input.id), info = await ctx.api.fileStorageInfo(input.id)
      const ext = String(file.data.ext ?? '').toLowerCase(), ref = parseSpaceReference(String(file.data.path))
      if (!/^[a-z0-9]{0,16}$/.test(ext) || !ref?.contentVersion) throw new Error('[FORMAT_REQUIRED] 文件格式或版本引用不可用')
      if (input.source && extname(input.source).slice(1).toLowerCase() !== ext) throw new Error('[FORMAT_MISMATCH] 请选择同格式文件；格式转换应另作素材导入')
      const r: Record = { version: 1, id: randomUUID(), libraryId: ctx.id, itemId: input.id, name: String(file.data.name), ext,
        createdAt: Date.now(), updatedAt: Date.now(), ended: false,
        base: { path: String(file.data.path), seq: file.seq, hash: String(file.data.hash), ordinal: info.contentOrdinal }, savedHash: String(file.data.hash) }
      const files = new LibraryFiles(ctx.root), source = input.source ?? files.readable(r.base.path)
      await mkdir(this.folder(r))
      try {
        const copied = await snapshot(source, this.work(r))
        if (!input.source && copied.hash !== r.base.hash) throw new Error('[FILE_CHANGED] 原件与登记不一致，请先进行磁盘检查')
        const current = await this.item(ctx, input.id); ctx.assertCurrent()
        if (current.data.path !== r.base.path || current.seq !== r.base.seq) throw new Error('[FILE_CHANGED] 创建副本期间素材已变化，请重试')
        await this.save(r); return this.summary(r)
      } catch (e) { await rm(this.folder(r), { recursive: true, force: true }); throw e }
    })
  }
  async open(ctx: EditingContext, id: string, launch: (path: string) => Promise<string>, explicitEditor = false) {
    return this.task(ctx, id, async r => {
      if (r.cleanup) throw new Error('修改已处理，工作副本待清理；请先重试清理')
      if (!explicitEditor && !canOpenCopy('file.' + r.ext)) throw new Error('[EDITOR_REQUIRED] 此格式需要明确选择编辑器，不启动系统关联')
      const status = await lstat(this.work(r))
      if (!status.isFile() || status.isSymbolicLink()) throw new Error('工作副本不是可读取的普通文件')
      ctx.assertCurrent(); const error = await launch(this.work(r))
      if (error) throw new Error(`编辑器打开失败：${error}。任务和工作副本保留，可重试。`)
      r.error = undefined; await this.save(r)
    })
  }
  async reveal(ctx: EditingContext, id: string, reveal: (path: string) => void) {
    const r = await this.read(ctx.id, editingId.parse(id)); ctx.assertCurrent(); reveal(this.work(r))
  }
  async check(ctx: EditingContext, raw: z.infer<typeof checkEditingSchema>) {
    const input = checkEditingSchema.parse(raw)
    return this.task(ctx, input.taskId, r => this.prepare(ctx, r, input.destination))
  }
  private async prepare(ctx: EditingContext, r: Record, destination: EditDestination) {
    if (r.cleanup) throw new Error('保存已完成，请先重试清理工作副本')
    if (!r.attempt) {
      const observation = await observeFile(this.work(r), r.savedHash)
      if (!observation.hash) throw new Error(observation.error ?? '工作文件不可用')
      if (observation.state === 'unchanged') { r.error = undefined; await this.save(r); return { task: await this.summary(r), unchanged: true } }
      const file = await this.item(ctx, r.itemId)
      if (destination.mode === 'publish' && (file.data.path !== r.base.path || file.seq !== r.base.seq)) throw new Error('[EDIT_CONFLICT] 编辑开始后本库文件已变化。工作副本保留；可以另存独立副本或结束后重新编辑')
      const caps = await ctx.api.fileEditCapabilities(r.itemId)
      if (destination.mode === 'publish' && !caps.publish.allowed) throw new Error(caps.publish.reason)
      if (destination.mode === 'copy' && !caps.copyTargets.some(t => t.spaceId === destination.spaceId)) throw new Error('请选择可用的独享空间')
      const requestId = randomUUID(), path = this.snapshotPath(r, requestId)
      const copied = await snapshot(this.work(r), path)
      r.attempt = { input: { id: r.itemId, requestId, expectedPath: String(file.data.path), expectedSeq: file.seq,
        destination, content: { type: 'file', path } }, ...copied }
      r.lastResult = undefined; r.error = undefined; await this.save(r)
    } else if (JSON.stringify(destination) !== JSON.stringify(r.attempt.input.destination)) throw new Error('请先放弃本次准备，再选择其他保存方式')
    if (!r.attempt.preview) {
      ctx.assertCurrent(); const p = await ctx.api.prepareFileEdit(r.attempt.input)
      if (p.hash !== r.attempt.hash || p.size !== r.attempt.size) throw new Error('[EDIT_SNAPSHOT_CHANGED] 提交快照发生变化，请放弃准备后重试')
      r.attempt.preview = p; r.attempt.commit = { editId: p.editId, previewToken: p.previewToken, requestId: randomUUID() }
      r.error = undefined; await this.save(r)
    }
    return { task: await this.summary(r), unchanged: false }
  }
  async commit(ctx: EditingContext, id: string, token: string) {
    hex.parse(token)
    return this.task(ctx, id, r => this.publish(ctx, r, token))
  }
  private async publish(ctx: EditingContext, r: Record, token: string) {
    const a = r.attempt
    if (!a?.preview || !a.commit || a.preview.previewToken !== token) throw new Error('[EDIT_PREVIEW] 请先检查修改，使用当前确认结果')
    if (!a.confirmed) {
      const current = await observeFile(this.work(r), a.hash)
      if (current.state !== 'unchanged') throw new Error('[EDIT_CHANGED] 预览后工作副本又有变化，请放弃本次准备并重新检查')
      a.confirmed = true; await this.save(r)
    }
    ctx.assertCurrent(); const result = await ctx.api.commitFileEdit(a.commit)
    r.lastResult = result; r.error = result.library.error
    if (result.library.state !== 'pending') {
      // 回执可能是重放；不能把稍后由其他操作选择的版本变成本任务的编辑基线。
      if (result.library.state === 'accepted') {
        const file = (await ctx.api.get([r.itemId]))[0]?.blocks.file, ref = file && parseSpaceReference(String(file.data.path))
        if (file && ref?.spaceId === result.space.spaceId && ref.fileId === result.space.fileId && ref.contentVersion === result.space.contentVersion) {
          r.base = { path: String(file.data.path), seq: file.seq, hash: a.hash }
          try { r.base.ordinal = (await ctx.api.fileStorageInfo(r.itemId)).contentOrdinal } catch { /* 版本身份已确认，离线不丢结果。 */ }
        } else {
          r.lastResult = { ...result, library: { state: 'skipped', error: '修改已经保存在空间，但素材引用随后变化；请核对本库内容' } }
        }
      }
      r.savedHash = a.hash; r.attempt = undefined
    }
    await this.save(r)
    if (!r.attempt) await rm(this.snapshotPath(r, a.input.requestId), { force: true }).catch(() => {})
    return this.summary(r)
  }
  async discardPrepared(ctx: EditingContext, id: string) {
    return this.task(ctx, id, async r => {
      const oldRequest = r.attempt?.input.requestId
      if (r.attempt) {
        ctx.assertCurrent(); await ctx.api.discardFileEdit({ prepareRequestId: r.attempt.input.requestId, requestId: `end-${r.attempt.input.requestId}` })
        r.attempt = undefined
      }
      r.error = undefined; await this.save(r)
      if (oldRequest) await rm(this.snapshotPath(r, oldRequest), { force: true }).catch(() => {})
      return this.summary(r)
    })
  }
  private async endCheck(r: Record): Promise<EditingEndCheck> {
    const observation = await observeFile(this.work(r), r.savedHash)
    return { token: diskDigest([r.updatedAt, observation]), changed: observation.state !== 'unchanged', problem: observation.error }
  }
  async inspectEnd(ctx: EditingContext, id: string) { const r = await this.read(ctx.id, editingId.parse(id)); return this.endCheck(r) }
  /** 一次明确的完成意图。中断后沿 attempt／回执／cleanup 接续，绝不后台发布。 */
  async finish(ctx: EditingContext, raw: z.infer<typeof finishEditingSchema>) {
    const input = finishEditingSchema.parse(raw)
    return this.exclusive(ctx.id, async () => {
      ctx.assertCurrent(); const r = await this.read(ctx.id, input.taskId)
      if (r.completed) return null
      try {
        if (r.cleanup) { await this.clean(ctx, r); return null }
        if (r.ended) throw new Error('旧任务已结束；可以显示工作副本或确认清理')
        if (!r.attempt && r.lastResult?.library.state === 'skipped') throw new Error('修改已保存在空间，但素材已变化，本库未接纳。请核对素材；工作副本保留，可明确放弃后清理')
        const checked = await this.prepare(ctx, r, input.destination ?? r.attempt?.input.destination ?? { mode: 'publish' })
        if (!checked.unchanged) {
          await this.publish(ctx, r, r.attempt!.preview!.previewToken)
          if (r.attempt || r.lastResult?.library.state !== 'accepted') return this.summary(r)
        }
        const observation = await observeFile(this.work(r), r.savedHash)
        if (observation.state !== 'unchanged') throw new Error('本次保存已完成，但工作副本又有修改或不可读取；继续保留，请核对后再次完成编辑')
        r.cleanup = { reason: 'saved', observation: diskDigest(observation) }
        await this.save(r); await this.clean(ctx, r)
        return null
      } catch (e) { r.error = message(e); await this.save(r); throw e }
    })
  }
  async discard(ctx: EditingContext, id: string, token: string) {
    return this.exclusive(ctx.id, async () => {
      ctx.assertCurrent(); const r = await this.read(ctx.id, editingId.parse(id))
      if (r.completed) return
      try {
        const observation = await observeFile(this.work(r), r.savedHash)
        if (diskDigest([r.updatedAt, observation]) !== hex.parse(token)) throw new Error('[EDIT_CHANGED] 工作副本又有变化，请重新确认放弃')
        if (r.attempt) {
          // 已发布／结果不确定时，核心拒绝丢弃；先完成回执核对和接纳。
          await ctx.api.discardFileEdit({ prepareRequestId: r.attempt.input.requestId, requestId: `end-${r.attempt.input.requestId}` })
          r.attempt = undefined
        }
        r.cleanup = { reason: 'discarded', observation: diskDigest(observation) }
        await this.save(r); await this.clean(ctx, r)
      } catch (e) { r.error = message(e); await this.save(r); throw e }
    })
  }
  private async clean(ctx: EditingContext, r: Record) {
    ctx.assertCurrent()
    const observation = await observeFile(this.work(r), r.savedHash)
    // 缺失也可能是上次已删副本、写完成回执前中断；清理阶段可以接续。
    if (observation.state !== 'missing' && diskDigest(observation) !== r.cleanup!.observation) {
      r.cleanup = undefined; r.ended = false
      throw new Error('[EDIT_CHANGED] 清理前工作副本又有变化，已保留；请重新核对')
    }
    const entries = await readdir(this.folder(r)), name = this.work(r).split(/[\\/]/).at(-1)!
    const owned = (entry: string) => entry === name || (r.ext ? entry.endsWith('.' + r.ext) && editingId.safeParse(entry.slice(0, -r.ext.length - 1)).success : editingId.safeParse(entry).success) || /^state-[a-f0-9-]+\.tmp$/.test(entry)
    if (entries.some(entry => entry !== 'state.json' && !owned(entry))) throw new Error('工作目录中有外部程序生成的其他文件，请先显示工作副本并移走这些文件，再重试清理')
    for (const entry of entries.filter(owned)) await rm(join(this.folder(r), entry), { force: true })
    // 保留很小的完成回执，响应丢失后重复完成不会再发布或删除新任务；工作文件和快照已清理。
    r.completed = true; r.ended = true; r.cleanup = undefined; r.error = undefined
    await this.save(r)
  }
  async previewPath(libraryId: string, taskId: string, request: string): Promise<string> {
    const r = await this.read(libraryId, editingId.parse(taskId))
    if (!r.attempt?.preview || r.attempt.input.requestId !== editingId.parse(request)) throw new Error('预览已结束')
    const path = this.snapshotPath(r, request), observation = await observeFile(path, r.attempt.hash)
    if (observation.state !== 'unchanged') throw new Error('预览快照不可用')
    return path
  }
}
