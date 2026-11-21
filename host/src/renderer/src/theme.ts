import { hostLabel, uiText } from '../../shared/i18n/interface-display'
import { useSyncExternalStore } from 'react'
import { defaultPlacement, decorationControls, maxPersonalImageBytes, type DecorationControl, type DecorationSlot, type LocalDecoration } from '../../shared/theme-decoration'
import { applyThemeParts } from './theme-parts'
import { THEME_PRESETS } from '../../shared/builtin-themes'
import type { ThemePreset, ThemeTokens } from '../../shared/theme-presets'
import { builtinDefaults, legacyAppKey, legacyThemeKey, legacyLibraryKey, type ThemeAction, type ThemePreferences, type AppearanceSnapshot } from '../../shared/appearance'
import { MAX_MANIFEST_BYTES, MAX_THEME_BYTES } from '../../shared/theme-package'

export type { ThemePreferences }
export const ACCENT_SWATCHES = [
  { get name() { return uiText("海洋蓝") }, value: '#4c8dff' },
  { get name() { return uiText("靛青紫") }, value: '#7c6aff' },
  { get name() { return uiText("松石绿") }, value: '#3eb489' },
  { get name() { return uiText("琥珀金") }, value: '#e59934' },
  { get name() { return uiText("珊瑚红") }, value: '#f06459' },
  { get name() { return uiText("青岩灰") }, value: '#6495ed' }
]

let snapshot: AppearanceSnapshot = { revision: -1, systemScheme: 'light', application: builtinDefaults, installed: [] }
let displayLibraryId: string | undefined
const decorationPreview: Partial<Record<DecorationControl, number>> = {}
const listeners = new Set<() => void>()
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } }
export const findTheme = (id: string) => THEME_PRESETS.find(p => p.id === id) ?? snapshot.installed.find(p => p.id === id)
export function themeDisplayName(preset: ThemePreset) {
  if (preset.id === 'celadon-study' || preset.id === 'compact-desk') {
    return uiText("{name}（经典）", { name: hostLabel(preset.name) })
  }
  return preset.id.startsWith('external:') ? preset.name : hostLabel(preset.name)
}
export function themeForMode(preset: ThemePreset, mode: ThemePreferences['colorMode'] = 'system'): ThemePreset {
  if (!preset.variants) return preset
  const scheme = mode === 'system' ? snapshot.systemScheme : mode
  return { ...preset, ...preset.variants[scheme] }
}
export function activeTheme(prefs: ThemePreferences): ThemePreset {
  return themeForMode(findTheme(prefs.presetId) ?? THEME_PRESETS[0], prefs.colorMode)
}
export function resolveThemeTokens(prefs: ThemePreferences, preset = activeTheme(prefs)): ThemeTokens {
  return {
    ...preset.tokens,
    ...prefs.customTokens,
    ...(prefs.accent ? { accent: prefs.accent } : {})
  }
}

export function decorationValue(key: DecorationControl, preset?: ThemePreset, local?: LocalDecoration) {
  return local?.[key] ?? preset?.decoration?.[key] ?? decorationControls[key].initial
}

export function decorationPlacement<K extends keyof typeof defaultPlacement>(key: K, preset?: ThemePreset, local?: LocalDecoration) {
  return local?.[key] ?? preset?.decoration?.[key] ?? defaultPlacement[key]
}

export function previewDecorationControl(key: DecorationControl, value?: number) {
  if (!displayLibraryId || decorationPreview[key] === value) return
  if (value === undefined) delete decorationPreview[key]
  else decorationPreview[key] = value
  const prefs = snapshot.library ?? snapshot.application
  applyDecoration(document.documentElement, activeTheme(prefs))
}

function applyDecoration(root: HTMLElement, preset: ThemePreset) {
  const local = { ...snapshot.decoration, ...decorationPreview }
  const image = (slot: DecorationSlot) => {
    const source = local[slot]
    if (source === null) return
    if (source && 'entityId' in source) return 'var(--hy-material-wallpaper, none)'
    const ref = preset.decoration?.[slot]
    const url = source ? 'huoye-theme://library/' + displayLibraryId + '/' + source.file : ref && preset.images?.[ref]
    if (url) return 'url(' + JSON.stringify(new URL(url, document.baseURI).href) + ')'
  }
  const wallpaper = image('wallpaper'), sticker = image('sticker')
  const surface = !!(wallpaper || sticker || local.surfaceOpacity !== undefined || preset.decoration?.surfaceOpacity !== undefined ||
    local.surfaceBlur || preset.decoration?.surfaceBlur)
  for (const [slot, value] of [['wallpaper', wallpaper], ['sticker', sticker]] as const) {
    root.toggleAttribute('data-hy-' + slot, !!value)
    if (value) root.style.setProperty('--hy-' + slot, value)
    else root.style.removeProperty('--hy-' + slot)
  }
  if (wallpaper) {
    root.dataset.hyWallpaperFit = decorationPlacement('wallpaperFit', preset, local)
    root.style.setProperty('--hy-wallpaper-position', decorationPlacement('wallpaperAnchor', preset, local).replace('-', ' '))
  } else {
    delete root.dataset.hyWallpaperFit
    root.style.removeProperty('--hy-wallpaper-position')
  }
  if (sticker) root.dataset.hyStickerAnchor = decorationPlacement('stickerAnchor', preset, local)
  else delete root.dataset.hyStickerAnchor
  root.toggleAttribute('data-hy-glass', surface)
  root.toggleAttribute('data-hy-blur-cards', surface && (local.blurCards ?? preset.decoration?.blurCards ?? false))
  if (surface && decorationValue('surfaceBlur', preset, local) > 0) root.style.setProperty('--hy-surface-filter', 'blur(var(--hy-surface-blur))')
  else root.style.removeProperty('--hy-surface-filter')
  const properties = { wallpaperTileSize: ['--hy-wallpaper-tile-size', 'px'], stickerScale: ['--hy-sticker-scale', ''],
    stickerOpacity: ['--hy-sticker-opacity', '%'], wallpaperOpacity: ['--hy-wallpaper-opacity', '%'], wallpaperBlur: ['--hy-wallpaper-blur', 'px'],
    wallpaperBrightness: ['--hy-wallpaper-brightness', '%'], surfaceOpacity: ['--hy-surface-opacity', '%'], surfaceBlur: ['--hy-surface-blur', 'px'] } as const
  for (const key of Object.keys(properties) as DecorationControl[]) {
    const [name, unit] = properties[key]
    if (surface) root.style.setProperty(name, decorationValue(key, preset, local) + unit)
    else root.style.removeProperty(name)
  }
}

export function applyThemePreferences(prefs: ThemePreferences): void {
  const preset = activeTheme(prefs)
  const tokens = resolveThemeTokens(prefs, preset)
  const root = document.documentElement
  root.dataset.theme = preset.id
  root.dataset.scheme = tokens.scheme
  root.dataset.density = prefs.density
  root.dataset.radius = prefs.radius

  const { appearance } = preset
  const style = root.style
  style.setProperty('--hy-panel-inset', (appearance?.panelInset ?? 0) + 'px')
  style.setProperty('--hy-reading-font', appearance?.readingFont ?? 'inherit')
  style.setProperty('color-scheme', tokens.scheme)
  style.setProperty('--shell', tokens.shell)
  style.setProperty('--bg', tokens.bg)
  style.setProperty('--panel', tokens.panel)
  style.setProperty('--panel-2', tokens.panel2)
  style.setProperty('--elevated', tokens.elevated)
  style.setProperty('--line', tokens.line)
  style.setProperty('--border', tokens.line)
  style.setProperty('--text', tokens.text)
  style.setProperty('--muted', tokens.muted)
  style.setProperty('--accent', tokens.accent)
  style.setProperty('--danger', tokens.danger)
  style.setProperty('--placeholder', tokens.placeholder)
  style.setProperty('--paper', tokens.paper)
  style.setProperty('--ink', tokens.ink)

  const radiusPx = prefs.radius === 'sharp' ? '4px' : prefs.radius === 'soft' ? '10px' : '7px'
  const cardRadiusPx = prefs.radius === 'sharp' ? '5px' : prefs.radius === 'soft' ? '12px' : '8px'
  style.setProperty('--radius', radiusPx)
  style.setProperty('--card-radius', cardRadiusPx)
  applyThemeParts(document, preset.parts)
  if (displayLibraryId) applyDecoration(root, preset)
}

function receive(next: AppearanceSnapshot) {
  if (next.revision <= snapshot.revision) return
  snapshot = next
  applyThemePreferences((displayLibraryId && next.library) || next.application)
  listeners.forEach(fn => fn())
}

export async function changeTheme(action: ThemeAction, libraryId?: string) {
  receive(await window.bridge.appearance.change(libraryId ? 'library' : 'application', action))
}
export async function setMaterialWallpaper(entityId: string) {
  if (!displayLibraryId) throw new Error(uiText("请先打开仓库"))
  await changeTheme({ action: 'materialWallpaper', entityId }, displayLibraryId)
}
export async function setDecorationImage(slot: DecorationSlot, file: File) {
  if (file.size > maxPersonalImageBytes) throw new Error(uiText("请选择 20 MiB 以内的图片"))
  receive(await window.bridge.appearance.setDecorationImage(slot, new Uint8Array(await file.arrayBuffer())))
}
export async function installTheme(file: File) {
  if (file.size > MAX_THEME_BYTES) throw new Error(uiText("主题包超过 8 MiB"))
  receive(await window.bridge.appearance.install(file.name, new Uint8Array(await file.arrayBuffer())))
}
export async function uninstallTheme(id: string) {
  receive(await window.bridge.appearance.remove(id))
}

function legacyValues() {
  const result: Record<string, string> = {}
  for (const key of Object.keys(localStorage)) {
    if (!(key.startsWith(legacyThemeKey) || key === legacyAppKey || key.startsWith(legacyLibraryKey))) continue
    if (key.length > 240) continue
    const value = localStorage.getItem(key)
    if (value && value.length <= MAX_MANIFEST_BYTES) result[key] = value
  }
  return result
}
export async function initTheme(libraryId?: string) {
  displayLibraryId = libraryId
  window.bridge.appearance.onChanged(() => {
    void window.bridge.appearance.load().then(receive).catch(e => console.warn('[appearance]', e))
  })
  let old: Record<string, string> = {}
  let migratedKeys: string[] = []
  try { old = legacyValues() } catch (e) { console.warn('[appearance] 旧外观存储不可读', e) }
  try {
    const state = await window.bridge.appearance.load(Object.keys(old).length ? old : undefined)
    migratedKeys = state.migratedKeys ?? []
    receive(state)
  } catch (e) {
    snapshot = { ...snapshot, warning: uiText("本机外观未能读取：") + String(e) }
    applyThemePreferences(builtinDefaults)
    return
  }
  try {
    for (const key of migratedKeys) if (localStorage.getItem(key) === old[key]) localStorage.removeItem(key)
  } catch (e) { console.warn('[appearance] 清理已迁移外观时失败', e) }
}
export function useThemeSettings(libraryId?: string) {
  const state = useSyncExternalStore(subscribe, () => snapshot)
  return { prefs: (libraryId && state.library) || state.application, independent: !!libraryId && !!state.library,
    decoration: libraryId ? state.decoration : undefined, installed: state.installed, warning: state.warning }
}
