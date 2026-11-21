import { uiText } from './language'
import { localThemes } from './appearance'
import { readFileSync, statSync } from 'node:fs'
import { MAX_PACKAGE_BYTES } from '../plugin-packages/archive'
import { pluginUpdates, assertNoPackageUpdate, packageUpdateBusy } from './plugin-updates'
import { presentationWindow } from './auxiliary-windows'
import { registerPluginPresetIpc } from './plugin-presets'
import { packageInfo } from '../shared/package-info'
import { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, protocol } from 'electron'
import { trustedWindow } from './trusted-window'
import { DevelopmentPackages } from '../plugin-packages/development'
import { DevelopmentDirectories } from '../plugin-packages/development-directory'
import { PackageManager } from '../plugin-packages/manager'
import { SuiteCatalog } from '../plugin-packages/suites'
import { PackageInstallations, suiteMissingPlugins } from '../plugin-packages/installations'
import { readBundledPackages } from '../plugin-packages/bundled'
import { ALL_PLUGINS, PLUGINS } from '../plugins/manifest'
import { libraryOf, openLibraries, reloadLibrary, type OpenLibrary } from './libraries'
import { callCore } from './core-client'
import { serveFile } from './lib-protocol'
import { packageChangesSchema, type PackageChanges, type PackageRow } from '../shared/external-plugins'

let manager: PackageManager | undefined
export const localPackages = () => {
  if (!manager) {
    const candidate = new PackageManager(app.getPath('userData'), ALL_PLUGINS.map(p => p.id))
    candidate.provisionBundled(readBundledPackages(join(__dirname, 'plugins')))
    localSuites().provisionBundled(JSON.parse(readFileSync(join(__dirname, 'plugins/suites.json'), 'utf8')))
    manager = candidate
  }
  return manager
}
let development: DevelopmentPackages | undefined
export const developmentPackages = () => development ??= new DevelopmentPackages(app.getPath('userData'), ALL_PLUGINS.map(p => p.id))
let directories: DevelopmentDirectories | undefined
export const packagesChanged = () => { for (const win of BrowserWindow.getAllWindows()) { win.webContents.send('packages:changed'); win.webContents.send('plugin-presets:changed') } }
export const developmentDirectories = () => directories ??= new DevelopmentDirectories(developmentPackages(), app.getPath('userData'), {
  reserved: ALL_PLUGINS.map(p => p.id), defaultToolchain: app.isPackaged ? undefined : join(__dirname, '../..'),
  executable: process.execPath, runAsNode: true, changed: packagesChanged
})
export const closeDevelopmentDirectory = (root: string) => directories?.close(root)
export function beginPackages(root: string) {
  developmentDirectories().state(root)
  const installed = localPackages().begin(root), development = developmentPackages().begin(root)
  const ids = new Set(development.map(p => p.manifest.id))
  return [...installed.filter(p => !ids.has(p.manifest.id)), ...development]
}
export function packagesReady(root: string) {
  localPackages().ready(root); developmentPackages().packages.ready(root)
  developmentPackages().collect(openLibraries().flatMap(l => l.packages.filter(p => p.development)))
}
export function blockPackage(root: string, hash: string, message: string, development = false) {
  (development ? developmentPackages().packages : localPackages()).block(root, hash, message)
}
let suiteCatalog: SuiteCatalog | undefined
export const localSuites = () => suiteCatalog ??= new SuiteCatalog(join(app.getPath('userData'), 'plugin-suites.json'), (bytes, hash) => localThemes().install(bytes, hash))
const installations = new PackageInstallations(localPackages, localSuites)
const installOwners = new Map<number, number>()
const applying = new Set<string>()
/** UI、方案和开发验收共用本库配置互斥。 */
export async function withPluginConfiguration<T>(lib: OpenLibrary, fn: () => Promise<T>): Promise<T> {
  assertNoPackageUpdate()
  if (applying.has(lib.root) || lib.reloading || lib.closing) throw new Error('[LIBRARY_BUSY] 正在应用插件设置或关闭仓库')
  applying.add(lib.root)
  try { return await fn() } finally { applying.delete(lib.root) }
}
const updateOwners = new Set<number>()
/** 原生选文件可由 capture flow 代办，安装确认仍经过实际界面。 */
let captureFile: string | string[] | undefined
export function selectCapturePackage(file: string | string[]) {
  if (!process.env.CAPTURE_DIR) throw new Error('仅截图模式可代办文件选择')
  captureFile = file
}

export async function packageRows(lib: OpenLibrary): Promise<PackageRow[]> {
  const [bindings, { assembly }] = await Promise.all([callCore(lib.core, 'externalPlugins'), callCore(lib.core, 'info')])
  const developing = lib.packages.filter(p => p.development)
  const ids = new Set(developing.map(p => p.manifest.id))
  const effective = [...bindings.filter(b => !ids.has(b.manifest.id)), ...developing.map(p => ({ ...p, enabled: true }))]
  const installed = [...localPackages().list().filter(p => !ids.has(p.manifest.id)), ...developing]
  const rows = [...installed, ...effective.filter(b => !installed.some(p => p.hash === b.hash))]
  return rows.map(p => {
    const binding = effective.find(b => b.manifest.id === p.manifest.id && b.hash === p.hash)
    const state = binding ? assembly.plugins.find(s => s.id === p.manifest.id) : undefined
    const serviceProblem = state?.enabled && lib.services?.problem(p.manifest.id)
    return { manifest: p.manifest, hash: p.hash, bundled: localPackages().isRelease(p.hash), installed: installed.some(i => i.hash === p.hash), selected: !!binding,
      development: ids.has(p.manifest.id), enabled: !!binding?.enabled, running: !!state?.enabled && !serviceProblem, reason: serviceProblem ? `服务启动失败：${serviceProblem}` : state?.reason }
  })
}

export function registerPackageIpc() {
  const from = (event: Electron.IpcMainInvokeEvent) => {
    const lib = libraryOf(event.sender)
    if (!lib || lib.reloading) throw new Error('请等待仓库加载完成')
    return lib
  }
  const changed = packagesChanged
  ipcMain.handle('packages:pending-update', e => { trustedWindow(e); return pluginUpdates().read() ?? null })
  ipcMain.handle('packages:pick-update', async (e, hash: string) => {
    const win = trustedWindow(e)
    pluginUpdates().assertIdle()
    if (applying.size) throw new Error('正在应用插件设置')
    let path: string | undefined
    if (process.env.CAPTURE_DIR && captureFile) { path = Array.isArray(captureFile) ? captureFile[0] : captureFile; captureFile = undefined }
    else {
      const result = await dialog.showOpenDialog(presentationWindow(e.sender) ?? win, { title: uiText("选择插件新版本"), properties: ['openFile'], filters: [{ name: uiText("插件包"), extensions: ['hyplugin', 'rmplugin'] }] })
      path = result.canceled ? undefined : result.filePaths[0]
    }
    if (!path || e.sender.isDestroyed()) return null
    if (statSync(path).size > MAX_PACKAGE_BYTES) throw new Error('插件包超过大小限制')
    const owner = e.sender.id
    if (!updateOwners.has(owner)) {
      updateOwners.add(owner)
      e.sender.on('did-navigate', () => pluginUpdates().clearPreview(owner))
      e.sender.once('destroyed', () => { updateOwners.delete(owner); pluginUpdates().clearPreview(owner) })
    }
    return pluginUpdates().preview(owner, hash, readFileSync(path))
  })
  const update = async (e: Electron.IpcMainInvokeEvent, token: string, start: boolean) => {
    trustedWindow(e)
    if (applying.size) throw new Error('正在应用插件设置')
    const result = await (start ? pluginUpdates().start(e.sender.id, token) : pluginUpdates().run(token))
    changed(); return result
  }
  ipcMain.handle('packages:start-update', (e, token: string) => update(e, token, true))
  ipcMain.handle('packages:resume-update', (e, token: string) => update(e, token, false))
  ipcMain.handle('packages:cancel-update', (e, token: string) => { trustedWindow(e); pluginUpdates().clearPreview(e.sender.id, token); pluginUpdates().cancel(token); changed() })
  ipcMain.handle('packages:development-directory', async e => {
    const lib = from(e), state = developmentDirectories().state(lib.root)
    if (!state.rows.some(r => r.appliedHash)) return state
    const info = await callCore(lib.core, 'info')
    return { ...state, rows: state.rows.map(row => {
      const plugin = info.assembly.plugins.find(p => p.id === row.id)
      const service = row.id && plugin?.enabled && lib.services?.problem(row.id)
      return { ...row, running: !!plugin?.enabled && !service && lib.packages.some(p => p.development && p.hash === row.appliedHash), reason: service ? `服务启动失败：${service}` : plugin?.reason }
    }) }
  })
  const pickFolder = async (e: Electron.IpcMainInvokeEvent, title: string) => {
    if (process.env.CAPTURE_DIR && captureFile) { const path = Array.isArray(captureFile) ? captureFile[0] : captureFile; captureFile = undefined; return path }
    const win = trustedWindow(e)
    const result = await dialog.showOpenDialog(presentationWindow(e.sender) ?? win, { title, properties: ['openDirectory'] })
    return result.canceled ? undefined : result.filePaths[0]
  }
  const editDirectory = async (e: Electron.IpcMainInvokeEvent, fn: (root: string) => unknown) => {
    const lib = from(e)
    return withPluginConfiguration(lib, async () => fn(lib.root))
  }
  ipcMain.handle('packages:pick-development-directory', e => editDirectory(e, async root => {
    const path = await pickFolder(e, uiText("选择开发插件目录")); if (!path) return false
    await developmentDirectories().addDirectory(root, path); return true
  }))
  ipcMain.handle('packages:remove-development-directory', (e, directory: unknown) => editDirectory(e, root => {
    if (typeof directory !== 'string') throw new Error('无效源码目录')
    return developmentDirectories().removeDirectory(root, directory)
  }))
  ipcMain.handle('packages:pick-development-toolchain', e => editDirectory(e, async root => {
    const path = await pickFolder(e, uiText("选择{name}开发工具工程", { name: app.name })); if (!path) return false
    await developmentDirectories().setToolchain(root, path); return true
  }))
  ipcMain.handle('packages:prepare-development-sources', (e, sources: unknown, retry: unknown) => editDirectory(e, root => developmentDirectories().prepare(root, sources, retry === true)))
  ipcMain.handle('packages:apply-development-directory', (e, selection) => editDirectory(e, root => developmentDirectories().apply(root, selection)))
  ipcMain.handle('packages:clear-development-directory', e => editDirectory(e, root => developmentDirectories().clear(root)))
  ipcMain.handle('packages:suites', e => { trustedWindow(e); return localSuites().list().map(s => ({ ...s, missing: suiteMissingPlugins(s.manifest, localPackages()) })) })
  ipcMain.handle('packages:remove-suite', (e, id: string, hash: string) => { trustedWindow(e); if (packageUpdateBusy()) throw new Error('正在更新插件'); localSuites().remove(id, hash); changed() })
  ipcMain.handle('packages:installed', e => { trustedWindow(e); return localPackages().list().map(p => ({ manifest: p.manifest, hash: p.hash, bundled: localPackages().isRelease(p.hash), installed: true, selected: false, enabled: false, running: false })) })
  ipcMain.handle('packages:list', e => packageRows(from(e)))
  ipcMain.handle('packages:pick', async (e, suiteId?: string) => {
    const win = trustedWindow(e), owner = e.sender.id
    if (suiteId !== undefined && !localSuites().list().some(s => s.manifest.id === suiteId)) throw new Error('套件未登记')
    if (!installOwners.has(owner)) {
      installOwners.set(owner, 0)
      e.sender.on('did-navigate', () => { installations.clear(owner); installOwners.set(owner, (installOwners.get(owner) ?? 0) + 1) })
      e.sender.once('destroyed', () => { installations.clear(owner); installOwners.delete(owner) })
    }
    const generation = installOwners.get(owner)! + 1
    installOwners.set(owner, generation)
    installations.clear(owner)
    let files: string[]
    if (process.env.CAPTURE_DIR && captureFile) { files = Array.isArray(captureFile) ? captureFile : [captureFile]; captureFile = undefined }
    else {
      const result = await dialog.showOpenDialog(presentationWindow(e.sender) ?? win, { title: suiteId ? uiText("更新套件") : uiText("安装套件或插件包（可多选）"), properties: suiteId ? ['openFile'] : ['openFile', 'multiSelections'], filters: [{ name: uiText("套件与插件包"), extensions: ['hyplugin', 'hysuite', 'rmplugin', 'rmsuite'] }] })
      files = result.canceled ? [] : result.filePaths
    }
    if (e.sender.isDestroyed() || installOwners.get(owner) !== generation) return null
    return installations.preview(owner, files, suiteId)
  })
  ipcMain.handle('packages:install', (e, token: unknown, choices?: unknown) => {
    trustedWindow(e)
    assertNoPackageUpdate()
    const result = installations.install(e.sender.id, token, choices)
    changed()
    return result
  })
  ipcMain.handle('packages:cancel-install', (e, token: unknown) => {
    trustedWindow(e)
    installations.clear(e.sender.id, token)
  })
  const locked = async <T>(lib: OpenLibrary, fn: () => Promise<T>): Promise<T> => {
    return withPluginConfiguration(lib, fn)
  }
  const commit = async (lib: OpenLibrary, settings: PackageChanges, guard: () => void = () => {}) => {
    const bindings = await callCore(lib.core, 'externalPlugins')
    guard()
    // 先检查整批；任何包缺失或版本重复时都不提交部分配置或授权。
    const changes = settings.changes.map(({ hash, enabled }) => {
      const ref = enabled ? localPackages().find(hash) : bindings.find(b => b.hash === hash)
      if (!ref) throw new Error('当前仓库没有选择这个插件版本')
      if (developmentPackages().links(lib.root).some(p => p.manifest.id === ref.manifest.id)) throw new Error('请先退出此插件的开发模式，再更改正式版本选择')
      return { manifest: ref.manifest, hash, enabled }
    })
    if (new Set(changes.map(b => b.manifest.id)).size !== changes.length) throw new Error('同一插件只能选择一个版本')
    localPackages().grantMany(lib.root, changes.filter(b => b.enabled).map(b => b.hash))
    await callCore(lib.core, 'setPluginSettings', settings.disabled, changes)
  }
  ipcMain.handle('packages:apply', async (e, input: unknown) => {
    const lib = from(e), settings = packageChangesSchema.parse(input)
    return locked(lib, () => commit(lib, settings))
  })
  registerPluginPresetIpc({ from, locked, commit, runtimeProblems: async (lib, selection) => {
    const [rows, plugins] = await Promise.all([packageRows(lib), callCore(lib.core, 'plugins')])
    return [
      ...selection.external.filter(p => p.enabled && !rows.some(r => r.hash === p.hash && r.running)).map(p => `插件 ${p.id} 尚未成功运行，请先在功能与插件中重试启用`),
      ...plugins.filter(p => !p.external && !selection.disabled.includes(p.id) && !p.enabled).map(p => `功能 ${p.id} 尚未启用：${p.reason ?? '请检查依赖'}`)
    ]
  }, environment: async lib => {
    const [bindings, plugins] = await Promise.all([callCore(lib.core, 'externalPlugins'), callCore(lib.core, 'plugins')])
    return {
      plugins: PLUGINS, bindings, disabled: plugins.filter(p => !p.external && p.chosen).map(p => p.id),
      installed: localPackages().list(),
      development: developmentPackages().links(lib.root).map(p => packageInfo(p))
    }
  } })
  const users = async (hash: string) => {
    if (applying.size) throw new Error('正在应用插件设置，请稍后卸载')
    localPackages().find(hash)
    const found: OpenLibrary[] = []
    for (const lib of openLibraries()) {
      if (lib.reloading) throw new Error('有仓库正在重载，请稍后重试')
      const [bindings, plugins] = await Promise.all([callCore(lib.core, 'externalPlugins'), callCore(lib.core, 'plugins')])
      if (bindings.some(b => b.hash === hash && b.enabled) || plugins.some(p => p.external?.hash === hash && p.enabled)) found.push(lib)
    }
    return found
  }
  ipcMain.handle('packages:removal', async (e, hash: string) => { trustedWindow(e); return (await users(hash)).map(l => l.name) })
  ipcMain.handle('packages:uninstall', async (e, hash: string) => {
    trustedWindow(e)
    assertNoPackageUpdate()
    // 预览之后重新核对；不直接删正在运行的文件，也不静默改变别的窗口。
    if ((await users(hash)).length) throw new Error('请先在列出的仓库中停用此插件，再卸载')
    if (applying.size) throw new Error('正在应用插件设置，请稍后卸载')
    localPackages().uninstall(hash)
    changed()
  })
  ipcMain.handle('packages:runtime', async e => {
    const lib = from(e), manifest = await callCore(lib.core, 'plugins')
    const packages = lib.packages.filter(p => manifest.some(m => m.id === p.manifest.id && m.external?.hash === p.hash && m.enabled))
    lib.packageResources = new Set(packages.map(p => p.hash))
    return { manifest, packages: packages.map(({ manifest, hash }) => ({ manifest, hash })), base: `rm-plugin://${lib.packageToken}/` }
  })
  ipcMain.handle('packages:failed', async (e, id: string, message: string) => {
    const lib = from(e), pack = lib.packages.find(p => p.manifest.id === id && lib.packageResources.has(p.hash))
    if (!pack || !lib.packageResources.has(pack.hash)) throw new Error('没有此运行插件')
    blockPackage(lib.root, pack.hash, `界面加载失败：${String(message).slice(0, 1200)}`, pack.development)
    packagesReady(lib.root)
    setImmediate(() => { void reloadLibrary(lib).catch(error => dialog.showErrorBox(uiText("恢复仓库失败"), String(error))) })
  })
  ipcMain.handle('packages:ready', e => { packagesReady(from(e).root); packagesChanged() })
}

export function registerPackageProtocol() {
  protocol.handle('rm-plugin', req => {
    try {
      const url = new URL(req.url)
      const lib = openLibraries().find(l => l.packageToken === url.host)
      const [hash, ...parts] = decodeURIComponent(url.pathname).slice(1).split('/')
      if (!lib?.packageResources.has(hash)) return new Response('not found', { status: 404 })
      const path = parts.join('/')
      if (path === 'package.rmplugin') return new Response('not found', { status: 404 })
      const store = lib.packages.find(p => p.hash === hash)?.development ? developmentPackages().packages : localPackages()
      const response = serveFile(store.file(hash, path), req)
      return response
    } catch { return new Response('not found', { status: 404 }) }
  })
}
