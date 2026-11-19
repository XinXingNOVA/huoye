import type { BlockData } from '../shared/blocks'
import type { ContentVersion } from '../shared/space-versions'
import { FILE_MIME } from '../shared/file-metadata'
import { spaceReference } from '../storage/space-reference'
import type { Registry } from './registry'
import type { Store } from './store'

/** 调用方先验证版本可读和业务基线，在包含回执／映射的事务内调用，提交后再通知加工。
 * 格式由用例决定：编辑沿用受控快照，接纳空间新版根据版本文件名取得。
 */
export function applyFileVersion(store: Store, reg: Registry, id: string, previous: BlockData,
  target: { spaceId: string; version: ContentVersion; ext: string }): void {
  const { spaceId, version, ext } = target
  store.put(id, 'file', { ...previous, path: spaceReference(spaceId, version.fileId, version.name, version.id),
    hash: version.hash, size: version.size, ext, mime: FILE_MIME[ext] ?? 'application/octet-stream' })
  // 只清理可重建结果；显示名称、业务块和首次收录附加意图保留。
  for (const kind of Object.keys(store.blocksOf(id))) if (reg.kind(kind)?.rebuildable) store.remove(id, kind)
}
