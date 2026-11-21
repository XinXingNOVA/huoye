import { uiText } from './language'
import { app, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { join } from 'node:path'
import { z } from 'zod'
import sharp from 'sharp'
import { DirectoryMaintenance } from '../storage/directory-maintenance'
import { DirectorySpaces } from '../storage/directory-spaces'
import { callCore } from './core-client'
import { libraryOf, openLibraries, type OpenLibrary } from './libraries'
import { launcherWindow } from './launcher'
import { trustedWindow } from './trusted-window'

import { reserveSpaceCheck } from './space-check-lock'
let shared: DirectorySpaces
export function applicationDirectories() { return shared }
export function notifyDirectoryCatalog(id: string, entriesChanged = false) {
  const windows = [launcherWindow(), ...openLibraries().map(lib => lib.win)]
  for (const win of windows) if (win && !win.isDestroyed()) win.webContents.send('directory-catalog:changed', id, entriesChanged)
}
export function registerDirectorySpaces() {
  const home = join(app.getPath('userData'), 'file-spaces')
  process.env.HUOYE_DIRECTORY_CATALOG = home // 与随后启动的仓库 utilityProcess 共用本机登记簿。
  const changes = new Map<string, Set<string>>()
  let timer: ReturnType<typeof setTimeout> | undefined
  const spaces = new DirectorySpaces(home, (spaceId, fileId) => {
    if (!changes.has(spaceId)) changes.set(spaceId, new Set())
    changes.get(spaceId)!.add(fileId)
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      for (const [id, files] of changes) {
        try {
          const members = spaces.members(id), ids = [...files]
          for (const lib of openLibraries()) {
            if (members.some(member => member.id === lib.id && member.root === lib.root)) void notify(lib, id, ids)
          }
        } catch (error) { console.warn('[directory-space] 未能通知原地文件更新', error) }
      }
      changes.clear()
    }, 250)
  })
  shared = spaces
  async function notify(lib: OpenLibrary, spaceId: string, fileIds?: string[]) {
    if (!lib.closing && !lib.offline) {
      try { await callCore(lib.core, 'refreshFileSpace', spaceId, fileIds) }
      catch (error) { console.warn('[directory-space] 窗口刷新未完成', error) }
    }
  }
  function owner(e: IpcMainInvokeEvent) {
    trustedWindow(e)
    const library = libraryOf(e.sender)
    if (!library || library.closing) throw new Error('请在已打开的仓库中操作')
    return library
  }
  const catalogChanged = notifyDirectoryCatalog
  const maintenance = new DirectoryMaintenance(home)
  ipcMain.handle('directory-catalog:list', e => { trustedWindow(e); return maintenance.list() })
  ipcMain.handle('directory-catalog:forget', (e, id) => { trustedWindow(e); maintenance.forget(z.uuid().parse(id)); catalogChanged(id) })
  ipcMain.handle('directory-catalog:remove-member', (e, id, input) => {
    trustedWindow(e)
    const member = z.object({ id: z.string().min(1), root: z.string().min(1) }).parse(input)
    if (openLibraries().some(lib => lib.id === member.id && lib.root === member.root)) throw new Error('请在已打开的仓库中解除关联')
    maintenance.removeMember(z.uuid().parse(id), member)
    catalogChanged(id)
  })
  ipcMain.handle('directory-catalog:preview-missing', (e, id, days) => { trustedWindow(e); return maintenance.previewMissing(z.uuid().parse(id), days) })
  ipcMain.handle('directory-catalog:clean-missing', (e, id, cutoff, token) => {
    trustedWindow(e)
    const count = maintenance.cleanMissing(z.uuid().parse(id), cutoff, z.string().regex(/^[a-f0-9]{64}$/).parse(token))
    if (count) catalogChanged(id, true)
    return count
  })
  ipcMain.handle('directory-spaces:list', e => spaces.list(owner(e)))
  ipcMain.handle('directory-spaces:connections', async e => {
    const lib = owner(e)
    const referenced = await callCore(lib.core, 'referencedDirectorySpaces')
    return spaces.connections(owner(e), referenced)
  })
  ipcMain.handle('directory-spaces:pick', async (e, expected) => {
    const lib = owner(e)
    const expectedId = z.uuid().optional().parse(expected)
    const result = await dialog.showOpenDialog(lib.win, { title: expectedId ? uiText("选择要重新关联的原目录") : uiText("关联原地目录"), properties: ['openDirectory'] })
    if (result.canceled || !result.filePaths.length) return null
    if (owner(e) !== lib) throw new Error('仓库窗口已变化')
    const space = spaces.attach(lib, result.filePaths[0], expectedId)
    catalogChanged(space.id)
    await notify(lib, space.id)
    return space
  })
  ipcMain.handle('directory-spaces:relocate', async (e, id) => {
    const lib = owner(e), spaceId = z.uuid().parse(id)
    const picked = await dialog.showOpenDialog(lib.win, { title: uiText("重新定位原地目录"), properties: ['openDirectory'] })
    if (picked.canceled || !picked.filePaths.length) return null
    if (owner(e) !== lib) throw new Error('仓库窗口已变化')
    const choice = await dialog.showMessageBox(lib.win, { type: 'question', message: uiText("将这个原地空间重新定位到所选目录？"),
      detail: picked.filePaths[0] + '\n' + uiText("所有关联仓库共用此位置。更换磁盘时将按相对路径和已核对的文件内容验证，未核对的文件会重新登记。"),
      buttons: [uiText("取消"), uiText("重新定位")], defaultId: 0, cancelId: 0 })
    if (!choice.response) return null
    if (owner(e) !== lib) throw new Error('仓库窗口已变化')
    const result = await spaces.relocate(lib, spaceId, picked.filePaths[0])
    catalogChanged(spaceId, true)
    await Promise.all(openLibraries().filter(other => spaces.list(other).some(s => s.id === spaceId)).map(other => notify(other, spaceId)))
    return result
  })
  ipcMain.handle('directory-spaces:unlink', async (e, id, expected) => {
    const lib = owner(e), spaceId = z.uuid().parse(id)
    const counts = z.object({ active: z.number().int().nonnegative(), trashed: z.number().int().nonnegative() }).parse(expected)
    const actual = await callCore(lib.core, 'directorySpaceReferences', spaceId)
    if (counts.active !== actual.active || counts.trashed !== actual.trashed) throw new Error('本库的引用数量已变化，请重新预览解除关联')
    if (owner(e) !== lib) throw new Error('仓库窗口已变化')
    spaces.unlink(lib, spaceId)
    catalogChanged(spaceId)
    await notify(lib, spaceId)
  })
  ipcMain.handle('directory-spaces:page', async (e, id, folder, offset, refresh) => {
    const lib = owner(e), spaceId = z.uuid().parse(id)
    const page = await spaces.page(lib, spaceId, z.uuid().nullable().parse(folder), z.number().int().nonnegative().parse(offset), z.boolean().parse(refresh))
    const ids = page.items.filter(item => !item.folder).map(item => item.id)
    if (ids.length && owner(e) === lib) {
      const states = await callCore(lib.core, 'directoryEntryStates', spaceId, ids)
      const rows = new Map(states.map(row => [row.id, row]))
      for (const item of page.items) {
        const row = rows.get(item.id)
        if (row?.stamp === item.stamp) Object.assign(item, { collected: row.collected, collectionState: row.collectionState, hasUpdate: row.hasUpdate })
      }
    }
    return page
  })
  const scans = new Map<string, AbortController>()
  ipcMain.handle('directory-spaces:refresh-tree', async (e, id, retryOnly) => {
    const lib = owner(e), spaceId = z.uuid().parse(id), key = e.sender.id + '/' + spaceId
    if (scans.has(key)) throw new Error('本窗口正在核对这个空间')
    const controller = new AbortController(), stop = () => controller.abort()
    const release = reserveSpaceCheck(spaceId)
    scans.set(key, controller)
    e.sender.once('destroyed', stop)
    try { return await spaces.refreshTree(lib, spaceId, controller.signal, z.boolean().optional().parse(retryOnly)) }
    finally { release(); e.sender.removeListener('destroyed', stop); scans.delete(key) }
  })
  ipcMain.handle('directory-spaces:stop-tree', (e, id) => {
    owner(e); scans.get(e.sender.id + '/' + z.uuid().parse(id))?.abort()
  })
  ipcMain.handle('directory-spaces:missing', (e, id, offset) => spaces.missing(owner(e), z.uuid().parse(id), z.number().int().nonnegative().parse(offset)))
  ipcMain.handle('directory-spaces:verify', (e, id, file, stamp) => spaces.verify(owner(e), z.uuid().parse(id), z.uuid().parse(file), z.string().max(160).parse(stamp)))
  ipcMain.handle('directory-spaces:preview', async (e, id, file, stamp) => {
    const bytes = await spaces.image(owner(e), z.uuid().parse(id), z.uuid().parse(file), z.string().max(160).parse(stamp))
    const img = sharp(bytes, { limitInputPixels: 64_000_000, animated: false })
    const { format } = await img.metadata()
    if (!format || !['png', 'jpeg', 'webp', 'gif', 'heif'].includes(format)) throw new Error('无法预览此图片格式')
    const preview = await img.rotate().resize({ width: 1280, height: 960, fit: 'inside', withoutEnlargement: true }).png().toBuffer()
    return 'data:image/png;base64,' + preview.toString('base64')
  })
}
