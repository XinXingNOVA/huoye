import type { IngestMetadata } from '../plugin-api/ingest'

/** 接入时知道的来源（例如从浏览器复制时剪贴板里带的网页地址）。 */
export interface IngestSource {
  url: string
  title?: string
}

/**
 * 接入的输入：外部的东西经由识别器变成身份和数据块。
 * 文字可以带上剪贴板、拖拽里的 HTML，由文字插件决定怎么理解（转成 Markdown）。
 */
export type IngestInput =
  | { type: 'file'; path: string; source?: IngestSource; metadata?: IngestMetadata }
  | { type: 'text'; text: string; html?: string; source?: IngestSource; metadata?: IngestMetadata }

/** 宿主先将无路径的数据暂存成普通文件，插件仍只接收 IngestInput。 */
export type ImportInput = IngestInput | { type: 'bytes'; name: string; bytes: Uint8Array; source?: IngestSource; metadata?: IngestMetadata }
export const MAX_IMPORT_BYTES = 32 * 1024 * 1024
