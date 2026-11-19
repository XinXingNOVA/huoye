// 版本 1：有大小上限的 gzip JSON 容器，文件以 base64 保存，不执行安装脚本。
import { createHash } from 'node:crypto'
import { gunzipSync, gzipSync } from 'node:zlib'
import { packageManifestSchema, type PackageManifest } from '../shared/external-plugins.ts'

export const MAX_PACKAGE_BYTES = 16 * 1024 * 1024
export const MAX_EXPANDED_BYTES = 48 * 1024 * 1024
const magic = Buffer.from('RMPLUGIN1\n')
export const digest = (data: Uint8Array) => createHash('sha256').update(data).digest('hex')
export function packagePath(path: string): boolean {
  return path.length < 240 && /^[a-zA-Z0-9_./-]+$/.test(path) && !path.startsWith('/') && path.split('/').every(p => !!p && p !== '.' && p !== '..')
}
export interface Archive { manifest: PackageManifest; files: Map<string, Buffer>; hash: string; bytes: number }
export function decodePackage(input: Buffer): Archive {
  if (input.length > MAX_PACKAGE_BYTES || !input.subarray(0, magic.length).equals(magic)) throw new Error('不是支持的 .hyplugin / .rmplugin 包，或文件超过 16 MB')
  const raw: unknown = JSON.parse(gunzipSync(input.subarray(magic.length), { maxOutputLength: MAX_EXPANDED_BYTES }).toString('utf8'))
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('插件包内容无效')
  const data = raw as Record<string, unknown>
  if (Object.keys(data).some(k => !['manifest', 'files'].includes(k))) throw new Error('插件包包含未知字段')
  const manifest = packageManifestSchema.parse(data.manifest)
  if (!Array.isArray(data.files) || !data.files.length || data.files.length > 256) throw new Error('插件包文件数必须为 1–256')
  const files = new Map<string, Buffer>(), names = new Set<string>()
  let size = 0
  for (const value of data.files) {
    if (!value || typeof value !== 'object') throw new Error('文件条目无效')
    const { path, content, sha256 } = value
    if (Object.keys(value).some(k => !['path', 'content', 'sha256'].includes(k))) throw new Error('文件条目包含未知字段')
    if (typeof path !== 'string' || !packagePath(path) || names.has(path.toLowerCase())) throw new Error('文件路径无效或重复')
    if (!/\.(mjs|css|json|png|jpg|jpeg|svg|webp|txt|woff2)$/.test(path) || typeof content !== 'string') throw new Error('包内包含不支持的文件类型')
    const bytes = Buffer.from(content, 'base64')
    if (bytes.toString('base64') !== content || digest(bytes) !== sha256) throw new Error(`文件摘要不匹配：${path}`)
    size += bytes.length
    if (size > 32 * 1024 * 1024) throw new Error('展开文件超过 32 MB')
    names.add(path.toLowerCase()); files.set(path, bytes)
  }
  for (const name of files.keys()) {
    const parts = name.split('/')
    for (let i = 1; i < parts.length; i++) if (names.has(parts.slice(0, i).join('/').toLowerCase())) throw new Error('文件和目录路径冲突')
  }
  for (const path of [...Object.values(manifest.entries), ...manifest.styles]) {
    if (!files.has(path) || (manifest.styles.includes(path) && !path.endsWith('.css'))) throw new Error(`声明的入口或样式不存在：${path}`)
  }
  return { manifest, files, hash: digest(input), bytes: input.length }
}
export function encodePackage(manifest: PackageManifest, files: Map<string, Buffer>): Buffer {
  const body = { manifest, files: [...files].sort(([a], [b]) => a.localeCompare(b)).map(([path, data]) => ({ path, content: data.toString('base64'), sha256: digest(data) })) }
  const result = Buffer.concat([magic, gzipSync(Buffer.from(JSON.stringify(body)), { level: 9 })])
  decodePackage(result)
  return result
}
