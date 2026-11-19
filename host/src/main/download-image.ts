import sharp from 'sharp'
import { MAX_IMPORT_BYTES, type ImportInput } from '../shared/ingest-input'
import { portableFileName } from '../shared/paths'
import { webUrl } from '../shared/transfer'

/** 用户明确拖入/粘贴的图片地址；无浏览器 Cookie、无任意文件协议，重定向也逐跳检查。 */
export async function downloadImage(input: string): Promise<Extract<ImportInput, { type: 'bytes' }>> {
  const initial = typeof input === 'string' && input.length <= 16384 ? webUrl(input) : undefined
  if (!initial) throw new Error('只支持 HTTP / HTTPS 图片地址')
  let url: string = initial
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15000)
  try {
    for (let redirects = 0; redirects <= 5; redirects++) {
      const response = await fetch(url, { signal: controller.signal, redirect: 'manual', credentials: 'omit', headers: { Accept: 'image/*' } })
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel()
        const location = response.headers.get('location')
        const next = location && webUrl(new URL(location, url).href)
        if (!next) throw new Error('图片重定向地址无效')
        url = next; continue
      }
      if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error(`服务器返回 ${response.status}`) }
      const length = Number(response.headers.get('content-length'))
      if (length > MAX_IMPORT_BYTES) { await response.body.cancel(); throw new Error('图片超过 32 MB') }
      const reader = response.body.getReader(), chunks: Uint8Array[] = []
      let size = 0
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          size += value.byteLength
          if (size > MAX_IMPORT_BYTES) throw new Error('图片超过 32 MB')
          chunks.push(value)
        }
      } finally { await reader.cancel() }
      const bytes = Buffer.concat(chunks)
      // 不凭网址后缀或服务器 MIME 把登录页面保存成图片，也不重新编码原图。
      const meta = await sharp(bytes).metadata().catch(() => { throw new Error('地址返回的不是可识别的图片，可能需要登录或不允许下载') })
      const ext = ({ jpeg: 'jpg', png: 'png', gif: 'gif', webp: 'webp', tiff: 'tiff', avif: 'avif', heif: 'heif', svg: 'svg' } as Record<string, string>)[meta.format ?? '']
      if (!ext || !meta.width || !meta.height) throw new Error('暂不支持这种图片格式')
      let name = '网页图片'
      try { name = portableFileName(decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '')) || name } catch { /* 使用默认名称 */ }
      name = `${name.replace(/\.[^.]+$/, '').slice(0, 60) || '网页图片'}.${ext}`
      return { type: 'bytes', name, bytes: new Uint8Array(bytes) }
    }
    throw new Error('图片地址重定向次数过多')
  } catch (e) {
    if (controller.signal.aborted) throw new Error('图片下载超时')
    throw e
  } finally { clearTimeout(timer) }
}
