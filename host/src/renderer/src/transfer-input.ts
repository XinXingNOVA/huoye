import { uiText } from '../../shared/i18n/interface-display'
import { asElement } from './display-windows'
import { MAX_IMPORT_BYTES, type ImportInput, type IngestSource } from '../../shared/ingest-input'
import { planTransfer, uriList, webUrl, type TransferFacts } from '../../shared/transfer'
import { ENTITY_DRAG_TYPE } from './entity-drag'

export interface Incoming { paths?: string[]; inputs?: ImportInput[]; ids?: string[] }
interface Snapshot { facts: TransferFacts; files: File[] }

/** 必须在事件返回前读取 DataTransfer；异步只能读取已保留的 File。 */
export function snapshotTransfer(dt: DataTransfer): Snapshot {
  const files = [...dt.files]
  if (!files.length) for (const item of dt.items) {
    if (item.kind === 'file') { const file = item.getAsFile(); if (file) files.push(file) }
  }
  return { files, facts: {
    internal: dt.getData(ENTITY_DRAG_TYPE),
    files: files.map(file => ({ path: window.bridge.pathForFile(file), image: file.type.startsWith('image/') })),
    text: dt.getData('text/plain'), html: dt.getData('text/html'), htmlText: '', images: [],
    uris: uriList(dt.getData('text/uri-list'))
  } }
}

/** 只解析脱离页面的文档，不插入 DOM、不执行脚本。相对图片地址只按可信来源解析。 */
function htmlFacts(facts: TransferFacts, source?: IngestSource): TransferFacts {
  if (!facts.html) return facts
  const doc = new DOMParser().parseFromString(facts.html, 'text/html')
  doc.querySelectorAll('script,style,noscript,head,iframe,object,embed').forEach(el => el.remove())
  const base = source?.url
  const images = [...doc.querySelectorAll('img')].flatMap(img => {
    const src = img.getAttribute('src')?.trim()
    if (!src) return []
    if (src.startsWith('data:image/')) return [src]
    try {
      const url = webUrl(new URL(src, base).href)
      if (url) img.setAttribute('src', url)
      return url ?? []
    } catch { return [] }
  })
  if (base) for (const link of doc.querySelectorAll('a[href]')) {
    try { const url = webUrl(new URL(link.getAttribute('href')!, base).href); if (url) link.setAttribute('href', url) } catch { /* 留给文字转换器处理 */ }
  }
  return { ...facts, html: doc.body.innerHTML, htmlText: doc.body.textContent ?? '', images }
}

const imageExt: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/tiff': 'tiff', 'image/bmp': 'bmp', 'image/avif': 'avif', 'image/svg+xml': 'svg' }
async function bytesInput(file: Blob, name: string, source?: IngestSource): Promise<ImportInput> {
  if (!file.size || file.size > MAX_IMPORT_BYTES) throw new Error(uiText("剪贴板或拖入的数据为空或超过 32 MB，请保存为文件后导入"))
  const ext = imageExt[file.type]
  // 无名或浏览器生成的 image 文件以实际 MIME 为准，避免 JPG 被转成 PNG 后扩展名错误。
  const filename = ext ? `${name.replace(/\.[^.]+$/, '') || uiText("粘贴图片")}.${ext}` : name || uiText("粘贴文件")
  return { type: 'bytes', name: filename, bytes: new Uint8Array(await file.arrayBuffer()), ...(source ? { source } : {}) }
}

function embeddedImage(url: string): Blob {
  if (url.length > MAX_IMPORT_BYTES * 1.4) throw new Error(uiText("图片超过 32 MB"))
  const comma = url.indexOf(','), header = url.slice(5, comma), payload = url.slice(comma + 1)
  if (comma < 0) throw new Error(uiText("内嵌图片格式无效"))
  const mime = header.split(';')[0]
  // 不使用 fetch(data:)，不需要扩大界面的 connect-src 权限。
  let bytes: Uint8Array<ArrayBuffer>
  if (/;base64$/i.test(header)) bytes = Uint8Array.from(atob(decodeURIComponent(payload)), c => c.charCodeAt(0))
  else {
    // 按字节解百分号编码，不能用 UTF-8 文本解码器处理 PNG 等二进制内容。
    const encoded = new TextEncoder().encode(payload)
    let length = 0
    for (let i = 0; i < encoded.length; i++) {
      if (encoded[i] !== 37) { encoded[length++] = encoded[i]; continue }
      const hex = String.fromCharCode(encoded[i + 1] ?? 0, encoded[i + 2] ?? 0)
      if (!/^[\da-f]{2}$/i.test(hex)) throw new Error(uiText("内嵌图片编码无效"))
      encoded[length++] = Number.parseInt(hex, 16); i += 2
    }
    bytes = encoded.slice(0, length)
  }
  return new Blob([bytes], { type: mime })
}

export async function resolveTransfer(snapshot: Snapshot, source?: IngestSource): Promise<{ incoming: Incoming; warnings: string[] }> {
  const f = htmlFacts(snapshot.facts, source), plan = planTransfer(f), inputs: ImportInput[] = [], paths: string[] = [], warnings: string[] = []
  switch (plan.kind) {
    case 'internal': return { incoming: { ids: plan.ids }, warnings }
    case 'files':
      for (const [i, file] of snapshot.files.entries()) {
        if (f.files[i].path) paths.push(f.files[i].path)
        else try {
          const imageSource = f.files.length === 1 && file.type.startsWith('image/') ? webUrl(f.images[0] ?? f.uris[0] ?? f.text.trim()) : undefined
          inputs.push(await bytesInput(file, file.name, source ?? (imageSource ? { url: imageSource } : undefined)))
        } catch (e) { warnings.push(String(e instanceof Error ? e.message : e)) }
      }
      break
    case 'images':
      for (const url of plan.urls) {
        try {
          if (url.startsWith('data:image/')) {
            inputs.push(await bytesInput(embeddedImage(url), uiText("粘贴图片"), source))
          } else {
            const result = await window.bridge.downloadImage(url)
            if ('error' in result) throw new Error(result.error)
            inputs.push({ ...result.input, source: source ?? { url } })
          }
        } catch (e) {
          warnings.push(uiText("图片未下载：{value1}；可保存为本地文件后再导入", { value1: String(e instanceof Error ? e.message : String(e)) }))
          if (webUrl(url)) inputs.push({ type: 'text', text: url, source: source ?? { url } })
        }
      }
      break
    case 'html': inputs.push({ type: 'text', text: plan.text, html: plan.html, ...(source ? { source } : {}) }); break
    case 'links': inputs.push({ type: 'text', text: plan.urls.join('\n'), ...(source ? { source } : {}) }); break
    case 'text': inputs.push({ type: 'text', text: plan.text, ...(source ? { source } : {}) }); break
    case 'empty':
      if (f.html || snapshot.files.length) warnings.push(uiText("没有识别到可收录的内容，请尝试复制图片或保存为文件后导入"))
      break
  }
  return { incoming: { paths, inputs }, warnings }
}

/** 可编辑控件和自行接管传输的插件优先，宿主只处理未消费的操作。 */
export const editingTarget = (target: EventTarget | null): boolean => !!asElement(target) &&
  (!!asElement(target)!.closest('input,textarea,[role="textbox"]') || !!(asElement(target) as HTMLElement).isContentEditable)
