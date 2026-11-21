import { portablePath, portableFileName } from './paths'

export function isDirectoryFile(reference: unknown): boolean {
  return typeof reference === 'string' && reference.startsWith('directories/v1/')
}

export function fileReference(value: string): string {
  const rel = portablePath(value)
  if (!rel || rel.startsWith('/') || rel.includes(':') || rel.includes('\0') ||
    rel.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('[INVALID_FILE_REFERENCE] 文件引用必须是库内相对路径')
  }
  return rel
}

/** 兼容同步 UI API；只做布局解析，实际文件访问由宿主的存储层检查。 */
export function localFilePath(root: string, reference: string): string {
  return `${portablePath(root).replace(/\/+$/, '')}/${fileReference(reference)}`
}

export function importedFileReference(id: string, name: string): string {
  const safe = portableFileName(name) || 'file'
  if (new TextEncoder().encode(safe).length > 255) throw new Error('文件名太长，请缩短后重试')
  return fileReference(`files/${id}/${safe}`)
}

export function libraryFileUrl(libraryId: string, reference: string, version?: string | number): string {
  return `lib://${libraryId}/${fileReference(reference).split('/').map(encodeURIComponent).join('/')}${version ? `?v=${encodeURIComponent(version)}` : ''}`
}
