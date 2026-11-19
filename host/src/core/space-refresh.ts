import type { CoreEvents } from '../shared/rpc'
import type { Library } from './library'
import type { Store } from './store'
import type { Scheduler } from './scheduler'
import type { LibrarySpaces } from './file-spaces'
import type { SpaceMutationInput } from '../shared/file-spaces'

/** 空间可用性变化的仓库侧响应。UI 与外部调用只在授权作用域上不同。 */
export class SpaceRefresh {
  constructor(private lib: Library, private store: Store, private scheduler: Scheduler,
    private emit: <K extends keyof CoreEvents>(event: K, payload: CoreEvents[K]) => void) {}

  references(ids: string[]): void {
    if (!ids.length) return
    const available: string[] = [], unavailable: string[] = []
    const candidates = this.scheduler.fileAvailabilityCandidates()
    for (const id of ids) {
      if (!candidates.has(id)) continue
      const reference = this.store.blocksOf(id).file?.data.path
      if (typeof reference !== 'string') continue
      try { this.lib.files.readable(reference); available.push(id) } catch { unavailable.push(id) }
    }
    // 记录／可用性变化不等于内容更新。保留成功结果，避免上下游重复写缓存。
    this.scheduler.cancel(unavailable, true)
    this.scheduler.retryFailed(available)
    this.emit('changed', { ids }); this.emit('listChanged', {})
  }

  async mutate(spaces: LibrarySpaces, input: SpaceMutationInput) {
    const result = await spaces.mutate(input)
    const fileIds = input.files.map(f => f.id)
    this.references(spaces.referenceIds(input.spaceId, fileIds))
    this.emit('spaceChanged', { spaceId: input.spaceId, fileIds })
    this.emit('fileSpaceChanged', { spaceId: input.spaceId })
    return result
  }
}
