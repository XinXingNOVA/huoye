import type { ThemeDecoration } from './theme-decoration'
import type { ThemeIcons } from './theme-icons'
import type { ThemeParts } from './theme-parts'

export type ColorSchemeMode = 'dark' | 'light'
export type UiDensity = 'comfortable' | 'compact'

export type UiRadius = 'sharp' | 'rounded' | 'soft'

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

export interface ThemeVisual {
  tokens: ThemeTokens
  decoration?: ThemeDecoration
  icons?: ThemeIcons
  preview?: string
  parts?: ThemeParts
}

export interface ThemePreset extends ThemeVisual {
  id: string
  name: string
  description: string
  variants?: Record<ColorSchemeMode, ThemeVisual>
  images?: Record<string, string>
  appearance?: { density: UiDensity; radius: UiRadius; panelInset: number; readingFont: string }
}

export const CLASSIC_THEMES: ThemePreset[] = [
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
  },
  {
    id: 'celadon-study',
    name: '青瓷书房',
    description: '青瓷侧栏留白，暖纸正文配衬线字，适合长篇阅读。',
    appearance: { density: 'comfortable', radius: 'soft', panelInset: 6, readingFont: "'Songti SC', 'Noto Serif CJK SC', serif" },
    tokens: {
      scheme: 'light', shell: '#dbe7de', panel: '#eef4ec', panel2: '#e2ece3', bg: '#f6f8f2',
      elevated: '#fbfdf8', line: '#c5d3c8', text: '#24392f', muted: '#546c5d', accent: '#216451',
      danger: '#a53932', placeholder: '#dde7dc', paper: '#fcf7e9', ink: '#34362d'
    }
  },
  {
    id: 'compact-desk',
    name: '紧凑资料台',
    description: '深灰画布、细线分隔与紧凑表格，便于逐行核对资料。',
    appearance: { density: 'compact', radius: 'sharp', panelInset: 0, readingFont: 'system-ui, sans-serif' },
    tokens: {
      scheme: 'dark', shell: '#171b20', panel: '#20252c', panel2: '#2b333c', bg: '#191e24',
      elevated: '#303944', line: '#39434e', text: '#e4eaf1', muted: '#a0aebb', accent: '#87b9ee',
      danger: '#ff9288', placeholder: '#2d3640', paper: '#222830', ink: '#e1e8ee'
    }
  }
]
