import { presentationWindow } from './auxiliary-windows'
// 应用登记的是最近使用的位置；空间身份、模式、成员和文件事实仍以空间数据库为准。
import { app, dialog, ipcMain, shell } from 'electron'
import { mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { FileSpace } from '../storage/file-space'
import { parseSpaceReference } from '../storage/space-reference'
import { FileImport } from '../storage/library-files'
import { createLibrarySchema } from '../shared/application-access'
import type { SpaceMode } from '../shared/file-spaces'
import { SpaceLifecycle } from '../storage/space-lifecycle'
import { SpaceVersions, inspectVersionReadiness, versionPermissions, setVersionPermission } from '../storage/space-versions'
import { registerSpaceDiskIpc } from './space-disk'
import { SpaceHistory } from '../storage/space-history'
import { SpaceDisposal } from '../storage/space-disposal'
import type { DisposalInput, DisposalSelection } from '../shared/space-disposal'
import type { RestoreVersionInput, SpaceHistoryInput } from '../shared/space-versions'
import type { SpacePageInput, SpaceMutationPreviewInput, SpaceMutationInput } from '../shared/file-spaces'

const registry = () => join(app.getPath('userData'), 'file-spaces.json')
function roots(): string[] { try { return JSON.parse(readFileSync(registry(), 'utf8')).filter((s: unknown) => typeof s === 'string') } catch { return [] } }
function remember(root: string): void {
  const values = [...new Set([realpathSync(root), ...roots()])]
  mkdirSync(app.getPath('userData'), { recursive: true })
  writeFileSync(registry() + '.tmp', JSON.stringify(values, null, 2)); renameSync(registry() + '.tmp', registry())
}
function inspect(root: string) { const space = new FileSpace(realpathSync(root)); try { return space.info() } finally { space.close() } }
export function registerFileSpaceIpc(changed: (spaceId: string, fileIds?: string[]) => Promise<void> = async () => {}): void {
  registerSpaceDiskIpc(changed)
  const operations = new Map<string, AbortController>()
  const transfer = async <T>(e: Electron.IpcMainInvokeEvent, requestId: string, fn: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    const key = `${e.sender.id}:${requestId}`
    if (operations.has(key)) throw new Error('[EDIT_BUSY] 空间操作正在进行')
    const controller = new AbortController(), cancel = () => controller.abort()
    operations.set(key, controller); e.sender.once('destroyed', cancel)
    try { return await fn(controller.signal) } finally { operations.delete(key); e.sender.removeListener('destroyed', cancel) }
  }
  const notify = async (spaceId: string, fileIds?: string[]) => { try { await changed(spaceId, fileIds) } catch (e) { console.warn('[file-space] 空间已提交，通知未完成；刷新或重开接续', e) } }
  // 物理处置只由应用级入口显式调用；不接入已有仓库 recycle 权限或任意路径删除 RPC。
  const useDisposal = async <T>(root: string, fn: (service: SpaceDisposal) => T | Promise<T>, mutation?: { fileIds?: string[] }): Promise<T> => {
    const space = new FileSpace(realpathSync(root))
    try { return await fn(new SpaceDisposal(space, { trashDirectory: path => shell.trashItem(path) })) }
    finally { try { if (mutation) await notify(space.id, mutation.fileIds) } finally { space.close() } }
  }
  ipcMain.handle('spaces:disposal-preview', (_e, root: string, input: DisposalSelection) => useDisposal(root, s => s.preview(input)))
  ipcMain.handle('spaces:disposal-execute', (_e, root: string, input: DisposalInput) => useDisposal(root, s => s.execute(input), { fileIds: input.files.map(f => f.id) }))
  ipcMain.handle('spaces:disposal-pending', (_e, root: string, spaceId: string) => useDisposal(root, s => s.pending(spaceId)))
  ipcMain.handle('spaces:disposal-resume', (_e, root: string, spaceId: string, requestId: string) => useDisposal(root, s => s.resume(spaceId, requestId), {}))
  ipcMain.handle('spaces:cancel-operation', (e, requestId: string) => { operations.get(`${e.sender.id}:${requestId}`)?.abort() })
  ipcMain.handle('spaces:history', (_e, root: string, input: SpaceHistoryInput) => {
    const space = new FileSpace(realpathSync(root))
    try { return new SpaceHistory(space).page(input) } finally { space.close() }
  })
  ipcMain.handle('spaces:restore-version', async (e, root: string, input: RestoreVersionInput) => {
    const space = new FileSpace(realpathSync(root))
    try { const result = await transfer(e, input.requestId, signal => new SpaceHistory(space).restore(input, signal)); await notify(space.id, [input.fileId]); return result } finally { space.close() }
  })
  ipcMain.handle('spaces:set-version-permission', async (_e, root: string, spaceId: string, libraryId: string, permission: 'revise' | 'recycle', enabled: boolean, revision: number) => {
    const space = new FileSpace(realpathSync(root))
    try {
      if (space.id !== spaceId) throw new Error('[FILE_SPACE_IDENTITY] 空间身份不匹配')
      const result = setVersionPermission(space, libraryId, permission, enabled, revision)
      await changed(space.id); return result
    } finally { space.close() }
  })
  ipcMain.handle('spaces:version-permissions', (_e, root: string, spaceId: string) => {
    const space = new FileSpace(realpathSync(root))
    try { if (space.id !== spaceId) throw new Error('[FILE_SPACE_IDENTITY] 空间身份不匹配'); return versionPermissions(space) } finally { space.close() }
  })
  ipcMain.handle('spaces:version-readiness', (_e, root: string, spaceId: string) => {
    const space = new FileSpace(realpathSync(root))
    try {
      if (space.id !== spaceId) throw new Error('[FILE_SPACE_IDENTITY] 所选位置不是目标空间')
      return inspectVersionReadiness(space)
    } finally { space.close() }
  })
  const useSpace = <T>(root: string, fn: (service: SpaceLifecycle) => T): T => {
    const space = new FileSpace(realpathSync(root))
    try { return fn(new SpaceLifecycle(space)) } finally { space.close() }
  }
  ipcMain.handle('spaces:files', (_e, root: string, input: SpacePageInput) => useSpace(root, service => service.page(input)))
  ipcMain.handle('spaces:preview', (_e, root: string, input: SpaceMutationPreviewInput) => useSpace(root, service => service.preview(input)))
  ipcMain.handle('spaces:mutate', async (e, root: string, input: SpaceMutationInput) => {
    const space = new FileSpace(realpathSync(root))
    try {
      const result = await transfer(e, input.requestId, async signal => new SpaceLifecycle(space).execute(input, { signal }))
      await notify(result.spaceId, input.files.map(f => f.id)); return result
    } finally { space.close() }
  })
  ipcMain.handle('spaces:list', () => roots().flatMap(root => { try { return [inspect(root)] } catch { return [] } }))
  ipcMain.handle('spaces:pick', async e => {
    const win = presentationWindow(e.sender), options: Electron.OpenDialogOptions = { title: '选择已有文件空间', properties: ['openDirectory'] }
    const picked = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    if (picked.canceled) return null
    const info = inspect(picked.filePaths[0]); remember(info.root); return info
  })
  ipcMain.handle('spaces:create', (_e, parent: string, name: string, mode: SpaceMode) => {
    const clean = createLibrarySchema.shape.name.parse(name), root = join(realpathSync(parent), clean)
    const versions = SpaceVersions.create(root, mode)
    try { const info = versions.space.info(); remember(root); return info } finally { versions.space.close() }
  })
  ipcMain.handle('spaces:mode', (_e, root: string, mode: SpaceMode, revision: number) => {
    const space = new FileSpace(realpathSync(root))
    try { const info = space.changeMode(mode, revision); remember(root); return info } finally { space.close() }
  })
  ipcMain.handle('spaces:add', async (_e, root: string, paths: string[]) => {
    if (!Array.isArray(paths) || !paths.length || paths.length > 100 || paths.some(p => typeof p !== 'string')) throw new Error('每次请选择 1–100 个普通文件')
    const space = new FileSpace(realpathSync(root))
    const key = `space:${createHash('sha256').update(JSON.stringify(paths.map(p => resolve(p)))).digest('hex')}`, batch = new FileImport(space, key)
    const errors: string[] = [], fileIds: string[] = []
    try {
      for (const [index, path] of paths.entries()) {
        try {
          if (!statSync(path).isFile()) throw new Error('请选择普通文件')
          const staged = await batch.stage(randomUUID(), resolve(path), basename(path), String(index))
          fileIds.push(parseSpaceReference(staged.reference)!.fileId)
        } catch (e) { errors.push(`${basename(path)}：${String(e)}`) }
      }
      if (!errors.length) space.finishBatch(key); remember(root)
      await changed(space.id, errors.length ? undefined : fileIds)
      return { added: fileIds.length, errors }
    } finally { batch.dispose(); space.close() }
  })
}
