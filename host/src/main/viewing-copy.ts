// 外部查看只交出独立副本。没有发布、接纳或编辑回收逻辑。
import { chmod, lstat, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { EntityView } from '../shared/blocks'
import { canOpenCopy, fileExtension } from '../shared/open-copy'
import { LibraryFiles } from '../storage/library-files'

const retention = 7 * 24 * 60 * 60 * 1000
export async function pruneViewingCopies(directory: string, now = Date.now()): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^view-[a-zA-Z0-9]+$/.test(entry.name)) continue
    const path = join(directory, entry.name)
    try { if ((await lstat(path)).mtimeMs < now - retention) await rm(path, { recursive: true, force: true }) }
    catch { /* 已被清理或仍被外部应用占用，下次再试。 */ }
  }
}

export class ViewingCopies {
  private ready?: Promise<void>
  constructor(private directory: string) {}
  async open(root: string, view: EntityView | undefined, launch: (path: string) => Promise<string>, assertCurrent: () => void = () => {}): Promise<string> {
    const file = view?.blocks.file?.data
    if (!view || view.deletedAt || typeof file?.path !== 'string') throw new Error('素材不存在、已回收或没有原文件')
    if (!canOpenCopy(file.name)) throw new Error('系统查看暂支持常见文档、图片、音视频和电子书；不启动程序、脚本或快捷方式')
    const files = new LibraryFiles(root)
    files.readable(file.path) // 完整空间关联、版本与可用性检查；不接受界面传入的磁盘路径。
    this.ready ??= mkdir(this.directory, { recursive: true }).then(() => pruneViewingCopies(this.directory)).catch(error => { this.ready = undefined; throw error })
    await this.ready
    const dir = await mkdtemp(join(this.directory, 'view-'))
    try {
      // 保留扩展名与可辨认的名称；加固定前缀规避 Windows 保留名、点文件和命令参数。
      const ext = fileExtension(file.name)!
      const stem = String(file.name).slice(0, -(ext.length + 1)).replace(/[\x00-\x1f\x7f/\\:*?"<>|]/g, '_').replace(/[. ]+$/g, '').slice(0, 70) || '文件'
      const path = join(dir, `查看-${stem}.${ext}`)
      await files.copyOut(file.path, path) // 不使用硬链接，修改副本不能改变不可变版本。
      await chmod(path, 0o600)
      files.readable(file.path)
      assertCurrent()
      const error = await launch(path)
      if (error) throw new Error(`系统应用打开失败：${error}`)
      return path
    } catch (error) {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
      throw error
    }
  }
}
