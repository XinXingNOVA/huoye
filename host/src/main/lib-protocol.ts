import { portablePath } from '../shared/paths'
import { parseDirectoryReference, readDirectoryReference, directoryStamp } from '../storage/directory-reference'
import { LibraryFiles } from '../storage/library-files'
// lib://library/<文件引用>：只允许访问本库缓存和已关联空间的明确内容版本。
//
// 自己处理字节区间请求（Range → 206）。实测 net.fetch 读本地文件时忽略 Range、整份返回 200，
// 播放器因此认为不能跳转，拖动进度条会落回开头（设计文档 11.3）。
// 允许跨源读取：页面（开发时是 http://localhost，打包后是 file://）里的 pdf.js 用 XHR 按区间读 PDF，
// 要看得到 Content-Range 这些响应头（设计文档 11.11）。

import { constants, createReadStream } from 'node:fs'
import { open, stat, type FileHandle } from 'node:fs/promises'
import { extname } from 'node:path'
import { Readable } from 'node:stream'

const MIME: Record<string, string> = {
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  woff2: 'font/woff2',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  webm: 'video/webm',
  ogv: 'video/ogg',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  pdf: 'application/pdf',
  txt: 'text/plain; charset=utf-8'
}

/** 跨源读取：任何页面都可以读（只有本应用的页面能用 lib:// 协议），区间请求要看得到这几个响应头。 */
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Range',
  'Access-Control-Expose-Headers': 'Accept-Ranges, Content-Range, Content-Length, Content-Type'
}

/** 跨源请求先问一下（带 Range 头的 XHR）。 */
export const preflight = () => new Response(null, { status: 204, headers: { ...CORS, 'Access-Control-Allow-Methods': 'GET, HEAD' } })

export async function serveLibraryFile(root: string, request: Request): Promise<Response> {
  let abs: string
  try {
    const rel = portablePath(decodeURIComponent(new URL(request.url).pathname)).replace(/^\/+/, '')
    const directory = parseDirectoryReference(rel)
    if (directory) {
      const item = readDirectoryReference(root, undefined, directory)
      const file = await open(item.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
      try {
        const st = await file.stat({ bigint: true })
        if (!st.isFile() || directoryStamp(st) !== item.stamp) throw new Error('原地文件在打开期间已变化')
        return await fileResponse(item.path, request, item.size, file)
      } catch (e) { await file.close(); throw e }
    }
    abs = new LibraryFiles(root).resolve(rel)
  } catch { return new Response('forbidden', { status: 403 }) }
  return serveFile(abs, request)
}

/** 读一个文件（支持区间请求）。 */
export async function serveFile(abs: string, request: Request): Promise<Response> {
  let size: number
  try {
    const st = await stat(abs)
    if (!st.isFile()) return new Response('not found', { status: 404 })
    size = st.size
  } catch {
    return new Response('not found', { status: 404 })
  }

  return fileResponse(abs, request, size)
}

async function fileResponse(abs: string, request: Request, size: number, file?: FileHandle): Promise<Response> {
  const body = (start?: number, end?: number) => {
    const options = start === undefined ? {} : { start, end }
    const stream = file ? file.createReadStream(options) : createReadStream(abs, options)
    return Readable.toWeb(stream) as ReadableStream
  }
  const headers: Record<string, string> = {
    ...CORS,
    'Accept-Ranges': 'bytes',
    'Content-Type': MIME[extname(abs).slice(1).toLowerCase()] ?? 'application/octet-stream'
  }

  const range = request.headers.get('range')
  const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null
  if (!m || (m[1] === '' && m[2] === '')) {
    headers['Content-Length'] = String(size)
    return new Response(body(), { status: 200, headers })
  }

  // bytes=a-b / bytes=a- / bytes=-n（最后 n 个字节）
  let start: number
  let end: number
  if (m[1] === '') {
    start = Math.max(0, size - Number(m[2]))
    end = size - 1
  } else {
    start = Number(m[1])
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1)
  }
  if (start >= size || start > end) {
    await file?.close()
    return new Response(null, { status: 416, headers: { ...CORS, 'Content-Range': `bytes */${size}` } })
  }
  headers['Content-Range'] = `bytes ${start}-${end}/${size}`
  headers['Content-Length'] = String(end - start + 1)
  return new Response(body(start, end), { status: 206, headers })
}
