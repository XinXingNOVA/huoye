import { CLASSIC_THEMES, type ThemePreset, type ThemeVisual } from './theme-presets'
import { silverIcons } from './silver-icons'

const system = 'system-ui, sans-serif'
const serif = "'Songti SC', 'Noto Serif CJK SC', serif"

function paired(id: string, name: string, description: string, appearance: NonNullable<ThemePreset['appearance']>,
  light: ThemeVisual, dark: ThemeVisual): ThemePreset {
  const images: Record<string, string> = {}
  for (const visual of [light, dark]) {
    visual.preview = 'preview-' + visual.tokens.scheme + '.webp'
    for (const file of [visual.preview, visual.decoration?.wallpaper]) {
      if (file) images[file] = './themes/' + id + '/' + file
    }
  }
  return { id, name, description, appearance, ...light, variants: { light, dark }, images }
}

const albumParts = {
  'card-caption': { placement: 'overlay', align: 'center', weight: 600 },
  'card-cover': { frameWidth: 1, frameColor: 'line', radius: 0 },
  'inspector-section': { background: 'elevated', inset: 10, radius: 2 }
} as const
const printGrain = { wallpaperFit: 'tile', wallpaperAnchor: 'top-left', wallpaperTileSize: 120, surfaceOpacity: 94 } as const
const reader = { maxWidth: 680, inset: 36, textSize: 18, lineHeight: 1.85, paperColor: 'paper', inkColor: 'ink', surround: 'panel' } as const
const studyParts = { 'inspector-section': { background: 'elevated', inset: 10, radius: 8 }, 'card-cover': { radius: 12 } } as const
const bamboo = { wallpaperAnchor: 'right', wallpaperOpacity: 76, surfaceOpacity: 80 } as const
const deskParts = { 'card-cover': { frameWidth: 1, frameColor: 'line', radius: 2 }, 'card-caption': { weight: 500 } } as const

export const FEATURED_THEMES = [
  paired('huoye-standard', '活页 · 标准', '纸白与石墨灰，青绿标出选中项。适合日常收集和整理。',
    { density: 'comfortable', radius: 'rounded', panelInset: 0, readingFont: system },
    { tokens: { scheme: 'light', shell: '#e5eae8', panel: '#f1f4f2', panel2: '#e4eae7', bg: '#fafbf9', elevated: '#ffffff',
      line: '#cbd5d0', text: '#202b28', muted: '#566762', accent: '#08756b', danger: '#af3838', placeholder: '#e5ebe7', paper: '#fffdf8', ink: '#282c29' } },
    { tokens: { scheme: 'dark', shell: '#161a1b', panel: '#1e2324', panel2: '#2c3334', bg: '#202526', elevated: '#303739',
      line: '#3b4545', text: '#e9eeec', muted: '#a1afab', accent: '#6bd3c3', danger: '#ff958a', placeholder: '#2b3232', paper: '#292d2c', ink: '#e5e9e4' } }),
  paired('silver-gelatin', '银盐画册', '细黑框、印刷图标与封面题签，让照片占满画幅。',
    { density: 'comfortable', radius: 'sharp', panelInset: 0, readingFont: serif },
    { tokens: { scheme: 'light', shell: '#e8e8e5', panel: '#f2f2f0', panel2: '#e4e4e0', bg: '#fafafa', elevated: '#ffffff',
      line: '#d0d0cb', text: '#111111', muted: '#5a5a57', accent: '#141414', danger: '#bb2525', placeholder: '#ecece8', paper: '#ffffff', ink: '#111111' },
      parts: albumParts, icons: silverIcons, decoration: { ...printGrain, wallpaper: 'grain-light.webp', wallpaperOpacity: 45 } },
    { tokens: { scheme: 'dark', shell: '#070708', panel: '#121214', panel2: '#1b1b1e', bg: '#0b0b0c', elevated: '#1f1f23',
      line: '#39393e', text: '#f5f5f5', muted: '#aaaaae', accent: '#e2e2e6', danger: '#ff8179', placeholder: '#161619', paper: '#141416', ink: '#ececec' },
      parts: albumParts, icons: silverIcons, decoration: { ...printGrain, wallpaper: 'grain-dark.webp', wallpaperOpacity: 40 } }),
  paired('celadon-reading', '青瓷书房', '竹影落在页边，衬线正文配宽行距，适合长文与摘录。',
    { density: 'comfortable', radius: 'soft', panelInset: 6, readingFont: serif },
    { tokens: { scheme: 'light', shell: '#d9e5dd', panel: '#edf2e9', panel2: '#dfe9dd', bg: '#f5f5ea', elevated: '#fbfcf6',
      line: '#bfcec2', text: '#263c33', muted: '#52695d', accent: '#2b6957', danger: '#ac4338', placeholder: '#e1e7da', paper: '#fff9e9', ink: '#37382d' },
      parts: { ...studyParts, 'reader-page': { ...reader, pdfPaper: 'warm' } }, decoration: { ...bamboo, wallpaper: 'bamboo-light.webp' } },
    { tokens: { scheme: 'dark', shell: '#19251f', panel: '#22322a', panel2: '#304337', bg: '#1d2b24', elevated: '#2b3c31',
      line: '#435648', text: '#e2e9da', muted: '#a5b7a8', accent: '#98ceb1', danger: '#ee9d8c', placeholder: '#354338', paper: '#29312a', ink: '#e6e2cf' },
      parts: { ...studyParts, 'reader-page': { ...reader, pdfPaper: 'dark' } }, decoration: { ...bamboo, wallpaper: 'bamboo-dark.webp' } }),
  paired('reference-desk', '紧凑资料台', '紧凑行距、细分隔线与蓝色焦点，适合逐行核对字段。',
    { density: 'compact', radius: 'sharp', panelInset: 0, readingFont: system },
    { tokens: { scheme: 'light', shell: '#dde2e8', panel: '#edf0f3', panel2: '#dde4eb', bg: '#fafbfc', elevated: '#ffffff',
      line: '#b9c4ce', text: '#202a35', muted: '#536271', accent: '#215b9b', danger: '#b53740', placeholder: '#e1e6eb', paper: '#fbfcfc', ink: '#242e39' }, parts: deskParts },
    { tokens: { scheme: 'dark', shell: '#12171c', panel: '#1e252d', panel2: '#293542', bg: '#181e25', elevated: '#303b47',
      line: '#405061', text: '#e3eaf1', muted: '#a4b4c4', accent: '#8dbff1', danger: '#f59891', placeholder: '#2c3742', paper: '#222a32', ink: '#e4eaf0' }, parts: deskParts })
]

export const THEME_PRESETS = [...FEATURED_THEMES, ...CLASSIC_THEMES]
