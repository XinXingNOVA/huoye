import { unzipSync } from 'fflate'
import { posix } from 'node:path'

const MAX_ARCHIVE = 128 * 1024 * 1024
const MAX_TOTAL = 200 * 1024 * 1024
const MAX_ENTRY = 16 * 1024 * 1024

export function readArchive(bytes: Uint8Array): Map<string, Uint8Array> {
  if (bytes.length > MAX_ARCHIVE) throw new Error('EPUB 超过 128 MiB，暂不支持')
  const names = new Set<string>(); let total = 0
  const files = unzipSync(bytes, { filter(entry) {
    const name = entry.name
    if (!name || name.includes('\\') || name.includes('\0') || name.startsWith('/') || /^[a-z]:/i.test(name) || name.split('/').some(p => p === '..' || p === '.')) throw new Error('EPUB 包含越界资源路径')
    if (names.has(name)) throw new Error('EPUB 包含重名资源')
    names.add(name)
    total += entry.originalSize
    if (total > MAX_TOTAL) throw new Error('EPUB 解压内容超过 200 MiB')
    if (names.size > 5000 || entry.originalSize > MAX_ENTRY) throw new Error('EPUB 资源过多或单项超过 16 MiB')
    return !name.endsWith('/')
  } })
  total = 0
  for (const data of Object.values(files)) {
    total += data.length
    if (data.length > MAX_ENTRY || total > MAX_TOTAL) throw new Error('EPUB 解压内容超过限制')
  }
  const map = new Map(Object.entries(files))
  if (map.has('mimetype') && textOf(map.get('mimetype')!).trim() !== 'application/epub+zip') throw new Error('文件不是 EPUB')
  return map
}

export function textOf(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes)
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes)
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}

/** URI 先解码再规范化，只能指向本书容器；外部 URL 由调用者另行判定。 */
export function bookLink(base: string, href: string): { path: string; anchor?: string } | undefined {
  try {
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//') || href.includes('\\')) return undefined
    const [file, fragment] = href.split('#', 2)
    const decoded = decodeURIComponent(file.split('?')[0])
    if (decoded.startsWith('/') || decoded.includes('\\') || decoded.includes('\0')) return undefined
    const path = decoded ? posix.normalize(posix.join(posix.dirname(base), decoded)) : base
    if (path === '..' || path.startsWith('../') || path.startsWith('/') || /^[a-z]:/i.test(path)) return undefined
    return { path, ...(fragment ? { anchor: decodeURIComponent(fragment) } : {}) }
  } catch { return undefined }
}
