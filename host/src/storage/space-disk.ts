// 手动磁盘核对。观察、用户确认、空间内容登记各自有边界；不扫描未知文件或后台发布。
import { copyFile, mkdir, open } from 'node:fs/promises'
import { constants, existsSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import type { FileSpace } from './file-space'
import { SpaceVersions } from './space-versions'
import { versionPath } from './version-read'
import { startMissingCheck, finishMissingCheck, managedAreaProof } from './missing-check'
import { diskDigest, fingerprint, observeFile, sameFingerprint } from './disk-observation'
import { diskApplySchema, diskCheckSchema, diskPageSchema, diskPreviewSchema,
  type DiskApplyInput, type DiskApplyResult, type DiskCheckInput, type DiskCheckResult, type DiskObservation,
  type DiskPage, type DiskPageInput, type DiskPreview, type DiskPreviewInput, type DiskProgress } from '../shared/space-disk'
import type { CommitVersionInput } from '../shared/space-versions'

type Version = { id: string; fileId: string; name: string; hash: string; path: string; size: number; mtime: number; ordinal: number }
type Plan = { input: DiskApplyInput; preview: DiskPreview; version: Version; revision: number; observation: DiskObservation; destination: string }
type Job = { signature: string; plan: string; commit_input: string | null; result: string | null }
export class SpaceDisk {
  private versions: SpaceVersions
  constructor(private space: FileSpace, private actor = 'application') { this.versions = new SpaceVersions(space, actor) }
  private target(id: string) { if (id !== this.space.id) throw new Error('[FILE_SPACE_IDENTITY] 空间身份不匹配') }
  private version(id: string): Version {
    const row = this.space.db.prepare('SELECT * FROM file_versions WHERE id=?').get(id) as Version | undefined
    if (!row) throw new Error('[NOT_FOUND] 登记版本不存在')
    return row
  }
  private available(v: Version) {
    const file = this.space.byId(v.fileId)
    if (!file || !['available', 'recycled'].includes(file.state)) throw new Error('[FILE_UNAVAILABLE] 原件正在处置或已移走')
    if (this.space.db.prepare('SELECT 1 FROM space_file_records WHERE file_id=? AND busy_request IS NOT NULL').get(v.fileId)) throw new Error('[DISPOSAL_BUSY] 原件有未完成的处置')
    return file
  }
  private rootReady() {
    // 根目录／文件区整体离线时不能生成一整库的缺失记录。
    try {
      if (!statSync(realpathSync(this.space.root)).isDirectory() || !statSync(join(this.space.root, 'files')).isDirectory()) throw new Error('不是目录')
    } catch { throw new Error('[SPACE_OFFLINE] 文件空间或文件区不可用，请检查位置和访问权限后重试') }
  }
  private saved(id: string) {
    const row = this.space.db.prepare('SELECT observation FROM space_disk_observations WHERE version_id=?').get(id) as { observation: string } | undefined
    return row ? JSON.parse(row.observation) as DiskObservation : undefined
  }
  private save(v: Version, observation: DiskObservation, run: string) {
    this.space.exclusive(() => {
      if (this.version(v.id).path !== v.path) return // 与修复／处置并发时不写过期观察。
      this.available(v)
      if (observation.state === 'unchanged' && observation.fingerprint) {
        // 内容哈希未变，只更新已核验的存储时间；不改版本身份和内容基线。
        this.space.db.prepare('UPDATE file_versions SET mtime=? WHERE id=?').run(observation.fingerprint.mtime, v.id)
        this.space.db.prepare('UPDATE files SET mtime=? WHERE id=? AND path=?').run(observation.fingerprint.mtime, v.fileId, v.path)
      }
      this.space.db.prepare(`INSERT INTO space_disk_observations VALUES (?,?,?,NULL)
        ON CONFLICT(version_id) DO UPDATE SET observation=excluded.observation,checked_at=excluded.checked_at`).run(v.id, JSON.stringify({ ...observation, path: v.path, ...(observation.state === 'missing' && { scanRun: run }) }), Date.now())
    })
  }
  async check(raw: DiskCheckInput, signal?: AbortSignal, progress?: (value: DiskProgress) => void): Promise<DiskCheckResult> {
    const input = diskCheckSchema.parse(raw); this.target(input.spaceId)
    const db = this.space.db
    const run = startMissingCheck(db)
    this.rootReady()
    const proof = managedAreaProof(this.space.root)
    const where = "FROM file_versions v JOIN files f ON f.id=v.fileId WHERE f.state IN ('available','recycled') AND NOT EXISTS (SELECT 1 FROM space_file_records r WHERE r.file_id=f.id AND r.busy_request IS NOT NULL)"
    const total = Number(db.prepare(`SELECT count(*) ${where}`).pluck().get())
    const high = Number(db.prepare(`SELECT coalesce(max(v.rowid),0) ${where}`).pluck().get()); let checked = 0, cursor = 0, fileIssues = 0
    progress?.({ requestId: input.requestId, checked, total })
    try {
      for (;;) {
        signal?.throwIfAborted(); this.rootReady()
        const rows = db.prepare(`SELECT v.*,v.rowid AS cursor ${where} AND v.rowid>? AND v.rowid<=? ORDER BY v.rowid LIMIT 50`).all(cursor, high) as (Version & { cursor: number })[]
        if (!rows.length) break
        for (const v of rows) {
          signal?.throwIfAborted()
          let observation: DiskObservation
          try {
            const path = versionPath(this.space.root, v.path)
            const saved = this.saved(v.id)
            observation = await observeFile(path, v.hash, signal, !input.deep && saved?.path === v.path ? { ...saved, path } : undefined)
          } catch (e) {
            signal?.throwIfAborted(); observation = { path: v.path, state: 'unreadable', error: String(e) }
          }
          this.rootReady()
          // 单文件生命周期已变化就跳过；异常不伪装为成功核对。
          const current = db.prepare('SELECT path FROM file_versions WHERE id=?').get(v.id) as { path: string } | undefined
          if (current?.path === v.path && ['available', 'recycled'].includes(this.space.byId(v.fileId)?.state ?? '')) this.save(v, observation, run)
          if (observation.state === 'unreadable' || observation.state === 'unstable') fileIssues++
          checked++; cursor = v.cursor; progress?.({ requestId: input.requestId, checked, total })
        }
      }
      if (managedAreaProof(this.space.root) !== proof) throw new Error('文件空间位置在检查期间发生变化，请重新检查')
      finishMissingCheck(db, run, proof)
      return { checked, total, cancelled: false, ...(fileIssues && { fileIssues }) }
    } catch (e) { if (signal?.aborted) return { checked, total, cancelled: true }; throw e }
  }
  page(raw: DiskPageInput): DiskPage {
    const input = diskPageSchema.parse(raw); this.target(input.spaceId)
    const from = `FROM space_disk_observations o JOIN file_versions v ON v.id=o.version_id JOIN files f ON f.id=v.fileId
      JOIN file_heads h ON h.fileId=v.fileId WHERE f.state IN ('available','recycled') AND json_extract(o.observation,'$.state')!='unchanged'`
    const total = Number(this.space.db.prepare(`SELECT count(*) ${from}`).pluck().get())
    const rows = this.space.db.prepare(`SELECT o.*,v.fileId,v.name,v.ordinal,h.contentVersion ${from} ORDER BY o.checked_at DESC,v.id LIMIT ? OFFSET ?`).all(input.limit, input.offset) as { version_id: string; fileId: string; name: string; ordinal: number; contentVersion: string; observation: string; checked_at: number; replacement: string | null }[]
    const items = rows.map(r => {
      const observed = JSON.parse(r.observation) as DiskObservation
      return { ...observed, path: join(this.space.root, observed.path), versionId: r.version_id, fileId: r.fileId, name: r.name,
        ordinal: r.ordinal, current: r.contentVersion === r.version_id, checkedAt: r.checked_at, replacement: r.replacement ?? undefined }
    })
    const pending = (this.space.db.prepare('SELECT request_id,plan FROM space_disk_operations WHERE result IS NULL').all() as { request_id: string; plan: string }[])
      .map(r => { const plan = JSON.parse(r.plan) as Plan; return { requestId: r.request_id, name: plan.version.name, versionId: plan.version.id } })
    return { items, total, pending, ...(input.offset + items.length < total ? { nextOffset: input.offset + items.length } : {}) }
  }
  private async inspect(raw: DiskPreviewInput, signal?: AbortSignal) {
    const input = diskPreviewSchema.parse(raw); this.target(input.spaceId); this.rootReady()
    const v = this.version(input.versionId), file = this.available(v)
    const source = input.source ?? versionPath(this.space.root, v.path)
    if (!isAbsolute(source)) throw new Error('请明确选择一个普通文件')
    const observation = await observeFile(source, v.hash, signal)
    if (!observation.hash || !observation.fingerprint) throw new Error(observation.error ?? '文件不可读取')
    const current = this.versions.head(v.fileId) === v.id
    let blocked: string | undefined
    try { this.versions.assertPermission('revise') } catch (e) { blocked = String(e) }
    const action = observation.hash === v.hash ? 'repair' as const : 'accept' as const
    if (input.source && action !== 'repair') blocked = '重新定位只接受内容相同的文件；所选内容与原版本不符'
    if (action === 'accept' && (!current || file.state !== 'available')) blocked = '只可确认当前且未回收的版本；历史版本可重新定位相同内容'
    const preview: DiskPreview = { spaceId: this.space.id, versionId: v.id, fileId: v.fileId, name: v.name, ordinal: v.ordinal, current,
      action, source, size: observation.fingerprint.size, hash: observation.hash, previousHash: v.hash, members: this.space.info().members, blocked,
      token: diskDigest([v, file.revision, file.state, observation, this.space.info().mode]) }
    return { preview, observation, version: v, revision: file.revision }
  }
  async preview(raw: DiskPreviewInput, signal?: AbortSignal): Promise<DiskPreview> { return (await this.inspect(raw, signal)).preview }
  async resume(spaceId: string, requestId: string, signal?: AbortSignal) {
    this.target(spaceId)
    const row = this.space.db.prepare('SELECT plan FROM space_disk_operations WHERE request_id=?').get(requestId) as { plan: string } | undefined
    if (!row) throw new Error('[NOT_FOUND] 处理任务不存在')
    return this.apply((JSON.parse(row.plan) as Plan).input, signal)
  }
  abandon(spaceId: string, requestId: string) {
    this.target(spaceId); this.versions.assertPermission('revise')
    this.space.exclusive(() => {
      const db = this.space.db
      const row = db.prepare('SELECT * FROM space_disk_operations WHERE request_id=?').get(requestId) as Job | undefined
      if (!row || row.result) return
      const plan = JSON.parse(row.plan) as Plan
      if (row.signature !== diskDigest([this.actor, plan.input])) throw new Error('[EDIT_SCOPE] 任务属于其他调用方')
      if (row.commit_input && this.versions.commitReceipt(JSON.parse(row.commit_input))) throw new Error('[ALREADY_COMMITTED] 内容已经登记，请继续完成任务')
      const draft = db.prepare('SELECT id FROM version_drafts WHERE requestId=?').get(`disk-stage-${row.signature}`) as { id: string } | undefined
      if (draft) this.versions.discard(draft.id, `disk-discard-${row.signature}`)
      db.prepare('UPDATE space_disk_operations SET result=? WHERE request_id=?').run(JSON.stringify({ requestId, replayed: false, action: 'abandoned', contentVersion: plan.version.id }), requestId)
    })
  }
  async apply(raw: DiskApplyInput, signal?: AbortSignal): Promise<DiskApplyResult> {
    const input = diskApplySchema.parse(raw); this.target(input.spaceId); this.versions.assertPermission('revise')
    const db = this.space.db, signature = diskDigest([this.actor, input])
    let job = db.prepare('SELECT * FROM space_disk_operations WHERE request_id=?').get(input.requestId) as Job | undefined
    if (job && job.signature !== signature) throw new Error('[REQUEST_ID_CONFLICT] 请求 ID 已用于其他磁盘处理')
    if (job?.result) return { ...JSON.parse(job.result), replayed: true }
    if (!job) {
      const inspected = await this.inspect({ spaceId: input.spaceId, versionId: input.versionId, ...(input.source ? { source: input.source } : {}) }, signal)
      if (inspected.preview.token !== input.token) throw new Error('[PREVIEW_CHANGED] 文件或登记已变化，请重新检查和预览')
      if (inspected.preview.blocked) throw new Error(inspected.preview.blocked)
      const plan: Plan = { ...inspected, input, destination: `files/.versions/${inspected.version.fileId}/repair-${diskDigest([this.actor, input.requestId])}/${inspected.version.name}` }
      this.space.exclusive(() => {
        db.prepare('INSERT INTO space_disk_operations VALUES (?,?,?,NULL,NULL)').run(input.requestId, signature, JSON.stringify(plan))
        if (plan.preview.action === 'repair') {
          // 保留被替换位置及任务副本的所有权，供之后显式物理处置；不把旧字节当成可读版本。
          for (const path of [plan.version.path, plan.destination]) db.prepare('INSERT OR IGNORE INTO space_disk_locations VALUES (?,?)').run(plan.version.fileId, path)
        }
      })
      job = { signature, plan: JSON.stringify(plan), commit_input: null, result: null }
    }
    const plan = JSON.parse(job.plan) as Plan
    let contentVersion = plan.version.id
    if (plan.preview.action === 'accept') {
      let commit = job.commit_input ? JSON.parse(job.commit_input) as CommitVersionInput : undefined
      const receipt = commit && this.versions.commitReceipt(commit)
      if (receipt) contentVersion = receipt.contentVersion
      else {
        await this.revalidate(plan, signal)
        if (!commit) {
          const prepared = await this.versions.stage({ spaceId: this.space.id, source: plan.preview.source, requestId: `disk-stage-${signature}`,
            content: { hash: plan.preview.hash, size: plan.preview.size, name: plan.version.name }, target: { fileId: plan.version.fileId, revision: plan.revision } }, { signal })
          const preview = this.versions.preview(prepared.draft.id)
          commit = { spaceId: this.space.id, draftId: prepared.draft.id, previewToken: preview.previewToken, requestId: `disk-commit-${signature}` }
          db.prepare('UPDATE space_disk_operations SET commit_input=? WHERE request_id=?').run(JSON.stringify(commit), input.requestId)
        }
        await this.revalidate(plan, signal)
        contentVersion = (await this.versions.commit(commit, { signal })).contentVersion
      }
    } else {
      await this.revalidate(plan, signal)
      const destination = versionPath(this.space.root, plan.destination)
      await mkdir(dirname(destination), { recursive: true }); versionPath(this.space.root, plan.destination)
      // 请求副本已完整复制时直接核验；损坏的中间副本不覆盖，允许放弃后重新处理。
      if (!existsSync(destination)) await copyFile(plan.preview.source, destination, constants.COPYFILE_EXCL)
      const handle = await open(destination, 'r'); try { await handle.sync() } finally { await handle.close() }
      if (process.platform !== 'win32') {
        for (let parent = dirname(destination); ; parent = dirname(parent)) {
          const dir = await open(parent, 'r'); try { await dir.sync() } finally { await dir.close() }
          if (parent === realpathSync(this.space.root)) break
        }
      }
      const copied = await observeFile(destination, plan.version.hash, signal)
      if (copied.state !== 'unchanged' || !copied.fingerprint) throw new Error('[FILE_CHANGED] 修复副本校验失败')
      await this.revalidate(plan, signal)
      return this.space.exclusive(() => {
        this.assertPlan(plan)
        if (!sameFingerprint(fingerprint(statSync(destination)), copied.fingerprint)) throw new Error('[FILE_CHANGED] 修复副本已变化')
        db.prepare('UPDATE file_versions SET path=?,mtime=? WHERE id=?').run(plan.destination, copied.fingerprint!.mtime, plan.version.id)
        if (this.versions.head(plan.version.fileId) === plan.version.id)
          db.prepare('UPDATE files SET path=?,mtime=? WHERE id=?').run(plan.destination, copied.fingerprint!.mtime, plan.version.fileId)
        db.prepare(`INSERT INTO space_disk_observations VALUES (?,?,?,NULL) ON CONFLICT(version_id) DO UPDATE SET observation=excluded.observation,checked_at=excluded.checked_at,replacement=NULL`)
          .run(plan.version.id, JSON.stringify({ ...copied, path: plan.destination }), Date.now())
        this.space.bump()
        return this.finish(input, plan, contentVersion)
      })
    }
    return this.space.exclusive(() => {
      // 发布回执存在才允许接续；旧版字节已失配的事实继续保留，不能当成可读历史。
      db.prepare(`INSERT INTO space_disk_observations VALUES (?,?,?,?) ON CONFLICT(version_id) DO UPDATE SET replacement=excluded.replacement`)
        .run(plan.version.id, JSON.stringify({ ...plan.observation, path: plan.version.path }), Date.now(), contentVersion)
      return this.finish(input, plan, contentVersion)
    })
  }
  private assertPlan(plan: Plan) {
    const v = this.version(plan.version.id), file = this.available(v)
    if (diskDigest(v) !== diskDigest(plan.version) || file.revision !== plan.revision) throw new Error('[SPACE_CHANGED] 登记已变化，请重新检查')
    this.versions.assertPermission('revise')
  }
  private async revalidate(plan: Plan, signal?: AbortSignal) {
    this.rootReady(); this.assertPlan(plan)
    const observed = await observeFile(plan.preview.source, plan.version.hash, signal)
    if (diskDigest(observed) !== diskDigest(plan.observation)) throw new Error('[FILE_CHANGED] 来源已变化，请重新检查后处理')
  }
  private finish(input: DiskApplyInput, plan: Plan, contentVersion: string): DiskApplyResult {
    const result: DiskApplyResult = { requestId: input.requestId, action: plan.preview.action, contentVersion, replayed: false }
    this.space.db.prepare('UPDATE space_disk_operations SET result=? WHERE request_id=?').run(JSON.stringify(result), input.requestId)
    return result
  }
}
