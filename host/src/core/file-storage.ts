// 文件存储信息；副本统一使用异步版本协议。
import type { Library } from './library'
import type { Store } from './store'

export class FileStorage {
  constructor(private lib: Library, private store: Store) {}
  private file(id: string) {
    const file = this.store.blocksOf(id).file
    if (!this.store.exists(id) || !file) throw new Error('素材不存在或没有原文件')
    return file.data
  }
  info(id: string) { return this.lib.files.storageInfo(String(this.file(id).path)) }
}
