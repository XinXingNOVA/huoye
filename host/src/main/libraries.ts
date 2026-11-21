import { DirectorySpaces } from '../storage/directory-spaces'
import { directoryCatalogHome } from '../storage/directory-reference'
import { packageUpdateBusy } from './plugin-updates'
import { installAuxiliaryWindows, setLibraryBackground } from './auxiliary-windows'
import type { LibraryInitialization } from '../shared/library-creation'
import { installPageLifecycle, prepareWindow, isWindowPrepared, resumeWindow } from './page-lifecycle'
import { callCore } from './core-client'
import { windowChrome } from './window-options'
// 打开着的仓库：每个仓库一个核心进程、一个主窗口；附属显示窗口共享这个会话。
// 关主窗口就让核心进程收尾、关库；再打开已经开着的仓库，只把主窗口切到前面。

import { randomUUID } from 'node:crypto'
import { basename, join } from 'node:path'
import { app, BrowserWindow, utilityProcess, type UtilityProcess, type WebContents } from 'electron'
import { rememberOpened } from './vaults'
import { registerApplicationLibrary } from './application-services'
import { startServices } from './services'
import type { ServiceRuntime } from './service-runtime'
import { localPackages, beginPackages, packagesReady, blockPackage, closeDevelopmentDirectory } from './plugin-packages'
import type { InstalledPackage } from '../shared/external-plugins'

export interface OpenLibrary {
  root: string
  name: string
  /** 素材库的固定 ID：lib:// 地址里用它找到仓库目录。 */
  id: string
  core: UtilityProcess
  win: BrowserWindow
  /** 本次装配的运行意图；不能用待应用的启停配置判断本机清理。 */
  localPlugins?: Set<string>
  services?: ServiceRuntime
  reloading?: Promise<void>
  closing?: Promise<void>
  closed?: Promise<void>
  offline?: boolean
  background?: boolean
  packages: InstalledPackage[]
  packageToken: string
  packageResources: Set<string>
}

const open = new Map<string, OpenLibrary>()
const starting = new Map<string, Promise<OpenLibrary>>()
/** 正在收尾的核心进程：退出前要等它们关好库。 */
const closing = new Set<Promise<void>>()

export const openLibraries = () => [...open.values()]
export const libraryOf = (sender: WebContents) => [...open.values()].find((l) => l.win.webContents === sender)
export const rootOfId = (id: string) => [...open.values()].find((l) => l.id === id)?.root

/** 只把网页链接交给系统浏览器：字段里的值是用户写的，不能借它打开本地程序。 */
export const isWebUrl = (url: string) => /^https?:\/\//i.test(url)

/** 加载界面：仓库窗口是默认页面，仓库管理窗口是 #launcher。 */
export function loadRenderer(win: BrowserWindow, hash?: string): void {
  installAuxiliaryWindows(win)
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL + (hash ? `#${hash}` : ''))
  else void win.loadFile(join(__dirname, '../renderer/index.html'), hash ? { hash } : undefined)
}

/**
 * 打开一个仓库：启动它的核心进程，等它打开库（或者报错，例如仓库已经在别处打开），再开窗口。
 * 已经开着则复用；只有明确要求显示时才把窗口切到前面。
 */
export interface LibraryOpenOptions {
  show: boolean; background?: boolean; expectedId?: string; onWindow?(win: BrowserWindow): void
  initial?: LibraryInitialization
  beforeAttach?(core: UtilityProcess, id: string): Promise<void>
}
function showLibrary(lib: OpenLibrary) {
  lib.background = false
  lib.win.webContents.setBackgroundThrottling(true)
  setLibraryBackground(lib.win, false)
  if (lib.win.isMinimized()) lib.win.restore()
  lib.win.show(); lib.win.focus()
}
export function openLibrary(root: string, opts: LibraryOpenOptions): Promise<OpenLibrary> {
  if (packageUpdateBusy()) return Promise.reject(new Error('正在更新插件，请完成后再打开仓库'))
  const existing = open.get(root)
  if (existing) {
    if (opts.expectedId && existing.id !== opts.expectedId) return Promise.reject(new Error('[LIBRARY_CHANGED] 仓库身份与授权不一致'))
    if (opts.show && !opts.background) showLibrary(existing)
    return Promise.resolve(existing)
  }
  const pending = starting.get(root)
  if (pending) return pending.then(lib => {
    if (opts.expectedId && lib.id !== opts.expectedId) throw new Error('[LIBRARY_CHANGED] 仓库身份与授权不一致')
    if (opts.show && !opts.background) showLibrary(lib)
    return lib
  })

  const task = startCore(root, opts.expectedId, opts.initial)
    .then(async ({ core, id, packages }) => {
      try { await opts.beforeAttach?.(core, id) }
      catch (error) { await shutdown(core); packagesReady(root); throw error }
      return attach(root, id, core, packages, opts)
    })
    .catch(async error => { await closeDevelopmentDirectory(root); throw error })
    .finally(() => starting.delete(root))
  starting.set(root, task)
  return task
}

/** 启动一个仓库的核心进程，等它打开库；打不开（例如仓库已经在别处打开）就报错。 */
async function startCore(root: string, expectedId?: string, initial?: LibraryInitialization): Promise<{ core: UtilityProcess; id: string; packages: InstalledPackage[] }> {
  const packages = beginPackages(root)
  try { return await launchCore(root, packages, expectedId, initial) } catch (error) {
    // 外部代码在加载阶段退出或阻塞时，下一次不再执行它；保留原数据和选择。
    if (String(error).includes('[LIBRARY_CHANGED]')) { packagesReady(root); throw error }
    if (!packages.some(p => !p.problem)) throw error
    for (const p of packages) blockPackage(root, p.hash, `启动失败，已跳过：${String(error)}`, p.development)
    packagesReady(root)
    return launchCore(root, beginPackages(root), expectedId, initial)
  }
}
function launchCore(root: string, packages: InstalledPackage[], expectedId?: string, initial?: LibraryInitialization): Promise<{ core: UtilityProcess; id: string; packages: InstalledPackage[] }> {
  return new Promise((resolve, reject) => {
    const core = utilityProcess.fork(join(__dirname, 'core.js'), [], { serviceName: `${app.name}核心 · ${basename(root)}`, stdio: 'inherit' })
    let startupError: Error | undefined
    const stop = (error: Error) => {
      startupError = error
      clearTimeout(timer)
      core.off('message', onMessage)
      // 等旧进程退出、释放仓库锁，再让 startCore 尝试不加载外部插件。
      core.kill()
    }
    const timer = setTimeout(() => stop(new Error('核心启动超时')), 30000)
    const onMessage = (msg: { type: string; message?: string; libraryId?: string }) => {
      if (msg.type === 'error') {
        stop(new Error(msg.message ?? '打不开这个仓库'))
      } else if (msg.type === 'ready') {
        clearTimeout(timer)
        core.off('message', onMessage)
        resolve({ core, id: msg.libraryId!, packages })
      }
    }
    core.on('message', onMessage)
    serveCore(core)
    core.once('exit', (code) => {
      clearTimeout(timer)
      if (code !== 0) console.error(`[main] ${root} 的核心进程退出，代码 ${code}`)
      reject(startupError ?? new Error('核心进程意外退出'))
    })
    const resources = app.isPackaged ? process.resourcesPath : join(__dirname, '../..', 'resources')
    const programDirs = [join(resources, 'media', `${process.platform}-${process.arch}`, 'bin')]
    core.postMessage({ type: 'init', root, expectedId, initial, packages, programDirs, bundled: localPackages().bundled() })
  })
}

/** 空间变化通知其他已打开仓库；各仓库仍按自己的策略接纳。 */
function serveCore(core: UtilityProcess): void {
  core.on('message', (msg: { type: string; spaceId?: string; fileIds?: string[]; sourceKind?: 'directory' }) => {
    if (msg.type === 'space-changed' && msg.spaceId) {
      for (const library of openLibraries()) if (library.core !== core) void (async () => {
        const linked = msg.sourceKind === 'directory'
          ? new DirectorySpaces(directoryCatalogHome()).members(msg.spaceId!).some(m => m.id === library.id && m.root === library.root)
          : (await callCore(library.core, 'listFileSpaces')).some(s => s.id === msg.spaceId && s.state === 'active')
        if (linked) await callCore(library.core, 'refreshFileSpace', msg.spaceId!, msg.fileIds)
      })().catch(error => console.warn('[file-space] 新版本通知未完成，重开或刷新时补查', error))
    }
  })
}

/** MessagePort 另一端退出不会自动拒绝页面里等待的 Promise。 */
function notifyCoreExit(lib: OpenLibrary): void {
  const core = lib.core
  core.once('exit', () => {
    if (lib.core === core) {
      lib.offline = true
      if (!lib.reloading && !lib.win.isDestroyed()) lib.win.webContents.send('core:offline')
    }
  })
}

/**
 * 重新加载仓库：先等待页面结束回调，再卸载页面、停止旧服务和核心，
 * 按新设置启动核心并重建页面。准备失败保留原运行环境，后台已离线时按本机快照恢复。
 */
export function reloadLibrary(lib: OpenLibrary, beforeReload?: () => void): Promise<void> {
  if (lib.closing) return Promise.reject(new Error('[LIBRARY_BUSY] 仓库正在关闭'))
  if (lib.reloading) return lib.reloading
  lib.reloading = (async () => {
    await prepareWindow(lib.win, 'reload')
    try { beforeReload?.() } catch (error) { resumeWindow(lib.win); throw error }
    // 收尾成功后才撤销外部访问并停止旧运行环境。
    const servicesClosed = lib.services?.stop()
    await lib.win.loadURL('about:blank')
    await servicesClosed
    if (!lib.offline) await shutdown(lib.core)
    if (lib.win.isDestroyed()) return
    const { core, id, packages } = await startCore(lib.root, lib.id)
    lib.core = core
    lib.offline = false
    notifyCoreExit(lib)
    lib.id = id
    lib.packages = packages
    lib.packageToken = randomUUID()
    lib.packageResources = new Set()
    if (lib.win.isDestroyed()) { await shutdown(core); return }
    await registerApplicationLibrary(lib)
    await startServices(lib)
    if (!lib.win.isDestroyed()) loadRenderer(lib.win)
  })().finally(() => { lib.reloading = undefined })
  return lib.reloading
}

/** 可等待的普通关闭；保存失败或授权变化保留窗口，不提供强制销毁入口。 */
export function closeLibrary(lib: OpenLibrary, beforeClose: () => void = () => {}): Promise<void> {
  if (lib.closing || lib.reloading) return Promise.reject(new Error('[LIBRARY_BUSY] 仓库正在关闭或重载'))
  lib.closing = (async () => {
    try {
      await prepareWindow(lib.win, 'shutdown')
      beforeClose()
      if (!isWindowPrepared(lib.win)) throw new Error('[CLOSE_CANCELLED] 页面未完成保存或关闭已取消')
      await new Promise<void>((resolve, reject) => {
        const closed = () => { clearTimeout(timer); resolve() }
        const timer = setTimeout(() => { lib.win.removeListener('closed', closed); reject(new Error('[CLOSE_CANCELLED] 窗口仍未关闭，请核对页面状态')) }, 5000)
        lib.win.once('closed', closed); lib.win.close()
      })
      await lib.closed
    } catch (error) { resumeWindow(lib.win); throw error }
  })().finally(() => { lib.closing = undefined })
  return lib.closing
}

async function attach(root: string, id: string, core: UtilityProcess, packages: InstalledPackage[], opts: LibraryOpenOptions): Promise<OpenLibrary> {
  const name = basename(root)
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: opts.show && !opts.background,
    minWidth: 960,
    minHeight: 600,
    title: name,
    backgroundColor: '#1a1b1e',
    ...windowChrome(),
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: false, backgroundThrottling: !opts.background }
  })
  // 窗口标题是仓库名，不用页面的 <title>
  win.on('page-title-updated', (e) => e.preventDefault())
  const lib: OpenLibrary = { root, name, id, core, win, packages, background: !!opts.background, packageToken: randomUUID(), packageResources: new Set() }
  setLibraryBackground(win, !!opts.background)
  notifyCoreExit(lib)
  installPageLifecycle(win, () => !!lib.offline)
  open.set(root, lib)
  rememberOpened(root)
  win.on('closed', () => {
    open.delete(root)
    // 重新加载过的仓库换了核心进程：关现在这个
    const servicesClosed = lib.services?.stop()
    const done = (async () => {
      await closeDevelopmentDirectory(root)
      await servicesClosed
      if (lib.reloading) await lib.reloading.catch(() => {})
      await closeDevelopmentDirectory(root) // 重载期间关窗：清理 startCore 可能刚建立的新监听。
      if (!lib.offline) await shutdown(lib.core)
    })()
    closing.add(done)
    lib.closed = done
    void done.finally(() => closing.delete(done))
  })
  await registerApplicationLibrary(lib)
  await startServices(lib)
  if (win.isDestroyed()) return lib
  opts.onWindow?.(win)
  loadRenderer(win)
  return lib
}

/**
 * 让核心进程收尾、关库后退出。窗口关闭时页面已经把最后的写入（例如播放位置）发出去了，
 * 核心进程会稍等一下再关库；超时才强制结束。
 */
const shutdowns = new WeakMap<UtilityProcess, Promise<void>>()
function shutdown(core: UtilityProcess): Promise<void> {
  const known = shutdowns.get(core)
  if (known) return known
  const done = new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      core.kill()
      resolve()
    }, 3000)
    core.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
    try { core.postMessage({ type: 'shutdown' }) } catch { clearTimeout(timer); resolve() }
  })
  shutdowns.set(core, done)
  void done.then(() => closing.delete(done))
  return done
}

/** 退出前：等所有核心进程关好库。 */
export const allClosed = () => Promise.all([...closing])
export const anyClosing = () => closing.size > 0
