import { parseSpaceReference } from './space-reference'
import { parseDirectoryReference } from './directory-reference'

export function sourceFile(value: unknown) {
  if (typeof value !== 'string' || !/^(?:spaces|directories)[/\\]/.test(value)) return
  try { return parseSpaceReference(value) ?? parseDirectoryReference(value) }
  catch { return undefined } // 普通文字和失效格式不能作为文件身份。
}
