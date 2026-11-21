import { interfaceText, type InterfaceArgs, type InterfaceSource } from '../shared/i18n/interface-text'
import { app, ipcMain } from 'electron'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { preferredLanguage, translator, type LanguagePreference, type LanguageSnapshot } from '../shared/i18n'
import { launcherWindow } from './launcher'
import { openLibraries } from './libraries'
import { trustedWindow } from './trusted-window'

let state: LanguageSnapshot = { preference: 'system', locale: 'zh-CN', revision: 0 }
export function uiText<S extends InterfaceSource>(source: S, ...args: InterfaceArgs<S>) {
  return interfaceText(state.locale, source, ...args)
}

export let mainText = translator(state.locale)

export function registerLanguage(updateMenu: () => void) {
  const file = join(app.getPath('userData'), 'language.json')
  const valid = (v: unknown): v is LanguagePreference => v === 'system' || v === 'zh-CN' || v === 'en'
  let preference: LanguagePreference = 'system'
  if (existsSync(file)) {
    try { const saved = JSON.parse(readFileSync(file, 'utf8')).preference; if (valid(saved)) preference = saved }
    catch (e) { console.warn('[language]', e) }
  }
  const effective = (value: LanguagePreference) => {
    if (value !== 'system') return value
    const override = process.env.HUOYE_LOCALE || (process.env.CAPTURE_DIR ? 'zh-CN' : undefined)
    return preferredLanguage(override ? [override] : app.getPreferredSystemLanguages())
  }
  state = { preference, locale: effective(preference), revision: 0 }
  mainText = translator(state.locale)
  function publish(next: LanguagePreference) {
    const locale = effective(next)
    if (state.preference === next && state.locale === locale) return
    state = { preference: next, locale, revision: state.revision + 1 }
    mainText = translator(locale)
    updateMenu()
    for (const win of [launcherWindow(), ...openLibraries().map(lib => lib.win)]) {
      if (win && !win.isDestroyed()) win.webContents.send('language:changed', state)
    }
  }
  app.on('browser-window-focus', () => { if (state.preference === 'system') publish('system') })
  ipcMain.handle('language:get', event => { trustedWindow(event); return state })
  ipcMain.handle('language:set', (event, value: unknown) => {
    trustedWindow(event)
    if (!valid(value)) throw new Error('Unsupported language')
    if (value !== state.preference) {
      writeFileSync(file + '.tmp', JSON.stringify({ preference: value }), { mode: 0o600 })
      renameSync(file + '.tmp', file)
    }
    publish(value)
    return state
  })
}
