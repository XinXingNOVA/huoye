import { fileReference } from '../shared/file-location'
import { portableFileName } from '../shared/paths'
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const versionPattern = new RegExp(`^spaces/v2/(${uuid})/(${uuid})/(${uuid})/([^/]+)$`)
const pattern = new RegExp(`^spaces/v1/(${uuid})/(${uuid})/([^/]+)$`)
export function parseSpaceReference(ref: string): { spaceId: string; fileId: string; name: string; contentVersion?: string } | undefined {
  const value = fileReference(ref)
  if (!value.startsWith('spaces/')) return undefined
  const version = versionPattern.exec(value)
  if (version) return { spaceId: version[1], fileId: version[2], contentVersion: version[3], name: version[4] }
  const match = pattern.exec(value)
  if (!match) throw new Error('[INVALID_FILE_REFERENCE] 文件空间引用格式无效')
  return { spaceId: match[1], fileId: match[2], name: match[3] }
}
export function spaceReference(spaceId: string, fileId: string, name: string, contentVersion: string): string {
  const ref = `spaces/v2/${spaceId}/${fileId}/${contentVersion}/${portableFileName(name) || 'file'}`
  parseSpaceReference(ref); return ref
}
