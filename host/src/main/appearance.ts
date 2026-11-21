import { app, ipcMain, nativeTheme, protocol } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { themeActionSchema, type AppearanceSnapshot } from '../shared/appearance'
import { MAX_THEME_BYTES } from '../shared/theme-package'
import { decorationSlot, maxPersonalImageBytes } from '../shared/theme-decoration'
import { ThemeStore } from './theme-store'
import { libraryOf, openLibraries } from './libraries'
import { launcherWindow } from './launcher'
import { trustedWindow } from './trusted-window'

let store: ThemeStore | undefined
let priorProfile = false
function notifyWindows() {
  for (const win of [launcherWindow(), ...openLibraries().map(l => l.win)]) {
    if (win && !win.isDestroyed()) win.webContents.send('appearance:changed')
  }
}
export function localThemes() {
  return store ??= new ThemeStore(join(app.getPath('userData'), 'themes'), notifyWindows, priorProfile)
}

export function registerAppearanceIpc() {
  // 在本次启动登记随附套件之前识别已使用的 0.1 安装；已保存的主题仍优先。
  const userData = app.getPath('userData')
  priorProfile = ['plugin-suites.json', 'vaults.json'].some(file => existsSync(join(userData, file)))
  let systemRevision = 0
  let dark = nativeTheme.shouldUseDarkColors
  nativeTheme.on('updated', () => {
    if (dark === nativeTheme.shouldUseDarkColors) return
    dark = nativeTheme.shouldUseDarkColors
    systemRevision++
    notifyWindows()
  })
  const snapshot = (id?: string): AppearanceSnapshot => {
    const saved = localThemes().snapshot(id)
    return { ...saved, revision: saved.revision + systemRevision, systemScheme: dark ? 'dark' : 'light' }
  }
  const library = (e: Electron.IpcMainInvokeEvent) => { trustedWindow(e); return libraryOf(e.sender)?.id }
  ipcMain.handle('appearance:load', (e, legacy?: unknown) => {
    const id = library(e), themes = localThemes()
    if (legacy) {
      const data = z.record(z.string().max(240), z.string().max(32768)).parse(legacy)
      const url = new URL(e.senderFrame!.url)
      const migratedKeys = themes.migrate(url.protocol === 'file:' ? url.pathname : url.origin, data)
      return { ...snapshot(id), migratedKeys }
    }
    return snapshot(id)
  })
  ipcMain.handle('appearance:change', (e, scope, raw) => {
    const id = library(e)
    if (scope !== 'application' && !(scope === 'library' && id)) throw new Error('无效的外观设置范围')
    localThemes().change(scope === 'library' ? id : undefined, themeActionSchema.parse(raw))
    return snapshot(id)
  })
  ipcMain.handle('appearance:decoration-image', async (e, slot, bytes) => {
    const id = library(e)
    if (!id || !(bytes instanceof Uint8Array) || bytes.length > maxPersonalImageBytes) throw new Error('请选择当前仓库和 20 MiB 以内的图片')
    await localThemes().setDecorationImage(id, decorationSlot.parse(slot), bytes)
    return snapshot(id)
  })
  ipcMain.handle('appearance:install', (e, name, bytes) => {
    const id = library(e)
    if (typeof name !== 'string' || !/\.hytheme$/i.test(name) || !(bytes instanceof Uint8Array) || bytes.length > MAX_THEME_BYTES) throw new Error('请选择 8 MiB 以内的 .hytheme 主题包')
    localThemes().install(bytes)
    return snapshot(id)
  })
  ipcMain.handle('appearance:remove', (e, key) => {
    const id = library(e)
    localThemes().remove(z.string().max(200).parse(key))
    return snapshot(id)
  })
}
export function registerThemeProtocol() {
  protocol.handle('huoye-theme', req => {
    const url = new URL(req.url)
    if (req.method !== 'GET' || url.search || url.username || url.password) return new Response(null, { status: 404 })
    const parts = url.pathname.slice(1).split('/')
    const personal = url.host === 'library' && parts.length === 2 && z.string().uuid().safeParse(parts[0]).success
    if (!personal && !(url.host === 'assets' && parts.length === 1)) return new Response(null, { status: 404 })
    const file = parts[parts.length - 1]
    const data = localThemes().image(file, personal ? parts[0] : undefined)
    return data ? new Response(new Uint8Array(data), { headers: { 'Content-Type': file.endsWith('.png') ? 'image/png' : 'image/webp', 'X-Content-Type-Options': 'nosniff' } }) : new Response(null, { status: 404 })
  })
}
