import { ipcMain } from 'electron'
import { realpathSync } from 'node:fs'
import { FileSpace } from '../storage/file-space'
import { SpaceDisk } from '../storage/space-disk'
import { diskCheckSchema, type DiskApplyInput, type DiskCheckInput, type DiskPageInput, type DiskPreviewInput } from '../shared/space-disk'

/** 本机空间管理入口。检查可以跨仓库复用，但不能让两个窗口同时处理同一空间。 */
export function registerSpaceDiskIpc(changed: (spaceId: string) => Promise<void>) {
  const running = new Map<string, { sender: number; requestId: string; controller: AbortController }>()
  const use = async <T>(e: Electron.IpcMainInvokeEvent, root: string, requestId: string, fn: (s: SpaceDisk, signal: AbortSignal) => Promise<T>, notify = false): Promise<T> => {
    const space = new FileSpace(realpathSync(root))
    if (running.has(space.id)) { space.close(); throw new Error('[SPACE_CHECK_BUSY] 此空间正在检查或处理，请完成后再试') }
    const controller = new AbortController(), cancel = () => controller.abort()
    running.set(space.id, { sender: e.sender.id, requestId, controller }); e.sender.once('destroyed', cancel)
    try { return await fn(new SpaceDisk(space), controller.signal) }
    finally {
      running.delete(space.id); e.sender.removeListener('destroyed', cancel)
      if (notify) { try { await changed(space.id) } catch (err) { console.warn('[space-disk] 通知未完成，刷新或重开仓库接续', err) } }
      space.close()
    }
  }
  ipcMain.handle('spaces:disk-cancel', (e, requestId: string) => {
    for (const job of running.values()) if (job.sender === e.sender.id && job.requestId === requestId) job.controller.abort()
  })
  ipcMain.handle('spaces:disk-check', (e, root: string, raw: DiskCheckInput) => {
    const input = diskCheckSchema.parse(raw); let last = 0
    return use(e, root, input.requestId, (s, signal) => s.check(input, signal, value => {
      if (!e.sender.isDestroyed() && (Date.now() - last > 100 || value.checked === value.total)) { last = Date.now(); e.sender.send('spaces:disk-progress', value) }
    }), true)
  })
  ipcMain.handle('spaces:disk-page', (_e, root: string, input: DiskPageInput) => {
    const space = new FileSpace(realpathSync(root)); try { return new SpaceDisk(space).page(input) } finally { space.close() }
  })
  ipcMain.handle('spaces:disk-preview', (e, root: string, input: DiskPreviewInput) => use(e, root, input.versionId, (s, signal) => s.preview(input, signal)))
  ipcMain.handle('spaces:disk-apply', (e, root: string, input: DiskApplyInput) => use(e, root, input.requestId, (s, signal) => s.apply(input, signal), true))
  ipcMain.handle('spaces:disk-abandon', (e, root: string, spaceId: string, requestId: string) => use(e, root, requestId, async s => s.abandon(spaceId, requestId)))
  ipcMain.handle('spaces:disk-resume', (e, root: string, spaceId: string, requestId: string) => use(e, root, requestId, (s, signal) => s.resume(spaceId, requestId, signal), true))
}
