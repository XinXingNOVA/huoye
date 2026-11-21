import { useLayoutEffect } from 'react'
import { useEntity } from '../../plugin-api/ui/data'
import type { EntityView } from '../../shared/blocks'
import { libraryFileUrl } from '../../shared/file-location'
import { useThemeSettings } from './theme'

export function wallpaperBlock(view?: EntityView) {
  if (!view || view.deletedAt || !view.blocks.image || !view.blocks.file) return
  const { image, file, thumb } = view.blocks
  const pixels = Number(image.data.width) * Number(image.data.height)
  if (!image.data.animated && pixels > 0 && pixels <= 16_000_000 && Number(file.data.size) <= 20 * 1024 * 1024
      && /^(jpe?g|png|webp|avif|bmp)$/i.test(String(file.data.ext))) return file
  return thumb
}

/** 只订阅当前作为壁纸的身份，回收、恢复或原件换版时沿用素材卡片的失效机制。 */
export function MaterialWallpaper({ libraryId }: { libraryId: string }) {
  const { decoration } = useThemeSettings(libraryId)
  const source = decoration?.wallpaper
  const view = useEntity(source && 'entityId' in source ? source.entityId : undefined)
  const block = wallpaperBlock(view)
  useLayoutEffect(() => {
    const style = document.documentElement.style
    if (block && typeof block.data.path === 'string') {
      try {
        const url = libraryFileUrl(libraryId, block.data.path, block.seq)
        style.setProperty('--hy-material-wallpaper', 'url(' + JSON.stringify(url) + ')')
      } catch { /* 无效的历史引用回退到画布底色。 */ }
    }
    return () => { style.removeProperty('--hy-material-wallpaper') }
  }, [libraryId, block])
  return null
}
