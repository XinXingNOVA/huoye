import { createHash } from 'node:crypto'
import { checkDecorationRaster, rasterFormat } from './theme-images'
import { readThemeIcon } from './theme-svg'
import { iconFile, type ThemeIcons } from '../shared/theme-icons'
import { iconPaths, type IconName } from '../shared/icon-catalog'
import { themeImageName } from '../shared/theme-decoration'
import { unzipSync } from 'fflate'
import { MAX_MANIFEST_BYTES, MAX_THEME_BYTES, parseTheme, type PackageVisual } from '../shared/theme-package'

export const themeDigest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
function manifest(bytes: Uint8Array) {
  if (bytes.length > MAX_MANIFEST_BYTES) throw new Error('主题清单超过 32 KiB')
  let data: unknown
  try { data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
  catch { throw new Error('主题清单需要 UTF-8 JSON') }
  return parseTheme(data)
}

export function decodeTheme(bytes: Uint8Array) {
  if (bytes.length > MAX_THEME_BYTES) throw new Error('主题包超过 8 MiB')
  const images = new Map<string, Buffer>()
  const drawings = new Map<string, ReturnType<typeof readThemeIcon>>()
  const finish = (json: Uint8Array) => {
    const pack = manifest(json)
    const checkedImages = new Set<string>(), referencedIcons = new Set<string>()
    const validateVisual = (visual: PackageVisual) => {
      const decoration = 'decoration' in visual ? visual.decoration : undefined
      const preview = 'preview' in visual ? visual.preview : undefined
      for (const ref of [preview, decoration?.wallpaper, decoration?.sticker]) {
        if (!ref || checkedImages.has(ref)) continue
        const data = images.get(ref)
        if (!data) throw new Error((ref === preview ? '主题包缺少预览图：' : '主题包缺少装饰图片：') + ref)
        checkDecorationRaster(data, ref)
        checkedImages.add(ref)
      }
      const icons: ThemeIcons = {}
      const refs = 'icons' in visual ? visual.icons : undefined
      for (const [name, file] of Object.entries(refs ?? {})) {
        const drawing = drawings.get(file)
        if (!drawing) throw new Error('主题缺少图标：' + file)
        icons[name as IconName] = drawing
        referencedIcons.add(file)
      }
      return icons
    }
    const icons = pack.formatVersion === 6 ? {} : validateVisual(pack)
    const variantIcons = pack.formatVersion === 6
      ? { light: validateVisual(pack.variants.light), dark: validateVisual(pack.variants.dark) } : undefined
    if (referencedIcons.size !== drawings.size) throw new Error('主题包含未引用的图标')
    return { manifest: pack, images, icons, variantIcons }
  }
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) return finish(bytes)
  const seen = new Set<string>()
  let total = 0, imageCount = 0, iconCount = 0
  const files = unzipSync(bytes, { filter: entry => {
    if (['images/', 'icons/'].includes(entry.name) && entry.originalSize === 0) return false
    const icon = iconFile.test(entry.name)
    if (icon && ++iconCount > 2 * Object.keys(iconPaths).length) throw new Error('主题图标过多')
    if (themeImageName.test(entry.name) && ++imageCount > 16) throw new Error('主题图片超过 16 张')
    if (seen.has(entry.name) || (entry.name !== 'theme.json' && !icon && !themeImageName.test(entry.name))) throw new Error('主题包中有未支持或重复的资源')
    seen.add(entry.name)
    total += entry.originalSize
    if (total > MAX_THEME_BYTES || entry.originalSize > (entry.name === 'theme.json' ? MAX_MANIFEST_BYTES : icon ? 16 * 1024 : 4 * 1024 * 1024)) throw new Error('主题资源解包尺寸过大')
    return true
  } })
  if (!files['theme.json']) throw new Error('主题包缺少 theme.json')
  for (const [name, value] of Object.entries(files)) {
    if (name === 'theme.json') continue
    if (iconFile.test(name)) { drawings.set(name, readThemeIcon(value, name)); continue }
    const data = Buffer.from(value)
    if (!name.endsWith('.' + rasterFormat(data))) throw new Error('主题图片类型与扩展名不符：' + name)
    images.set(name, data)
  }
  return finish(files['theme.json'])
}
