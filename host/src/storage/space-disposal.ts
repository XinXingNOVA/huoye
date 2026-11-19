// 内容物理处置的持久协议。平台只提供 trashDirectory，不得自行拼路径或删除仓库数据。
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { mkdir, open, rename, rmdir, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { FileSpace } from './file-space'
import { SpaceVersions } from './space-versions'
import { fileReference } from '../shared/file-location'
import { portableFileName } from '../shared/paths'
import { disposalInputSchema, disposalPreviewSchema, type DisposalInput, type DisposalSelection,
  type DisposalPreview, type DisposalResult, type PendingDisposal } from '../shared/space-disposal'

type RecordRow = { archived_at: number | null; cleaned_at: number | null; disposal_id: string | null; busy_request: string | null }
type Job = { id: string; file_id: string; bundle: string; manifest: string; stage: 'prepared' | 'staged' | 'calling' | 'trashed' | 'uncertain' | 'restored' | 'cleaned'; error: string | null }
type Version = { id: string; fileId: string; path: string; hash: string; size: number; mtime: number }
type Manifest = { format: 1; spaceId: string; fileId: string; disposalId: string; name: string; versions: Version[]; extraPaths: string[] }
type Command = { request_id: string; signature: string; input: string; items: string; finished: number; pid: number }
export interface DisposalPlatform { trashDirectory(path: string): Promise<void> }
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex')
const message = (e: unknown) => e instanceof Error ? e.message : String(e)
const alive = (pid: number) => { if (!pid) return false; try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code !== 'ESRCH' } }
const marker = 'file-space-recovery.json'
async function syncDir(path: string) {
  if (process.platform === 'win32') return
  const handle = await open(path, 'r'); try { await handle.sync() } finally { await handle.close() }
}

/** 仅应用主进程装配此服务。仓库、插件和 MCP 不自动取得物理处置权。 */
export class SpaceDisposal {
  constructor(private space: FileSpace, private platform: DisposalPlatform) { new SpaceVersions(space) }
  private target(id: string) { if (id !== this.space.id) throw new Error('[FILE_SPACE_IDENTITY] 空间身份不匹配') }
  private record(id: string): RecordRow {
    return this.space.db.prepare('SELECT * FROM space_file_records WHERE file_id=?').get(id) as RecordRow ??
      { archived_at: null, cleaned_at: null, disposal_id: null, busy_request: null }
  }
  private job(id: string): Job | undefined {
    const disposal = this.record(id).disposal_id
    return disposal ? this.space.db.prepare('SELECT * FROM space_disposals WHERE id=?').get(disposal) as Job : undefined
  }
  private versions(id: string) {
    return this.space.db.prepare('SELECT id,fileId,path,hash,size,mtime FROM file_versions WHERE fileId=? ORDER BY ordinal').all(id) as Version[]
  }
  private fileDir(id: string) { return 'files/.versions/' + id }
  /** 包含不存在的尾路径也检查所有已有父级；拒绝符号链接与非目录父级。 */
  private path(relative: string) {
    let path = realpathSync(this.space.root)
    for (const part of fileReference(relative).split('/')) {
      path = join(path, part)
      try { if (lstatSync(path).isSymbolicLink()) throw new Error('[UNSAFE_PATH] 处置路径不能使用符号链接') }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
    }
    return path
  }
  private hasDraft(id: string) {
    return !!this.space.db.prepare("SELECT 1 FROM space_disk_operations WHERE result IS NULL AND json_extract(plan, '$.version.fileId')=?").get(id) || !!this.space.db.prepare("SELECT 1 FROM version_drafts WHERE fileId=? AND state NOT IN ('committed','discarded')").get(id)
  }
  private manifest(id: string, disposalId: string): Manifest {
    const versions = this.versions(id), prefix = this.fileDir(id) + '/'
    if (!versions.length || versions.some(v => !v.path.startsWith(prefix))) throw new Error('[INVALID_VERSION] 版本位置与文件身份不匹配')
    const discarded = this.space.db.prepare("SELECT path FROM version_drafts WHERE fileId=? AND state='discarded' UNION SELECT path FROM space_disk_locations WHERE file_id=?").all(id, id) as { path: string }[]
    const extraPaths = discarded.flatMap(d => {
      if (!d.path.startsWith(prefix)) throw new Error('[INVALID_VERSION] 草稿位置与文件身份不匹配')
      return [d.path.slice(prefix.length), dirname(d.path.slice(prefix.length)) + '/.draft-partial']
    })
    return { format: 1, spaceId: this.space.id, fileId: id, disposalId, name: basename(this.space.byId(id)!.path), versions, extraPaths }
  }
  /** 绝不把夹杂的未知文件或链接送入废纸篓。文件内容哈希在恢复时逐一核验。 */
  private inspectTree(base: string, manifest: Manifest, requirePublished = true) {
    const prefix = this.fileDir(manifest.fileId) + '/'
    const expected = new Set([...manifest.versions.map(v => v.path.slice(prefix.length)), ...manifest.extraPaths])
    const actual = new Set<string>()
    const walk = (relative: string) => {
      const dir = relative ? join(base, relative) : base
      if (!lstatSync(dir).isDirectory() || lstatSync(dir).isSymbolicLink()) throw new Error('[UNSAFE_PATH] 文件包目录无效')
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const rel = relative ? relative + '/' + entry.name : entry.name
        if (entry.isSymbolicLink()) throw new Error('[UNSAFE_PATH] 文件包内有符号链接')
        if (entry.isDirectory()) {
          if (![...expected].some(p => p.startsWith(rel + '/'))) throw new Error('[UNKNOWN_CONTENT] 文件目录含未登记的内容')
          walk(rel)
        } else if (entry.isFile() && expected.has(rel)) actual.add(rel)
        else throw new Error('[UNKNOWN_CONTENT] 文件目录含未登记的内容')
      }
    }
    walk('')
    if (requirePublished && manifest.versions.some(v => !actual.has(v.path.slice(prefix.length)))) throw new Error('[FILE_MISSING] 历史版本不完整，请先核对文件')
  }
  private assertBundle(job: Job) {
    const dir = this.path(job.bundle)
    const names = readdirSync(dir)
    if (names.some(n => n !== marker && n !== 'versions')) throw new Error('[UNKNOWN_CONTENT] 恢复包含未登记内容')
    const manifestPath = this.path(job.bundle + '/' + marker)
    if (readFileSync(manifestPath, 'utf8') !== job.manifest) throw new Error('[RECOVERY_MISMATCH] 恢复包标识不匹配')
    return JSON.parse(job.manifest) as Manifest
  }
  private assertSnapshots(base: string, manifest: Manifest) {
    const prefix = this.fileDir(manifest.fileId) + '/'
    for (const version of manifest.versions) {
      const now = statSync(join(base, version.path.slice(prefix.length)))
      if (now.size !== version.size || now.mtimeMs !== version.mtime) throw new Error('[FILE_CHANGED] 原件在应用外变化，请先核对内容')
    }
  }
  private reason(input: DisposalSelection, id: string, revision: number, continuing?: string) {
    const file = this.space.byId(id), record = this.record(id), job = this.job(id)
    if (!file) return '文件身份不存在'
    if (file.revision !== revision) return '文件已变化，请重新预览'
    if (record.busy_request && record.busy_request !== continuing) return '有未完成的处置，请先继续该任务'
    if (input.action === 'archive' || input.action === 'unarchive') return undefined
    if (record.cleaned_at) return '版本明细已清理，不能再处置或核验原身份'
    if (this.hasDraft(id)) return '有未完成的文件编辑草稿，请先发布或放弃草稿'
    if (input.action === 'clean') {
      if (file.state !== 'disposed' || job?.stage !== 'trashed') return '仅可清理已确认移到系统废纸篓的记录'
      if (existsSync(this.path(this.fileDir(id))) || existsSync(this.path(job.bundle))) return '发现还原的内容，请先核验恢复'
      return undefined
    }
    if (input.action === 'verify') {
      if (!job || !['disposing', 'disposed'].includes(file.state)) return '没有待核验的物理处置'
      if (!existsSync(this.path(job.bundle))) return '请先在系统废纸篓还原文件包到原位置，再检查'
      this.assertBundle(job)
      if (!existsSync(this.path(job.bundle + '/versions')) && !existsSync(this.path(this.fileDir(id)))) return '恢复包没有文件内容'
      return undefined
    }
    if (file.state === 'disposed') return '已经移到系统废纸篓；若已还原，请核验恢复'
    if (!['available', 'recycled', 'disposing'].includes(file.state)) return '文件当前不可处置'
    if (job && file.state === 'disposing') {
      if (job.stage === 'prepared') return undefined // 接续清单写入或原子移动；执行时仍检查包和内容。
      if (!existsSync(this.path(job.bundle))) return '上次处置结果待核对；请先从系统废纸篓还原文件包'
      this.assertBundle(job)
      return undefined
    }
    const manifest = this.manifest(id, 'preview')
    this.inspectTree(this.path(this.fileDir(id)), manifest)
    this.assertSnapshots(this.path(this.fileDir(id)), manifest)
    return undefined
  }
  preview(raw: DisposalSelection): DisposalPreview {
    const input = disposalPreviewSchema.parse(raw); this.target(input.spaceId)
    return this.previewFiles(input)
  }
  private previewFiles(input: DisposalSelection, continuing?: string): DisposalPreview {
    const info = this.space.info()
    const files = input.files.map(choice => {
      const file = this.space.byId(choice.id), versions = this.versions(choice.id), job = this.job(choice.id)
      let reason: string | undefined
      try { reason = this.reason(input, choice.id, choice.revision, continuing) } catch (e) { reason = message(e) }
      return { id: choice.id, name: file ? basename(file.path) : choice.id, versions: versions.length,
        bytes: versions.reduce((sum, v) => sum + v.size, 0), reason,
        ...(job ? { recoveryPath: join(this.space.root, job.bundle) } : {}) }
    })
    return { action: input.action, members: info.members, spaceName: info.name, files,
      previewToken: hash([input, info.revision, files, input.files.map(f => [this.record(f.id), this.job(f.id)])]) }
  }
  /** 应用组合流程只读核对回执；不会启动或接续文件操作。 */
  receipt(raw: DisposalInput) {
    const input = disposalInputSchema.parse(raw); this.target(input.spaceId)
    const row = this.space.db.prepare('SELECT * FROM space_disposal_commands WHERE request_id=?').get(input.requestId) as Command | undefined
    if (!row) return undefined
    if (row.signature !== hash(input)) throw new Error('[REQUEST_ID_CONFLICT] 处置回执不匹配')
    return { finished: !!row.finished, running: !row.finished && alive(row.pid), items: JSON.parse(row.items) as DisposalResult['items'] }
  }
  continuationPreview(input: DisposalInput): DisposalPreview {
    const receipt = this.receipt(input)
    if (!receipt || receipt.finished) throw new Error('[DISPOSAL_CHANGED] 待接续任务已变化')
    const files = input.files.filter(f => !receipt.items.some(i => i.id === f.id))
      .map(f => ({ id: f.id, revision: this.space.byId(f.id)?.revision ?? f.revision }))
    const preview = this.previewFiles({ spaceId: input.spaceId, action: input.action, files }, input.requestId)
    // 单文件成功事实已提交，但命令项目回执尚未写入的崩溃窗口。
    for (const file of preview.files) if (this.confirmedDisposed(file.id)) file.reason = undefined
    if (receipt.running) for (const file of preview.files) file.reason = '处置仍在运行，请稍后刷新'
    return { ...preview, previewToken: hash([preview.previewToken, receipt]) }
  }
  /** 曾成功的步骤只有在原件仍处置且没有还原包时才能跳过。 */
  confirmedDisposed(id: string): boolean {
    const job = this.job(id)
    return this.space.byId(id)?.state === 'disposed' && !!job && ['trashed', 'cleaned'].includes(job.stage)
      && !existsSync(this.path(this.fileDir(id))) && !existsSync(this.path(job.bundle))
  }
  pending(spaceId: string): PendingDisposal[] {
    this.target(spaceId)
    return (this.space.db.prepare('SELECT * FROM space_disposal_commands WHERE finished=0').all() as Command[])
      .map(c => { const input: DisposalInput = JSON.parse(c.input); return { requestId: c.request_id, action: input.action, total: input.files.length, completed: JSON.parse(c.items).length, running: alive(c.pid) } })
  }
  resume(spaceId: string, requestId: string) {
    this.target(spaceId)
    const command = this.space.db.prepare('SELECT * FROM space_disposal_commands WHERE request_id=?').get(requestId) as Command | undefined
    if (!command) throw new Error('[NOT_FOUND] 处置任务不存在')
    return this.execute(JSON.parse(command.input))
  }
  async execute(raw: DisposalInput): Promise<DisposalResult> {
    const input = disposalInputSchema.parse(raw); this.target(input.spaceId)
    const signature = hash(input), db = this.space.db
    const command = this.space.exclusive(() => {
      const old = db.prepare('SELECT * FROM space_disposal_commands WHERE request_id=?').get(input.requestId) as Command | undefined
      if (old) {
        if (old.signature !== signature) throw new Error('[REQUEST_ID_CONFLICT] 请求 ID 已用于其他处置')
        if (!old.finished && alive(old.pid)) throw new Error('[DISPOSAL_BUSY] 处置仍在运行')
        if (!old.finished) db.prepare('UPDATE space_disposal_commands SET pid=? WHERE request_id=?').run(process.pid, input.requestId)
        return old
      }
      const preview = this.preview(inputWithoutExecution(input))
      if (preview.previewToken !== input.previewToken) throw new Error('[PREVIEW_CHANGED] 文件或空间已变化，请重新预览')
      if (preview.files.some(f => f.reason)) throw new Error(preview.files.find(f => f.reason)!.reason)
      db.prepare('INSERT INTO space_disposal_commands(request_id,signature,input,pid) VALUES (?,?,?,?)').run(input.requestId, signature, JSON.stringify(input), process.pid)
      for (const f of input.files) {
        db.prepare('INSERT OR IGNORE INTO space_file_records(file_id) VALUES (?)').run(f.id)
        db.prepare('UPDATE space_file_records SET busy_request=? WHERE file_id=?').run(input.requestId, f.id)
      }
      return { request_id: input.requestId, signature, input: JSON.stringify(input), items: '[]', finished: 0, pid: process.pid }
    })
    const items: DisposalResult['items'] = JSON.parse(command.items)
    if (command.finished) return { requestId: input.requestId, action: input.action, items, replayed: true }
    // 跨平台文件操作不能放进长数据库事务。每个完成项持久记录，崩溃后显式继续。
    try {
      for (const choice of input.files) {
        if (items.some(item => item.id === choice.id)) continue
        let outcome: DisposalResult['items'][number]
        const name = basename(this.space.byId(choice.id)?.path ?? choice.id)
        try {
          if (this.record(choice.id).busy_request !== input.requestId) throw new Error('[DISPOSAL_CHANGED] 处置占用已变化')
          if (input.action === 'trash') await this.trash(choice.id)
          else if (input.action === 'verify') await this.verify(choice.id)
          else this.recordAction(choice.id, input.action)
          outcome = { id: choice.id, name, outcome: 'done', message: input.action === 'trash' ? '已移到系统废纸篓' : input.action === 'verify' ? '已核验，恢复读取' : '记录已更新' }
        } catch (e) { outcome = { id: choice.id, name, outcome: 'failed', message: message(e) } }
        items.push(outcome)
        this.space.exclusive(() => {
          db.prepare('UPDATE space_disposal_commands SET items=? WHERE request_id=?').run(JSON.stringify(items), input.requestId)
          db.prepare('UPDATE space_file_records SET busy_request=NULL WHERE file_id=? AND busy_request=?').run(choice.id, input.requestId)
        })
      }
      db.prepare('UPDATE space_disposal_commands SET finished=1,pid=0 WHERE request_id=?').run(input.requestId)
      return { requestId: input.requestId, action: input.action, items, replayed: false }
    } finally {
      // 普通异常可立即继续；进程被杀则保留 PID，由下一进程核对其是否仍存活。
      db.prepare('UPDATE space_disposal_commands SET pid=0 WHERE request_id=?').run(input.requestId)
    }
  }
  private updateFile(id: string, type: string, state?: 'disposing' | 'disposed' | 'available') {
    const db = this.space.db
    db.prepare('UPDATE files SET revision=revision+1,state=coalesce(?,state) WHERE id=?').run(state ?? null, id)
    const file = this.space.byId(id)!, head = db.prepare('SELECT contentVersion FROM file_heads WHERE fileId=?').pluck().get(id) as string
    db.prepare('INSERT INTO space_changes(fileId,contentVersion,revision,type,createdAt) VALUES (?,?,?,?,?)').run(id, head, file.revision, type, Date.now())
    this.space.bump()
  }
  private async trash(id: string) {
    const db = this.space.db
    let job = this.space.exclusive(() => {
      const file = this.space.byId(id)!, old = this.job(id)
      if (old && ['disposing', 'disposed'].includes(file.state)) return old
      if (!['available', 'recycled'].includes(file.state) || this.hasDraft(id)) throw new Error('[FILE_CHANGED] 原件或编辑状态已变化')
      const jobId = randomUUID(), manifest = JSON.stringify(this.manifest(id, jobId))
      // 可辨认的名字便于在系统废纸篓找到；身份以数据库与清单为准，名称经过跨平台清理。
      const label = Array.from(portableFileName(basename(file.path))).slice(0, 30).join('') || 'file'
      const value: Job = { id: jobId, file_id: id, bundle: '.disposals/' + label + '--' + jobId, manifest, stage: 'prepared', error: null }
      db.prepare('INSERT INTO space_disposals(id,file_id,bundle,manifest,stage,created_at) VALUES (?,?,?,?,?,?)').run(jobId, id, value.bundle, manifest, value.stage, Date.now())
      db.prepare('UPDATE space_file_records SET disposal_id=? WHERE file_id=?').run(jobId, id)
      this.updateFile(id, 'disposalStarted', 'disposing')
      db.prepare('INSERT INTO recycled_files VALUES (?,?) ON CONFLICT(file_id) DO NOTHING').run(id, Date.now())
      return value
    })
    if (job.stage === 'trashed') return // 系统成功回执已落库，响应丢失时不再处置。
    const source = this.path(this.fileDir(id)), bundle = this.path(job.bundle), content = this.path(job.bundle + '/versions')
    try {
      if (job.stage === 'prepared') {
        await mkdir(bundle, { recursive: true }); this.path(job.bundle)
        const markerPath = this.path(job.bundle + '/' + marker)
        // 重试只修复本协议创建的同一清单，不接受来源不明的包。
        if (existsSync(markerPath) && readFileSync(markerPath, 'utf8') !== job.manifest) throw new Error('[RECOVERY_MISMATCH] 恢复包标识不匹配')
        const temporaryMarker = this.path(job.bundle + '/' + marker + '.tmp')
        const handle = await open(temporaryMarker, 'w', 0o600)
        try { await handle.writeFile(job.manifest); await handle.sync() } finally { await handle.close() }
        await rename(temporaryMarker, markerPath)
        await syncDir(bundle); await syncDir(dirname(bundle)); await syncDir(this.space.root)
        this.assertBundle(job)
        if (existsSync(source)) {
          if (existsSync(content)) throw new Error('[RECOVERY_CONFLICT] 原位置与处置包同时存在，未移动任何内容')
          this.inspectTree(source, JSON.parse(job.manifest))
          this.assertSnapshots(source, JSON.parse(job.manifest))
          await rename(source, content)
          await syncDir(dirname(source)); await syncDir(bundle)
        }
        this.inspectTree(content, JSON.parse(job.manifest))
        db.prepare("UPDATE space_disposals SET stage='staged',error=NULL WHERE id=?").run(job.id)
        job = { ...job, stage: 'staged' }
      }
      // 若系统调用成功与回执落库之间中断，不能仅因包消失就推断成功，也不盲目再调用系统。
      if (!existsSync(bundle)) throw new Error('[DISPOSAL_UNCERTAIN] 处置包不在原位，结果待核对；请从系统废纸篓还原后核验')
      this.assertBundle(job)
      if (existsSync(source)) throw new Error('[RECOVERY_CONFLICT] 原位置出现内容，需先核对')
      this.inspectTree(content, JSON.parse(job.manifest))
      this.assertSnapshots(content, JSON.parse(job.manifest))
      db.prepare("UPDATE space_disposals SET stage='calling',error=NULL WHERE id=?").run(job.id)
      await this.platform.trashDirectory(bundle)
      if (existsSync(bundle)) throw new Error('[DISPOSAL_UNCERTAIN] 系统返回后文件包仍在原位，未确认移走')
      this.space.exclusive(() => {
        db.prepare("UPDATE space_disposals SET stage='trashed',error=NULL WHERE id=?").run(job.id)
        this.updateFile(id, 'systemTrashed', 'disposed')
        db.prepare('INSERT INTO recycled_files VALUES (?,?) ON CONFLICT(file_id) DO UPDATE SET recycled_at=excluded.recycled_at').run(id, Date.now())
      })
    } catch (e) {
      db.prepare('UPDATE space_disposals SET error=? WHERE id=?').run(message(e), job.id)
      throw e
    }
  }
  private async verify(id: string) {
    const db = this.space.db, job = this.job(id)
    if (!job || this.record(id).cleaned_at) throw new Error('[RECOVERY_UNAVAILABLE] 恢复依据已清理')
    if (job.stage === 'restored' && this.space.byId(id)?.state === 'available') return
    if (this.hasDraft(id)) throw new Error('[EDIT_BUSY] 仍有未完成的编辑')
    const manifest = this.assertBundle(job)
    if (hash(manifest.versions) !== hash(this.versions(id))) throw new Error('[RECOVERY_MISMATCH] 版本登记发生变化')
    const source = this.path(this.fileDir(id)), content = this.path(job.bundle + '/versions')
    if (existsSync(source) && existsSync(content)) throw new Error('[RECOVERY_CONFLICT] 原位置已有内容，未覆盖')
    const base = existsSync(content) ? content : source
    this.inspectTree(base, manifest)
    const prefix = this.fileDir(id) + '/', checked: { version: Version; size: number; mtime: number; ino: number }[] = []
    for (const version of manifest.versions) {
      const path = join(base, version.path.slice(prefix.length)), before = statSync(path), digest = createHash('sha256')
      if (before.size !== version.size) throw new Error('[FILE_CHANGED] 还原内容大小不符，未恢复读取')
      for await (const chunk of createReadStream(path)) digest.update(chunk)
      const after = statSync(path)
      if (digest.digest('hex') !== version.hash || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino || before.size !== after.size)
        throw new Error('[FILE_CHANGED] 还原内容校验失败，未恢复读取')
      checked.push({ version, size: after.size, mtime: after.mtimeMs, ino: after.ino })
    }
    // 校验后再次检查树与每个版本，任何异常都不覆盖原位置。
    this.inspectTree(base, manifest)
    for (const c of checked) {
      const now = statSync(join(base, c.version.path.slice(prefix.length)))
      if (now.size !== c.size || now.mtimeMs !== c.mtime || now.ino !== c.ino) throw new Error('[FILE_CHANGED] 核验期间内容变化')
    }
    if (base === content) {
      await mkdir(dirname(source), { recursive: true }); this.path(this.fileDir(id)); await rename(content, source)
      await syncDir(dirname(source)); await syncDir(this.path(job.bundle))
    }
    this.space.exclusive(() => {
      for (const c of checked) {
        db.prepare('UPDATE file_versions SET mtime=? WHERE id=?').run(c.mtime, c.version.id)
        // 这里已逐个核对原始哈希；还原会改变存储 inode，旧观察不再代表当前磁盘。
        db.prepare('DELETE FROM space_disk_observations WHERE version_id=?').run(c.version.id)
      }
      const head = db.prepare('SELECT contentVersion FROM file_heads WHERE fileId=?').pluck().get(id) as string
      db.prepare('UPDATE files SET mtime=? WHERE id=?').run(checked.find(c => c.version.id === head)!.mtime, id)
      db.prepare("UPDATE space_disposals SET stage='restored',error=NULL WHERE id=?").run(job.id)
      this.updateFile(id, 'restored', 'available')
    })
    // 只清理协议生成的空包与清单；失败不影响已经验证的内容。
    try { await unlink(this.path(job.bundle + '/' + marker)); await rmdir(this.path(job.bundle)) } catch { /* 可安全保留 */ }
  }
  private recordAction(id: string, action: 'archive' | 'unarchive' | 'clean') {
    this.space.exclusive(() => {
      const record = this.record(id), db = this.space.db
      if (action === 'clean') {
        if (record.cleaned_at) return
        const job = this.job(id)
        if (!job || job.stage !== 'trashed' || this.space.byId(id)?.state !== 'disposed' || this.hasDraft(id)) throw new Error('[RECORD_PROTECTED] 当前不能清理版本明细')
        if (existsSync(this.path(this.fileDir(id))) || existsSync(this.path(job.bundle))) throw new Error('[RECOVERY_FOUND] 发现还原内容，请先核验')
        db.prepare('DELETE FROM space_disk_observations WHERE version_id IN (SELECT id FROM file_versions WHERE fileId=?)').run(id)
        db.prepare('DELETE FROM space_disk_locations WHERE file_id=?').run(id)
        db.prepare('DELETE FROM file_versions WHERE fileId=?').run(id)
        db.prepare("DELETE FROM version_drafts WHERE fileId=? AND state IN ('committed','discarded')").run(id)
        db.prepare("UPDATE space_disposals SET manifest='',stage='cleaned' WHERE file_id=?").run(id)
        db.prepare('UPDATE space_file_records SET cleaned_at=?,archived_at=? WHERE file_id=?').run(Date.now(), Date.now(), id)
      } else {
        const value = action === 'archive' ? record.archived_at ?? Date.now() : null
        if (value === record.archived_at) return
        db.prepare('UPDATE space_file_records SET archived_at=? WHERE file_id=?').run(value, id)
      }
      this.updateFile(id, 'recordChanged')
    })
  }
}
function inputWithoutExecution(input: DisposalInput): DisposalSelection {
  return { spaceId: input.spaceId, action: input.action, files: input.files }
}
