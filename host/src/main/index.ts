import { suspendApplicationManagement, allowApplicationManagement } from './application-management'
import { registerPluginLocalIpc } from './plugin-local-ipc'
import { registerAuxiliaryWindowIpc, presentationWindow } from './auxiliary-windows'
import { createVault, resumeCreation, pendingCreations, registerLibraryCreationIpc, suspendCreations, allowCreations } from './library-creation'
import { loadWorkspace, saveWorkspace } from './workspace-storage'
import { registerPageLifecycleIpc, prepareWindow, resumeWindow, reportLeaveFailure } from './page-lifecycle'
import { refreshSpaceWindows } from './space-notifications'
import { registerFileSpaceIpc } from './file-spaces'
import { registerItemDisposalIpc } from './item-disposal'
import { registerFileLocationIpc } from './file-location'
import { registerFileEditingIpc, serveEditingPreview } from './file-editing'
import { registerServiceIpc } from './service-ipc'
// 主进程：仓库与窗口、菜单、系统集成（拖出、显示文件、选择文件）、lib:// 协议。
// 数据库在各仓库的核心进程里，主进程只负责把窗口和核心进程连起来。

import { dirname, join, resolve, sep } from 'node:path'
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, MessageChannelMain, nativeImage, protocol, shell } from 'electron'
import { captureContextMenu, captureDir, runCapture, runVaultsCapture, runDistributionCapture, runApplicationCapture, runLibraryCreationCapture, runApplicationCreationCapture, runCreationRestoreCapture, runApplicationManagementCapture, type ContextItem } from './capture'
import { classifyFolder } from './folders'
import { closeLauncher, showLauncher, launcherWindow } from './launcher'
import { preflight, serveFile, serveLibraryFile } from './lib-protocol'
import { allClosed, anyClosing, isWebUrl, libraryOf, openLibraries, openLibrary, reloadLibrary, rootOfId } from './libraries'
import { installMenu } from './menu'
import { forget, onVaultsChanged, recentVaults, setOpenAtQuit, vaultsToReopen, reopenInBackground } from './vaults'
import { registerApplicationServiceIpc, startApplicationServices, stopApplicationServices } from './application-services'
import { registerPackageIpc, registerPackageProtocol } from './plugin-packages'
import { downloadImage } from './download-image'

protocol.registerSchemesAsPrivileged([
  { scheme: 'lib', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
  { scheme: 'rm-plugin', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }
])

/** pdfjs-dist 包的目录。 */
const PDFJS_DIR = dirname(require.resolve('pdfjs-dist/package.json'))

// 测试与截图时用独立的应用数据目录，不碰平时的工作区
if (process.env.RM_USER_DATA) app.setPath('userData', resolve(process.env.RM_USER_DATA))
registerPageLifecycleIpc()
registerAuxiliaryWindowIpc()
registerFileLocationIpc()
registerFileEditingIpc()
registerFileSpaceIpc(refreshSpaceWindows)
registerItemDisposalIpc(refreshSpaceWindows)
registerPackageIpc()
registerLibraryCreationIpc(() => !captureDir())
registerApplicationServiceIpc()

// 把库里的文件拖到其他软件
ipcMain.on('drag:start', (e, { files, icon }: { files: string[]; icon?: string }) => {
  // 截图模式下窗口隐藏、没有鼠标，不发起系统拖拽；请求由截图流程自己监听并检查
  if (captureDir()) return
  let image = icon ? nativeImage.createFromPath(icon) : nativeImage.createEmpty()
  if (!image.isEmpty()) image = image.resize({ width: 96 })
  else image = nativeImage.createFromBuffer(Buffer.alloc(32 * 32 * 4, 140), { width: 32, height: 32 })
  e.sender.startDrag({ file: files[0], files, icon: image })
})

ipcMain.handle('shell:reveal', (_e, path: string) => shell.showItemInFolder(path))

// 右键菜单（设计文档 11.13）：页面给出菜单项（操作扩展点排好的），这里弹出系统菜单，回答点了哪一项；没点是 null
ipcMain.handle('menu:context', (e, items: ContextItem[]) => {
  if (captureDir()) return captureContextMenu(items)
  return new Promise<string | null>((resolve) => {
    const menu = Menu.buildFromTemplate(
      items.map((it) => ('id' in it ? { label: it.label, accelerator: it.accelerator, click: () => resolve(it.id) } : { type: 'separator' as const }))
    )
    // 菜单关掉的回调可能比点击先到：稍等一下才算"没点"
    menu.popup({ window: presentationWindow(e.sender) ?? undefined, callback: () => setTimeout(() => resolve(null), 200) })
  })
})

ipcMain.handle('shell:open-external', (_e, url: string) => (isWebUrl(url) ? shell.openExternal(url) : undefined))
ipcMain.handle('transfer:download-image', async (e, url: string) => {
  try {
    if (!libraryOf(e.sender)) throw new Error('请先打开仓库')
    return { input: await downloadImage(url) }
  } catch (e) { return { error: e instanceof Error ? e.message : String(e) } }
})

// 剪贴板里的网页地址：网页拿不到，主进程读系统剪贴板的原始格式。
// Chromium 系浏览器（Chrome、Edge、Arc）复制时带着 org.chromium.source-url；复制链接时有 public.url
const SOURCE_FORMATS = ['org.chromium.source-url', 'public.url'].map((f) => `electron application/osclipboard;format="${f}"`)
ipcMain.handle('clipboard:source', async () => {
  for (const type of SOURCE_FORMATS) {
    if (!(await clipboard.has(type))) continue
    for (const item of await clipboard.read()) {
      try {
        const data = await item.getType(type)
        if (!(data instanceof Blob)) continue
        const url = (await data.text()).replace(/\0/g, '').trim()
        if (isWebUrl(url)) return { url }
      } catch {
        // 这一项里没有
      }
    }
  }
  return null
})

ipcMain.handle('workspace:load', (_e, libraryId: string) => loadWorkspace(libraryId).catch(() => null))
ipcMain.handle('workspace:save', (_e, libraryId: string, data: unknown) => saveWorkspace(libraryId, data))

ipcMain.handle('dialog:import', async (e) => {
  const win = presentationWindow(e.sender)
  const opts = { properties: ['openFile', 'openDirectory', 'multiSelections'] } as Electron.OpenDialogOptions
  const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
  return r.canceled ? [] : r.filePaths
})

// 导出到哪里：选一个文件夹（可以新建）；默认是"下载"
ipcMain.handle('dialog:exportFolder', async (e, defaultPath?: string) => {
  const win = presentationWindow(e.sender)
  const opts: Electron.OpenDialogOptions = {
    title: '导出到',
    buttonLabel: '选择',
    defaultPath: defaultPath || app.getPath('downloads'),
    properties: ['openDirectory', 'createDirectory']
  }
  const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
  return r.canceled ? null : r.filePaths[0]
})
ipcMain.handle('paths:downloads', () => app.getPath('downloads'))

// 设置／持续调用均绑定实际顶层仓库窗口。
registerServiceIpc()
registerPluginLocalIpc()

// ---------- 仓库 ----------

/** 每个页面（含刷新后）向它所在仓库的核心进程要一条独立的 MessagePort。 */
ipcMain.on('core:connect', (e) => {
  const lib = libraryOf(e.sender)
  if (!lib) return
  const { port1, port2 } = new MessageChannelMain()
  lib.core.postMessage({ type: 'connect' }, [port1])
  e.sender.postMessage('core:port', null, [port2])
})

type VaultResult = { ok: true } | { error: string }

/** 打开仓库；成功后关掉仓库管理窗口。 */
async function openVault(path: string): Promise<VaultResult> {
  try {
    const capture = captureDir()
    const pending = pendingCreations().find(j => j.root === resolve(path))
    if (pending) return resumeCreation(pending.id, { show: !capture })
    await openLibrary(path, { show: !capture })
    closeLauncher()
    return { ok: true }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
}

/** 打开一个文件夹：是仓库就打开；空文件夹就在这里新建仓库；里面有别的东西就不行。 */
function openFolder(path: string): Promise<VaultResult> | VaultResult {
  switch (classifyFolder(path)) {
    case 'library':
    case 'empty':
      return openVault(path)
    case 'other':
      return { error: '这个文件夹不是仓库，里面有别的文件。仓库会把收进来的文件按身份存放，请选一个空文件夹，或者用“新建仓库”' }
    case 'file':
      return { error: '这不是一个文件夹' }
  }
}

ipcMain.handle('vaults:list', () => {
  const open = new Set(openLibraries().map((l) => l.root))
  return { recent: recentVaults().map((v) => ({ ...v, open: open.has(v.path) })), defaultParent: app.getPath('documents') }
})

ipcMain.handle('vaults:open', (_e, path: string) => openFolder(path))

ipcMain.handle('vaults:create', (_e, parent: string, name: string, spaceRoot?: string) => createVault({ parent, name, spaceRoot }, { show: !captureDir() }))

ipcMain.handle('vaults:pick', async (e, purpose: 'folder' | 'parent') => {
  const win = presentationWindow(e.sender)
  const opts: Electron.OpenDialogOptions = {
    title: purpose === 'folder' ? '打开文件夹作为仓库' : '选择新仓库放在哪里',
    buttonLabel: purpose === 'folder' ? '打开' : '选择',
    properties: ['openDirectory', 'createDirectory']
  }
  const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
  return r.canceled ? null : r.filePaths[0]
})

ipcMain.handle('vaults:forget', (_e, path: string) => forget(path))
ipcMain.handle('vaults:reveal', (_e, path: string) => shell.showItemInFolder(path))
ipcMain.handle('vaults:show', () => void showLauncher())
ipcMain.handle('vaults:reload', (e) => {
  const lib = libraryOf(e.sender)
  if (lib) void reloadLibrary(lib).catch(error => dialog.showErrorBox('重载仓库失败', String(error)))
})

// ---------- 启动与退出 ----------

app.whenReady().then(async () => {
  if (!app.isPackaged && app.dock) {
    // 使用 macOS ICNS 的 1024 px 图层，保留与安装版相同的 Dock 留白。
    const icon = nativeImage.createFromPath(join(app.getAppPath(), 'packaging/icon.png'))
    if (!icon.isEmpty()) app.dock.setIcon(icon)
  }
  await startApplicationServices()
  registerPackageProtocol()
  // lib://<素材库 ID>/<库内相对路径>：按 ID 找到是哪个仓库
  protocol.handle('lib', (req) => {
    if (req.method === 'OPTIONS') return preflight()
    const url = new URL(req.url)
    // lib://pdfjs/：pdf.js 的字符映射表和标准字体（读中文 PDF 要用），从 pdfjs-dist 包里供应，只开放这两个目录
    if (url.host === 'pdfjs') {
      const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '')
      const abs = resolve(PDFJS_DIR, rel)
      const allowed = ['cmaps', 'standard_fonts'].some((d) => abs.startsWith(join(PDFJS_DIR, d) + sep))
      return allowed ? serveFile(abs, req) : new Response('not found', { status: 404 })
    }
    if (url.pathname.startsWith('/_file-edits/')) return serveEditingPreview(req)
    const root = rootOfId(url.host)
    return root ? serveLibraryFile(root, req) : new Response('not found', { status: 404 })
  })
  const menu = () => installMenu(recentVaults().filter((v) => v.exists), (path) => void openVault(path))
  menu()
  onVaultsChanged(menu)

  const capture = captureDir()
  const creationRestore = capture && process.env.CAPTURE_FLOW === 'appcreationrestore'
  if (capture && ['creation', 'creationresume'].includes(process.env.CAPTURE_FLOW ?? '')) {
    void runLibraryCreationCapture(showLauncher(false), capture)
    return
  }
  if (capture && ['distribution', 'distributionresume'].includes(process.env.CAPTURE_FLOW ?? '')) {
    void runDistributionCapture(showLauncher(false), capture)
    return
  }
  if (capture && ['appmanagement', 'appmanagementresume'].includes(process.env.CAPTURE_FLOW ?? '')) {
    void runApplicationManagementCapture(showLauncher(false), capture)
    return
  }
  if (capture && ['appcreation', 'appcreationresume'].includes(process.env.CAPTURE_FLOW ?? '')) {
    void runApplicationCreationCapture(showLauncher(false), capture)
    return
  }
  if (capture && ['appmcp', 'appmcpresume'].includes(process.env.CAPTURE_FLOW ?? '')) {
    void runApplicationCapture(showLauncher(false), capture)
    return
  }
  if (capture && process.env.CAPTURE_FLOW === 'vaults') {
    void runVaultsCapture(showLauncher(false), capture)
    return
  }

  // 要打开的仓库：指定的（开发、截图）；否则上次退出时开着的；都没有就打开仓库管理
  let roots: string[]
  if (process.env.LIBRARY_PATH) roots = [resolve(process.env.LIBRARY_PATH)]
  else {
    roots = vaultsToReopen()
  }
  for (const [i, root] of roots.entries()) {
    try {
      await openLibrary(root, {
        show: (!capture || !!creationRestore) && !reopenInBackground(root), background: reopenInBackground(root),
        // 截图流程只在第一个窗口上跑（它跑完就退出）
        onWindow: (win) => {
          if (capture && !creationRestore && i === 0) win.webContents.once('did-finish-load', () => runCapture(win, capture))
        }
      })
    } catch (e) {
      dialog.showErrorBox('打不开仓库', `${root}\n${e instanceof Error ? e.message : String(e)}`)
    }
  }
  if (!openLibraries().length) showLauncher(!capture)
  if (creationRestore) { void runCreationRestoreCapture(capture); return }

  app.on('activate', () => {
    if (!preparingQuit && !quitting && BrowserWindow.getAllWindows().every(win => !win.isVisible())) showLauncher()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// 记下退出时开着哪些仓库（窗口关掉之前），下次启动重新打开
let quitting = false, preparingQuit = false
app.on('before-quit', event => {
  if (quitting) return
  event.preventDefault()
  if (preparingQuit) return
  preparingQuit = true
  let libraries = openLibraries()
  let windows = [...libraries.map(l => l.win), ...[launcherWindow()].filter((w): w is BrowserWindow => !!w)]
  void Promise.all([suspendCreations(), suspendApplicationManagement()]).then(() => {
    libraries = openLibraries()
    windows = [...libraries.map(l => l.win), ...[launcherWindow()].filter((w): w is BrowserWindow => !!w)]
    return Promise.all(windows.map(win => prepareWindow(win, 'shutdown')))
  }).then(() => {
    // 所有页面均保存成功后才停止应用服务；失败的退出不能让仍打开的窗口失去服务。
    const record = !process.env.LIBRARY_PATH && (!captureDir() || ['vaults', 'appcreationresume'].includes(process.env.CAPTURE_FLOW ?? ''))
    if (record) setOpenAtQuit(openLibraries().map(l => l.root), openLibraries().filter(l => l.background).map(l => l.root))
    quitting = true
    setImmediate(() => app.quit())
  }).catch(error => {
    allowCreations(); allowApplicationManagement()
    windows.forEach(resumeWindow)
    reportLeaveFailure(libraries.find(l => !l.win.isDestroyed())?.win, error)
  }).finally(() => { preparingQuit = false })
})

// 退出：等窗口都关了（页面关闭前的写入，例如播放位置，已经发出），再等各仓库的核心进程收尾、关库。
// 不能在 before-quit 里直接结束核心进程：那时窗口还没关，之后的写入会丢。
let applicationStopped = false, finishingQuit = false
app.on('will-quit', (e) => {
  if (!anyClosing() && applicationStopped) return
  e.preventDefault()
  if (finishingQuit) return
  finishingQuit = true
  void Promise.all([allClosed(), stopApplicationServices()]).then(() => {
    applicationStopped = true
    // 空库或仅开始页时，收尾可能在当前原生退出事件内完成。等 Electron 处理完取消再发起最终退出。
    setImmediate(() => { finishingQuit = false; app.quit() })
  }).catch(error => {
    finishingQuit = false
    console.error('退出收尾失败', error)
  })
})
