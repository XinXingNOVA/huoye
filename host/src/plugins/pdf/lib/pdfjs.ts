// 在核心进程里用 pdf.js 读 PDF（设计文档 11.11）：不依赖外部程序。
// 渲染用 @napi-rs/canvas（预编译的 N-API 模块，Electron 里不用重新编译）。

import { normalizePdfText } from '../text'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import type { PDFDocumentProxy } from 'pdfjs-dist/types/src/display/api'

const require = createRequire(import.meta.url)
const DIR = dirname(require.resolve('pdfjs-dist/package.json'))

/**
 * 载入 pdf.js。它按 process.type 判断自己是不是在 Node 里：核心进程是 Electron 的 utility 进程，
 * process.type 是 'utility'，会被当成浏览器——要网页的 Worker、用 fetch 读字体表、找 document 建画布，
 * 于是报"没有指定 workerSrc"。核心进程其实就是 Node：载入时让它看不到 process.type，按 Node 处理。
 * worker 也在这时载入（它自己也判断一次），跑在同一个进程里。测试里是普通的 Node，没有 process.type，不用管。
 */
async function load(): Promise<typeof import('pdfjs-dist/legacy/build/pdf.mjs')> {
  const type = Object.getOwnPropertyDescriptor(process, 'type')
  if (type) Object.defineProperty(process, 'type', { value: undefined, configurable: true, writable: true })
  try {
    const mod = await import('pdfjs-dist/legacy/build/pdf.mjs')
    // @ts-expect-error 没有类型声明；载入后设好 globalThis.pdfjsWorker，pdf.js 就在本进程里用它
    await import('pdfjs-dist/legacy/build/pdf.worker.mjs')
    return mod
  } finally {
    if (type) Object.defineProperty(process, 'type', type)
  }
}

let lib: ReturnType<typeof load> | undefined
const pdfjs = () => (lib ??= load())

/** 打开一个 PDF。用完要 closePdf()。有密码的打不开，说清楚。 */
export async function openPdf(path: string): Promise<PDFDocumentProxy> {
  const { getDocument } = await pdfjs()
  try {
    return await getDocument({
      data: new Uint8Array(await readFile(path)),
      // 中文等 CID 字体要用字符映射表；没有嵌入的标准字体用 pdf.js 带的
      cMapUrl: join(DIR, 'cmaps') + '/',
      cMapPacked: true,
      standardFontDataUrl: join(DIR, 'standard_fonts') + '/',
      verbosity: 0
    }).promise
  } catch (e) {
    if ((e as { name?: string }).name === 'PasswordException') throw new Error('有密码，打不开')
    throw e
  }
}

export const closePdf = (doc: PDFDocumentProxy) => doc.loadingTask.destroy()

/** 渲染一页成 JPEG：最长边 size 像素，白底（PDF 的页面本身是透明的）。 */
export async function renderPage(doc: PDFDocumentProxy, n: number, size: number): Promise<Buffer> {
  const { createCanvas } = await import('@napi-rs/canvas')
  const page = await doc.getPage(n)
  const base = page.getViewport({ scale: 1 })
  const viewport = page.getViewport({ scale: size / Math.max(base.width, base.height) })
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
  const context = canvas.getContext('2d')
  context.fillStyle = '#fff'
  context.fillRect(0, 0, canvas.width, canvas.height)
  await page.render({ canvas: canvas as unknown as HTMLCanvasElement, canvasContext: context as unknown as CanvasRenderingContext2D, viewport }).promise
  page.cleanup()
  return canvas.encode('jpeg', 88)
}

/**
 * 一页的文字。康熙部首、兼容汉字（有的 PDF 里"白"抽出来是"⽩"）、简化字形的部首换成普通汉字，否则搜不到；
 * 只换这几段，全角标点这些不动（整体做 NFKC 会把"，"变成","）。
 */
export async function pageText(doc: PDFDocumentProxy, n: number): Promise<string> {
  const page = await doc.getPage(n)
  const content = await page.getTextContent()
  page.cleanup()
  let out = ''
  for (const item of content.items) {
    if (!('str' in item)) continue
    out += item.str + (item.hasEOL ? '\n' : '')
  }
  return normalizePdfText(out)
}
