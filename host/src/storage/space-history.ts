// 历史恢复只发布到空间。仓库是否接纳仍由各库策略决定，不隐含改写素材。
import { createHash } from 'node:crypto'
import { checkedVersionPath } from './version-read'
import { SpaceVersions } from './space-versions'
import type { FileSpace } from './file-space'
import { restoreVersionSchema, spaceHistorySchema, type CommitVersionInput, type RestoreVersionInput,
  type SpaceHistoryInput, type SpaceHistoryPage, type VersionCommit } from '../shared/space-versions'

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export class SpaceHistory {
  private versions: SpaceVersions
  constructor(private space: FileSpace, private actor = 'application') { this.versions = new SpaceVersions(space, actor) }
  private target(id: string) { if (id !== this.space.id) throw new Error('[FILE_SPACE_IDENTITY] 空间身份不匹配') }
  page(raw: SpaceHistoryInput): SpaceHistoryPage {
    const input = spaceHistorySchema.parse(raw); this.target(input.spaceId)
    return this.space.db.transaction(() => {
      const file = this.space.byId(input.fileId)
      if (!file) throw new Error('[NOT_FOUND] 文件身份不存在')
      if (input.revision !== undefined && input.revision !== file.revision) throw new Error('[SPACE_CHANGED] 文件已变化，请刷新版本列表')
      let blocked: string | undefined
      try { this.versions.assertPermission('revise') } catch (e) { blocked = String(e) }
      if (file.state !== 'available') blocked = '请先恢复空间原件，再恢复历史内容'
      const total = Number(this.space.db.prepare('SELECT count(*) FROM file_versions WHERE fileId=?').pluck().get(file.id))
      const versions = this.versions.versions(file.id, input.offset, input.limit).map(version => {
        try { checkedVersionPath(this.space.db, this.space.root, file.id, version.id); return version }
        catch (e) { return { ...version, unavailable: String(e) } }
      })
      return { fileId: file.id, revision: file.revision, currentVersion: this.versions.head(file.id), recycled: file.state === 'recycled',
        versions, total, canRestore: !blocked, blocked, ...(input.offset + versions.length < total ? { nextOffset: input.offset + versions.length } : {}) }
    })()
  }
  async restore(raw: RestoreVersionInput, signal?: AbortSignal): Promise<VersionCommit> {
    const input = restoreVersionSchema.parse(raw); this.target(input.spaceId); this.versions.assertPermission('revise')
    const signature = digest(['restore-history', this.actor, input]), db = this.space.db
    const job = this.space.exclusive(() => {
      const old = db.prepare('SELECT * FROM history_restorations WHERE requestId=?').get(input.requestId) as { signature: string; commitInput: string | null } | undefined
      if (old) {
        if (old.signature !== signature) throw new Error('[REQUEST_ID_CONFLICT] 请求 ID 已用于其他历史恢复')
        return old
      }
      if (db.prepare('SELECT 1 FROM version_receipts WHERE requestId=? UNION ALL SELECT 1 FROM version_drafts WHERE requestId=?').get(input.requestId, input.requestId))
        throw new Error('[REQUEST_ID_CONFLICT] 请求 ID 已用于其他版本操作')
      const file = this.space.byId(input.fileId)
      if (!file || file.state !== 'available' || file.revision !== input.revision) throw new Error('[VERSION_CONFLICT] 原件已变化或回收，请刷新版本列表')
      if (this.versions.head(file.id) === input.contentVersion) throw new Error('所选内容已是当前版本')
      this.versions.version(file.id, input.contentVersion)
      db.prepare('INSERT INTO history_restorations VALUES (?,?,NULL)').run(input.requestId, signature)
      return { signature, commitInput: null }
    })
    let commit: CommitVersionInput
    if (job.commitInput) commit = JSON.parse(job.commitInput)
    else {
      const source = this.versions.read(input.fileId, input.contentVersion), version = this.versions.version(input.fileId, input.contentVersion)
      const prepared = await this.versions.stage({ spaceId: input.spaceId, source, requestId: `history-stage-${signature}`,
        content: { hash: version.hash, size: version.size, name: version.name }, target: { fileId: input.fileId, revision: input.revision } }, { signal })
      const preview = this.versions.preview(prepared.draft.id)
      commit = { spaceId: input.spaceId, draftId: prepared.draft.id, previewToken: preview.previewToken, requestId: `history-publish-${signature}` }
      // 提交意图先持久化。空间发布后响应丢失，显式重试只重放回执；重开不擅自发布。
      db.prepare('UPDATE history_restorations SET commitInput=? WHERE requestId=?').run(JSON.stringify(commit), input.requestId)
    }
    const result = await this.versions.commit(commit, { signal })
    return { ...result, requestId: input.requestId }
  }
}
