import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { PreviewResult } from '../../shared/preview'

/** 图像只能来自明确的素材预览或验收截图入口；业务 JSON 不据形状升级为图像。 */
export function toolResult(name: string, value: unknown): CallToolResult {
  if (name === 'read_preview' || name === 'capture_workbench_window') {
    const { image, ...metadata } = value as PreviewResult
    return { content: [{ type: 'text', text: JSON.stringify(metadata) }, ...(image ? [{ type: 'image' as const, mimeType: image.mimeType, data: image.data }] : [])],
      structuredContent: { ...metadata, ...(image ? { image: { mimeType: image.mimeType, width: image.width, height: image.height } } : {}) } }
  }
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value as Record<string, unknown> }
}
