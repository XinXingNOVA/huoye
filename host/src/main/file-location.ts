// 按当前窗口仓库解析文件引用与回拖身份，与分享功能无关。
import { app, ipcMain, shell } from 'electron'
import { libraryOf } from './libraries'
import { LibraryFiles } from '../storage/library-files'
import Database from 'better-sqlite3'
import { join } from 'node:path'
import { identifyFiles } from '../core/file-identity'
import { callCore } from './core-client'
import { ViewingCopies } from './viewing-copy'
import { trustedWindow } from './trusted-window'
import { parseDirectoryReference } from '../storage/directory-reference'
import { canOpenCopy } from '../shared/open-copy'

export function registerFileLocationIpc(): void {
  const copies = new ViewingCopies(join(app.getPath('userData'), 'viewing-copies'))
  ipcMain.handle('files:open-copy', async (event, id: string) => {
    const library = libraryOf(event.sender)
    if (!library) throw new Error('仓库已关闭')
    if (typeof id !== 'string' || !id || id.length > 200) throw new Error('素材身份无效')
    const core = library.core
    const [view] = await callCore(core, 'get', [id])
    await copies.open(library.root, view, path => shell.openPath(path), () => {
      if (event.sender.isDestroyed() || libraryOf(event.sender) !== library || library.core !== core || library.reloading || library.offline) throw new Error('仓库已关闭或已重载')
    })
  })
  ipcMain.handle('files:open-original', async (event, id: string) => {
    trustedWindow(event)
    const library = libraryOf(event.sender)
    if (!library || typeof id !== 'string' || !id || id.length > 200) throw new Error('素材或仓库已不可用')
    const core = library.core
    const [view] = await callCore(core, 'get', [id])
    const file = view?.blocks.file?.data
    if (view?.deletedAt || typeof file?.path !== 'string' || !parseDirectoryReference(file.path)) throw new Error('请选择原地收录的素材')
    if (libraryOf(event.sender) !== library || library.core !== core || library.reloading || library.offline || library.closing) throw new Error('仓库已关闭或已重载')
    const path = new LibraryFiles(library.root).readable(file.path)
    if (!canOpenCopy(path)) throw new Error('系统打开仅支持文档与媒体文件')
    const error = await shell.openPath(path)
    if (error) throw new Error(error)
  })
  ipcMain.on('files:identify', (event, paths: string[]) => {
    let db: Database.Database | undefined
    try {
      const library = libraryOf(event.sender)
      if (!library) throw new Error('仓库已关闭')
      db = new Database(join(library.root, 'library.db'), { readonly: true, fileMustExist: true })
      event.returnValue = { ids: identifyFiles(db, new LibraryFiles(library.root), paths) }
    } catch (error) { event.returnValue = { error: String(error) } }
    finally { db?.close() }
  })
  // 兼容公共 UI 的同步 abs API；仅本窗口仓库的登记可参与解析。
  ipcMain.on('files:resolve', (event, reference: string) => {
    try {
      const library = libraryOf(event.sender)
      if (!library) throw new Error('仓库已关闭')
      event.returnValue = { path: new LibraryFiles(library.root).readable(reference) }
    } catch (error) { event.returnValue = { error: String(error) } }
  })
}
