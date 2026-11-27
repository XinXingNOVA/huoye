import { consumedCapabilities } from '../shared/capability-declarations'
import { registerRuntimeSettings } from './runtime-settings'
import { app, BrowserWindow, ipcMain } from 'electron'
import { callCore } from './core-client'
import { libraryOf, openLibraries, runtimeSessions } from './libraries'
import { localPackages } from './plugin-packages'
import { readProviders, setProvider } from '../platform/provider-preferences'
import { trustedWindow } from './trusted-window'
import { mediaContracts } from '../shared/media-capabilities'
import type { ProviderChoice } from '../shared/capability-status'

function choices(library?: string): ProviderChoice[] {
  const overrides = library ? readProviders(app.getPath('userData'), library) : {}
  const preferences = readProviders(app.getPath('userData'))
  const packs = [...localPackages().list(), ...openLibraries().flatMap(lib => lib.packages.filter(p => p.development && !p.problem))]
  const ids = new Set([...Object.keys(mediaContracts), ...Object.keys(preferences), ...Object.keys(overrides), ...packs.flatMap(p => consumedCapabilities(p.manifest.capabilities))])
  const options = new Map<string, Map<string, string>>()
  for (const { manifest } of packs) {
    if (!manifest.entries.provider && !manifest.capabilities?.implementations?.some(i => i.via === 'service')) continue
    for (const id of manifest.capabilities?.provides ?? []) {
      ids.add(id)
      if (!options.has(id)) options.set(id, new Map())
      options.get(id)!.set(manifest.id, manifest.title)
    }
  }
  return [...ids].sort().map(id => ({ id, builtin: Object.hasOwn(mediaContracts, id), preferred: preferences[id] ?? null, override: overrides[id] ?? null,
    options: [...options.get(id) ?? []].map(([id, title]) => ({ id, title })) }))
}
export function registerProviderSettings() {
  registerRuntimeSettings()
  ipcMain.handle('providers:list', async event => {
    trustedWindow(event)
    const lib = libraryOf(event.sender)
    const loaded = lib && runtimeSessions.get(lib.core)?.providerPreferences
    const [current, plugins] = lib ? await Promise.all([callCore(lib.core, 'info'), callCore(lib.core, 'plugins')]) : [undefined, []]
    const enabled = plugins.filter(p => p.enabled)
    return choices(lib?.id).map(row => ({ ...row,
      pendingReload: !!loaded && (loaded[row.id] ?? null) !== (row.override === '@auto' ? null : row.override ?? row.preferred),
      current: current?.capabilities.find(s => s.id === row.id),
      optional: enabled.some(p => p.capabilities?.optionalConsumes?.includes(row.id)) && !enabled.some(p => p.capabilities?.consumes?.includes(row.id)) }))
  })
  ipcMain.handle('providers:set', (event, id: string, provider: string | null, scope: 'application' | 'library' = 'application') => {
    trustedWindow(event)
    const library = scope === 'library' ? libraryOf(event.sender)?.id : undefined
    if (scope !== 'application' && !(scope === 'library' && library)) throw Error('无效的引擎设置范围')
    const row = choices(library).find(c => c.id === id)
    if (!row || (provider !== null && !(library && provider === '@auto') && !row.options.some(p => p.id === provider))) throw Error('所选引擎不可用')
    setProvider(app.getPath('userData'), id, provider, library)
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send('providers:changed')
  })
}
