import { useEffect, useState } from 'react'

export type ColorSchemeMode = 'dark' | 'light'
export type UiDensity = 'comfortable' | 'compact'

export interface ThemeTokens {
  scheme: ColorSchemeMode
  /** 最外层导航壳（ActivityBar / 标题栏基底） */
  shell: string
  /** 侧栏与检查器背景 */
  panel: string
  /** 控件、悬浮行、二级卡片背景 */
  panel2: string
  /** 主画布（内容区）背景 */
  bg: string
  /** 浮层、菜单、弹窗背景 */
  elevated: string
  /** 边框与分割线 */
  line: string
  /** 主文字 */
  text: string
  /** 辅助说明文字 */
  muted: string
  /** 强调色 */
  accent: string
  /** 危险/删除色 */
  danger: string
  /** 封面占位底色 */
  placeholder: string
  /** 阅读器纸张底色 */
  paper: string
  /** 阅读器墨水字色 */
  ink: string
}

export interface ThemePreset {
  id: string
  name: string
  description: string
  tokens: ThemeTokens
}

export interface ThemePreferences {
  presetId: string
  accent?: string
  density: UiDensity
  radius: 'sharp' | 'rounded' | 'soft'
  customTokens?: Partial<Pick<ThemeTokens, 'bg' | 'panel' | 'shell' | 'text' | 'accent' | 'paper'>>
}

export const THEME_STORAGE_KEY = 'rm:theme-preferences:v1'

export const THEME_PRESETS: ThemePreset[] = [
  {
    id: 'obsidian',
    name: '深邃曜石',
    description: '沉静暗色，壳层后退、画布微亮，适合长时间专注整理图片与多模态素材',
    tokens: {
      scheme: 'dark',
      shell: '#131417',
      panel: '#18191d',
      panel2: '#22242a',
      bg: '#1c1d22',
      elevated: '#25272e',
      line: '#2a2c33',
      text: '#ececef',
      muted: '#8a8d98',
      accent: '#4c8dff',
      danger: '#ff6b5b',
      placeholder: '#25272e',
      paper: '#f4f1ea',
      ink: '#2b2a27'
    }
  },
  {
    id: 'graphite',
    name: '冷灰石墨',
    description: '中性高对比暗色，层次分明，适合弱光环境下的精细校对',
    tokens: {
      scheme: 'dark',
      shell: '#0f1012',
      panel: '#151619',
      panel2: '#1f2126',
      bg: '#191a1e',
      elevated: '#22242a',
      line: '#282a30',
      text: '#f0f1f4',
      muted: '#828691',
      accent: '#5e9eff',
      danger: '#f87171',
      placeholder: '#22242a',
      paper: '#f2efe9',
      ink: '#262522'
    }
  },
  {
    id: 'pine',
    name: '松烟墨绿',
    description: '带有自然温润感的深色主题，舒缓视觉疲劳',
    tokens: {
      scheme: 'dark',
      shell: '#111615',
      panel: '#161c1b',
      panel2: '#202826',
      bg: '#19201f',
      elevated: '#222b29',
      line: '#273230',
      text: '#e7efed',
      muted: '#859692',
      accent: '#3eb489',
      danger: '#f27063',
      placeholder: '#212a28',
      paper: '#f3f1ea',
      ink: '#252927'
    }
  },
  {
    id: 'warm-paper',
    name: '暖日宣纸',
    description: '温润护眼的浅色书房风格，适合大量文献、笔记与摘录阅读',
    tokens: {
      scheme: 'light',
      shell: '#eae6df',
      panel: '#f2efe9',
      panel2: '#e5e0d8',
      bg: '#faf8f5',
      elevated: '#ffffff',
      line: '#dfdbd2',
      text: '#262523',
      muted: '#73706a',
      accent: '#2f6fed',
      danger: '#dc4c3e',
      placeholder: '#eae6df',
      paper: '#fffdf9',
      ink: '#242320'
    }
  },
  {
    id: 'daylight',
    name: '晴空极简',
    description: '通透明快的现代浅色工作台，色彩还原准确',
    tokens: {
      scheme: 'light',
      shell: '#ebedf0',
      panel: '#f3f4f6',
      panel2: '#e5e7eb',
      bg: '#ffffff',
      elevated: '#ffffff',
      line: '#e2e4e9',
      text: '#18191c',
      muted: '#686b73',
      accent: '#2563eb',
      danger: '#e11d48',
      placeholder: '#eef0f3',
      paper: '#fcfbf9',
      ink: '#1f2023'
    }
  }
]

export const ACCENT_SWATCHES = [
  { name: '海洋蓝', value: '#4c8dff' },
  { name: '靛青紫', value: '#7c6aff' },
  { name: '松石绿', value: '#3eb489' },
  { name: '琥珀金', value: '#e59934' },
  { name: '珊瑚红', value: '#f06459' },
  { name: '青岩灰', value: '#6495ed' }
]

const DEFAULT_PREFS: ThemePreferences = {
  presetId: 'obsidian',
  density: 'comfortable',
  radius: 'rounded'
}

export function loadThemePreferences(): ThemePreferences {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY)
    if (!raw) return DEFAULT_PREFS
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return DEFAULT_PREFS
    const presetId = THEME_PRESETS.some(p => p.id === parsed.presetId) ? parsed.presetId : DEFAULT_PREFS.presetId
    const density: UiDensity = parsed.density === 'compact' ? 'compact' : 'comfortable'
    const radius = parsed.radius === 'sharp' || parsed.radius === 'soft' ? parsed.radius : 'rounded'
    const accent = typeof parsed.accent === 'string' && /^#[0-9a-fA-F]{6}$/.test(parsed.accent) ? parsed.accent : undefined
    const customTokens = parsed.customTokens && typeof parsed.customTokens === 'object' ? parsed.customTokens : undefined
    return { presetId, density, radius, accent, customTokens }
  } catch {
    return DEFAULT_PREFS
  }
}

export function resolveThemeTokens(prefs: ThemePreferences): ThemeTokens {
  const preset = THEME_PRESETS.find(p => p.id === prefs.presetId) ?? THEME_PRESETS[0]
  return {
    ...preset.tokens,
    ...(prefs.customTokens ?? {}),
    ...(prefs.accent ? { accent: prefs.accent } : {})
  }
}

export function applyThemePreferences(prefs: ThemePreferences): void {
  const tokens = resolveThemeTokens(prefs)
  const root = document.documentElement
  root.dataset.theme = prefs.presetId
  root.dataset.scheme = tokens.scheme
  root.dataset.density = prefs.density
  root.dataset.radius = prefs.radius

  const style = root.style
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
}

const listeners = new Set<() => void>()

export function saveThemePreferences(next: ThemePreferences): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify(next))
  } catch {
    // 忽略本机存储受限
  }
  applyThemePreferences(next)
  listeners.forEach(fn => fn())
}

export function initTheme(): void {
  applyThemePreferences(loadThemePreferences())
  window.addEventListener('storage', (e) => {
    if (e.key === THEME_STORAGE_KEY) {
      applyThemePreferences(loadThemePreferences())
      listeners.forEach(fn => fn())
    }
  })
}

export function useThemePreferences(): [ThemePreferences, (next: ThemePreferences) => void] {
  const [prefs, setPrefs] = useState<ThemePreferences>(loadThemePreferences)
  useEffect(() => {
    const sync = () => setPrefs(loadThemePreferences())
    listeners.add(sync)
    return () => { listeners.delete(sync) }
  }, [])
  return [prefs, saveThemePreferences]
}
