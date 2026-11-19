import { presentationWindow } from './auxiliary-windows'
import { app, BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron'
import { join } from 'node:path'
import { FileEditingTasks, type EditingContext } from './file-editing-tasks'
import { libraryOf, rootOfId } from './libraries'
import { callCore } from './core-client'
import { serveFile } from './lib-protocol'
import { startEditingSchema, type FileEditingBridge } from '../shared/file-editing'
import { openEditingSchema } from '../shared/local-editors'
import { LocalEditors, editorLauncher } from './local-editors'
import { trustedWindow } from './trusted-window'

let tasks: FileEditingTasks
function context(event: IpcMainInvokeEvent): EditingContext {
  trustedWindow(event)
  const library = libraryOf(event.sender)
  if (!library || library.reloading || library.offline) throw new Error('[LIBRARY_OFFLINE] 请先打开仓库并等待加载完成')
  const core = library.core
  const assertCurrent = () => {
    if (event.sender.isDestroyed() || libraryOf(event.sender) !== library || library.core !== core || library.reloading || library.offline) throw new Error('[LIBRARY_OFFLINE] 仓库已关闭或正在重载，编辑任务保留')
  }
  return { id: library.id, root: library.root, assertCurrent, api: {
    get: ids => callCore(core, 'get', ids), fileStorageInfo: id => callCore(core, 'fileStorageInfo', id),
    fileEditCapabilities: id => callCore(core, 'fileEditCapabilities', id),
    prepareFileEdit: async input => await callCore(core, 'prepareFileEdit', input),
    commitFileEdit: async input => await callCore(core, 'commitFileEdit', input),
    discardFileEdit: input => callCore(core, 'discardFileEdit', input)
  } }
}
export function registerFileEditingIpc() {
  tasks = new FileEditingTasks(join(app.getPath('userData'), 'file-editing'))
  const editors = new LocalEditors(join(app.getPath('userData'), 'local-editors.json'))
  const changed = () => {
    for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) {
      win.webContents.send('local-editors:changed'); win.webContents.send('file-editing:changed')
    }
  }
  const choose = async (event: IpcMainInvokeEvent) => {
    const win = trustedWindow(event)
    const picked = await dialog.showOpenDialog(presentationWindow(event.sender) ?? win, { title: '选择编辑器应用程序', properties: ['openFile'],
      ...(process.platform === 'darwin' ? { defaultPath: '/Applications', filters: [{ name: '应用程序', extensions: ['app'] }] }
        : process.platform === 'win32' ? { filters: [{ name: '应用程序', extensions: ['exe'] }] } : {}) })
    trustedWindow(event)
    if (picked.canceled || !picked.filePaths[0]) return null
    const result = editors.register(picked.filePaths[0]); changed(); return result
  }
  ipcMain.handle('local-editors:list', event => { trustedWindow(event); return editors.list() })
  ipcMain.handle('local-editors:choose', choose)
  ipcMain.handle('local-editors:remove', (event, id) => { trustedWindow(event); editors.remove(id); changed() })
  ipcMain.handle('file-editing:chooseEditor', async event => {
    const ctx = context(event), editor = await choose(event); ctx.assertCurrent()
    return editor ? { id: editor.id, title: editor.title } : null
  })
  ipcMain.handle('file-editing:chooseReplacement', async (event, id: unknown) => {
    const ctx = context(event), input = startEditingSchema.pick({ id: true }).parse({ id })
    const win = trustedWindow(event)
    const picked = await dialog.showOpenDialog(presentationWindow(event.sender) ?? win, { title: '选择同格式替换文件', properties: ['openFile'] })
    ctx.assertCurrent()
    if (picked.canceled || !picked.filePaths.length) return null
    if (picked.filePaths.length !== 1) throw new Error('请选择一个同格式替换文件')
    try { return await tasks.start(ctx, { id: input.id, source: picked.filePaths[0] }) }
    finally { if (!event.sender.isDestroyed()) event.sender.send('file-editing:changed') }
  })
  const handle = <K extends Exclude<keyof FileEditingBridge, 'onChanged' | 'chooseEditor' | 'chooseReplacement'>>(name: K,
    fn: (ctx: EditingContext, ...args: Parameters<FileEditingBridge[K]>) => ReturnType<FileEditingBridge[K]>) => {
    ipcMain.handle('file-editing:' + name, async (event, ...args) => {
      const ctx = context(event)
      try { return await fn(ctx, ...args as Parameters<FileEditingBridge[K]>) }
      finally { if (!['list', 'inspectEnd', 'editorOptions'].includes(name) && !event.sender.isDestroyed()) event.sender.send('file-editing:changed') }
    })
  }
  handle('list', ctx => tasks.list(ctx))
  handle('start', (ctx, input) => tasks.start(ctx, input))
  handle('editorOptions', async (ctx, id) => {
    const task = await tasks.get(ctx, id)
    return { editors: editors.list().map(({ id, title }) => ({ id, title })), preferred: editors.preferred(ctx.id, task.format), systemAllowed: task.canOpen, format: task.format }
  })
  handle('open', async (ctx, id, raw) => {
    const options = openEditingSchema.parse(raw ?? {}), task = await tasks.get(ctx, id)
    if (options.remember && !task.format) throw new Error('无扩展名文件仅为本次选择编辑器')
    const chosen = options.editorId ?? editors.preferred(ctx.id, task.format) ?? 'system'
    const editor = editors.resolve(chosen)
    await tasks.open(ctx, id, path => editor ? editorLauncher.open(editor, path) : shell.openPath(path), !!editor)
    ctx.assertCurrent()
    if (options.remember) {
      try { editors.remember(ctx.id, task.format, chosen); changed() }
      catch (e) { throw new Error('副本已打开，但编辑器偏好保存失败：' + String(e)) }
    }
  })
  handle('reveal', (ctx, id) => tasks.reveal(ctx, id, path => shell.showItemInFolder(path)))
  handle('check', (ctx, input) => tasks.check(ctx, input))
  handle('commit', (ctx, id, token) => tasks.commit(ctx, id, token))
  handle('discardPrepared', (ctx, id) => tasks.discardPrepared(ctx, id))
  handle('inspectEnd', (ctx, id) => tasks.inspectEnd(ctx, id))
  handle('finish', (ctx, input) => tasks.finish(ctx, input))
  handle('discard', (ctx, id, token) => tasks.discard(ctx, id, token))
}
/** 仅打开的仓库可读取本机当前准备快照；不接受磁盘路径，不暴露可写工作文件。 */
export async function serveEditingPreview(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url), parts = decodeURIComponent(url.pathname).split('/')
    if (!rootOfId(url.host) || parts.length !== 4 || parts[1] !== '_file-edits') throw new Error('无效预览')
    const path = await tasks.previewPath(url.host, parts[2], parts[3])
    return serveFile(path, request)
  } catch { return new Response('preview unavailable', { status: 403 }) }
}
