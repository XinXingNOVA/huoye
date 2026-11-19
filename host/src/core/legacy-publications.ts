// 退役替换接口的恢复适配：只接纳已有空间提交回执，不创建草稿、不发布字节。
// 保留原请求签名与接纳 requestId，避免重启后重复处理；无此表的新库不创建它。
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { Library } from './library'
import type { Store } from './store'
import type { FileSpace } from '../storage/file-space'
import { SpaceVersions } from '../storage/space-versions'
import { parseSpaceReference } from '../storage/space-reference'
import { commitVersionSchema } from '../shared/space-versions'
import type { AcceptFileUpdate } from '../shared/file-updates'

const inputSchema = commitVersionSchema.extend({ id: z.string().min(1).max(200), expectedPath: z.string().min(1) }).strict()
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export function recoverLegacyPublications(lib: Library, store: Store, space: FileSpace, accept: (input: AcceptFileUpdate) => unknown): string[] {
  if (!lib.db.prepare("SELECT 1 FROM main.sqlite_master WHERE type='table' AND name='space_publications'").get()) return []
  const errors: string[] = []
  const versions = new SpaceVersions(space, `library:${lib.id}:${lib.files.bindings!.binding(space.id).token}`)
  for (const row of lib.db.prepare('SELECT request_id,input,signature FROM main.space_publications WHERE result IS NULL').all() as { request_id: string; input: string; signature: string }[]) {
    try {
      const raw = JSON.parse(row.input), input = inputSchema.parse(raw)
      if (input.spaceId !== space.id) continue
      if (input.requestId !== row.request_id || digest(raw) !== row.signature) throw new Error('[INVALID_RECEIPT] 旧发布任务签名不一致，保留记录待核对')
      const receipt = versions.commitReceipt({ spaceId: input.spaceId, draftId: input.draftId, previewToken: input.previewToken, requestId: input.requestId })
      if (!receipt) continue // 未发布的意图永远不在后台自动提交。
      const file = store.blocksOf(input.id).file, ref = file && parseSpaceReference(String(file.data.path))
      const alreadyCurrent = ref?.spaceId === receipt.spaceId && ref.fileId === receipt.fileId && ref.contentVersion === receipt.contentVersion
      const save = (library: { state: 'accepted' | 'skipped'; error?: string }) => lib.db.prepare('UPDATE main.space_publications SET result=? WHERE request_id=?').run(JSON.stringify({ space: receipt, library }), input.requestId)
      if (!file || (String(file.data.path) !== input.expectedPath && !alreadyCurrent)) {
        save({ state: 'skipped', error: '本库素材或引用已另行改变，保持当前选择；空间发布已完成。' })
        continue
      }
      accept({ id: input.id, expectedPath: input.expectedPath, contentVersion: receipt.contentVersion, revision: receipt.revision, requestId: `accept-${digest(input.requestId)}` })
      save({ state: 'accepted' })
    } catch (error) {
      // 离线、回收或写入失败保留未完成记录，之后扫描可继续。
      if (errors.length < 20) errors.push(error instanceof Error ? error.message : String(error))
    }
  }
  return errors
}
