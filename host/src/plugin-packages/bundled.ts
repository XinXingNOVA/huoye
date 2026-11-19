import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { decodePackage } from './archive'

/** 只读取当前应用附带的目录；用户选择的安装包不能自行声明自动交接。 */
export function readBundledPackages(directory: string): Buffer[] {
  const catalog: unknown = JSON.parse(readFileSync(join(directory, 'catalog.json'), 'utf8'))
  if (!Array.isArray(catalog)) throw new Error('随应用插件目录无效')
  const ids = new Set<string>()
  return catalog.map(entry => {
    if (!entry || typeof entry.file !== 'string' || !/^[a-z][a-z0-9-]*\.(hyplugin|rmplugin)$/.test(entry.file)) throw new Error('随应用插件路径无效')
    const bytes = readFileSync(join(directory, entry.file)), pack = decodePackage(bytes)
    if (pack.hash !== entry.hash || ids.has(pack.manifest.id)) throw new Error('随应用插件摘要或 ID 无效')
    ids.add(pack.manifest.id)
    return bytes
  })
}
