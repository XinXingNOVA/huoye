import { app, BrowserWindow, MessageChannelMain, utilityProcess, type UtilityProcess } from 'electron'
import { knownPackageRoots, readPackageBindings } from './package-inventory'
import { basename, join, resolve } from 'node:path'
import { packageTaskBlockers } from '../plugin-packages/task-references'
import { APPLICATION_PLUGINS } from '../plugins/manifest'
import { PackageUpdates } from '../plugin-packages/updates'
import type { PackageRef } from '../shared/external-plugins'
import type { PackageUpdateRequest, UpdateLibrary } from '../shared/plugin-updates'
import { localPackages, developmentPackages } from './plugin-packages'
import { openLibraries, reloadLibrary } from './libraries'
import { prepareWindow, resumeWindow } from './page-lifecycle'
import { callCore } from './core-client'

let updates: PackageUpdates | undefined
const running = (root: string) => openLibraries().find(l => resolve(l.root) === resolve(root))
export const packageUpdateBusy = () => !!updates?.busy
export const assertNoPackageUpdate = () => pluginUpdates().assertIdle()

function request(library: UpdateLibrary, previous: PackageRef, next: PackageRef, action: 'check' | 'replace') {
  const lib = running(library.root)
  if (lib?.reloading || lib?.offline) throw new Error('仓库正在重载或离线，请稍后继续更新')
  const core = lib?.core ?? utilityProcess.fork(join(__dirname, 'core.js'), [], { serviceName: '插件更新检查', stdio: 'inherit' })
  const developing = developmentPackages().available(library.root)
  const ids = new Set(developing.map(p => p.manifest.id))
  const packages = [...localPackages().available(library.root).filter(p => !ids.has(p.manifest.id)), ...developing]
  return send(core, { type: 'package-update', root: library.root, libraryId: library.id, previous, next, binding: library.binding, packages, action }, !lib)
}
function send(core: UtilityProcess, request: PackageUpdateRequest, owned: boolean): Promise<void> {
  return new Promise((yes, no) => {
    const { port1, port2 } = new MessageChannelMain()
    let settled = false
    const done = (error?: Error) => { if (settled) return; settled = true; clearTimeout(timer); core.off('exit', offline); port1.close(); if (owned) core.kill(); error ? no(error) : yes() }
    const offline = () => done(new Error('更新检查进程退出；任务已保留'))
    const timer = setTimeout(() => done(new Error('插件检查超时；旧包保留，可继续更新')), 30000)
    core.once('exit', offline)
    port1.on('message', ({ data }) => done(data.error ? new Error(data.error) : undefined))
    port1.start()
    try { core.postMessage(request, [port2]) } catch (e) { done(new Error(String(e))) }
  })
}

export function pluginUpdates() {
  if (updates) return updates
  const directory = app.getPath('userData')
  const prepared = new Set<BrowserWindow>()
  updates = new PackageUpdates(join(directory, 'plugin-updates'), localPackages(), {
    async scan(old) {
      const blockers: string[] = [], libraries: UpdateLibrary[] = []
      for (const root of knownPackageRoots()) {
        try {
          const { id, bindings } = readPackageBindings(root)
          const binding = bindings.find(b => b.hash === old.hash)
          if (!binding && running(root)?.packageResources.has(old.hash)) blockers.push(`${basename(root)}：仍在运行旧版，请先重新加载此仓库使已保存选择生效`)
          if (binding) {
            libraries.push({ root, id, name: basename(root), binding })
            if (running(root)?.reloading) blockers.push(`${basename(root)}：正在重载`)
            if (developmentPackages().links(root).some(p => p.manifest.id === old.manifest.id)) blockers.push(`${basename(root)}：此插件仍处于开发模式，请先退出开发模式`)
          }
        } catch (e) { blockers.push(`${root}：无法核对仓库引用（${String(e)}）`) }
      }
      blockers.push(...packageTaskBlockers(directory, old.hash, APPLICATION_PLUGINS.map(p => p.id)))
      return { libraries, blockers }
    },
    async prepare(libraries) {
      for (const row of libraries) {
        const lib = running(row.root)
        if (lib) { prepared.add(lib.win); await prepareWindow(lib.win, 'reload') }
      }
    },
    check: (library, old, next) => request(library, old, next, 'check'),
    replace: (library, old, next) => request(library, old, next, 'replace'),
    async reload(library, next) {
      const lib = running(library.root)
      if (!lib) return
      await reloadLibrary(lib)
      // 核心 ready 不代表界面或后台服务加载成功；启用中的包须等 UI 装配结果。
      for (let n = 0; n < 300; n++) {
        if (lib.win.isDestroyed()) return
        if (!lib.reloading && !lib.win.webContents.isLoading()) {
          const rows = await callCore(lib.core, 'plugins')
          const target = rows.find(p => p.id === next.manifest.id)
          if (!library.binding.enabled) return
          const problem = localPackages().problem(library.root, next.hash)
          if (problem) throw new Error(`${library.name}：${problem}`)
          if (!localPackages().isStarting(library.root) && target?.enabled && lib.packageResources.has(next.hash) && !lib.services?.problem(next.manifest.id)) return
          if (target && !target.enabled) throw new Error(`${library.name}：新版未启用，旧包保留；${target.reason ?? '请检查插件'}`)
          if (lib.services?.problem(next.manifest.id)) throw new Error(`${library.name}：新版服务启动失败`)
        }
        await new Promise(r => setTimeout(r, 100))
      }
      throw new Error(`${library.name}：新版界面尚未完成加载，旧包保留，请继续更新`)
    },
    resume() {
      for (const win of prepared) resumeWindow(win)
      prepared.clear()
      for (const win of BrowserWindow.getAllWindows()) win.webContents.send('packages:changed')
    }
  })
  return updates
}
