// 按当前窗口仓库解析文件引用与回拖身份，与分享功能无关。
import { app, ipcMain, shell } from 'electron'
import { libraryOf } from './libraries'
import { LibraryFiles } from '../storage/library-files'
import Database from 'better-sqlite3'
import { join } from 'node:path'
import { identifyFiles } from '../core/file-identity'
import { callCore } from './core-client'
import { ViewingCopies } from './viewing-copy'

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
