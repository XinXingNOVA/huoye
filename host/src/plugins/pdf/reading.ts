import type { TabLeaveContext } from '../../plugin-api/ui/contracts'
import type { ReadingPosition } from './blocks'

/** 本机页面状态；hash 防止把旧文件版本的位置写回替换后的文档。 */
export interface PdfState extends ReadingPosition {
  id?: string
  hash?: string
  zoom: 'fit' | 'page' | number
  paper?: 'original' | 'warm' | 'dark'
  /** 只在当前操作页完成定位后记录；隐藏／恢复不会不断刷新仓库。 */
  lastRead?: number
}

/** 静态生命周期：页面已被缓存回收时也可执行，无需重新挂载 PDF.js。 */
export async function savePdfReading({ params, saved, host, reason, nextParams, signal, otherViews = [] }: TabLeaveContext<{ id: string }, PdfState>): Promise<void> {
  if (reason === 'navigate' && nextParams?.id === params.id) return
  // 保存最近实际翻阅的位置，不由标签关闭顺序决定；其他视图只贡献快照，不改变其页面位置。
  const latest = [saved, ...otherViews.map(v => v.saved)].filter((s): s is PdfState => !!s && s.id === params.id && !!s.hash && Number.isFinite(s.lastRead) && Number(s.lastRead) > 0)
    .reduce<PdfState | undefined>((best, s) => !best || s.lastRead! > best.lastRead! ? s : best, undefined)
  if (!latest) return
  signal.throwIfAborted()
  await host.core.run('pdf', 'saveReading', { id: params.id, hash: latest.hash, page: latest.page, offset: latest.offset, lastRead: latest.lastRead })
}
