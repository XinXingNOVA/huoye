import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { localPluginSchema, localScopeSchema, type LocalCategory } from '../shared/plugin-local'
import type { LocalScope, LocalValue } from '../plugin-api/local-service'
export const localLimit = 256 * 1024
export const validLocalKey = (key: unknown): key is string => localPluginSchema.safeParse(key).success
export interface LocalDocument { version: 1; values: Record<string, LocalValue>; imports?: string[] }
export const localNamespace = (scope: LocalScope, root?: string) => {
  localScopeSchema.parse(scope)
  if (scope === 'application') return 'application'
  if (!root) throw new Error('请在仓库窗口管理本库设置')
  return createHash('sha256').update(root).digest('hex')
}
export function writeLocalJson(file: string, value: unknown) {
  const temporary = `${file}.${randomUUID()}.tmp`
  try { writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' }); renameSync(temporary, file) }
  finally { rmSync(temporary, { force: true }) }
}
/** 沿用服务已有文件格式；界面状态独立存放，迁移标记不含状态值。 */
export class PluginLocalFiles {
  constructor(readonly directory: string) {}
  file(plugin: string, namespace: string, category: LocalCategory): string {
    localPluginSchema.parse(plugin)
    if (namespace !== 'application' && !/^[a-f0-9]{64}$/.test(namespace)) throw new Error('本机作用域无效')
    const dir = join(this.directory, plugin)
    for (const p of [this.directory, dir]) if (existsSync(p) && (lstatSync(p).isSymbolicLink() || !lstatSync(p).isDirectory())) throw new Error('本机存储目录不可安全读取')
    const file = join(dir, namespace + (category === 'settings' ? '' : '.' + category) + '.json')
    if (existsSync(file) && (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink() || realpathSync(file) !== join(realpathSync(dir), file.slice(dir.length + 1)))) throw new Error('本机记录不是普通文件')
    return file
  }
  signature(file: string): string | null {
    if (!existsSync(file)) return null
    const stat = lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > localLimit) throw new Error('本机记录不安全或超过大小限制')
    return createHash('sha256').update(readFileSync(file)).update(`${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`).digest('hex')
  }
  read(file: string): LocalDocument {
    if (!existsSync(file)) return { version: 1, values: Object.create(null) }
    if (lstatSync(file).size > localLimit) throw new Error('[LOCAL_CONFIG_INVALID] 配置超过大小限制')
    try {
      const doc = JSON.parse(readFileSync(file, 'utf8')) as LocalDocument
      if (doc?.version !== 1 || !doc.values || Array.isArray(doc.values) || typeof doc.values !== 'object' || Object.keys(doc.values).some(k => !validLocalKey(k)) ||
        (doc.imports !== undefined && (!Array.isArray(doc.imports) || doc.imports.length > 100 || doc.imports.some(k => !validLocalKey(k))))) throw Error()
      return { ...doc, values: Object.assign(Object.create(null), doc.values) }
    } catch { throw new Error('[LOCAL_CONFIG_INVALID] 配置损坏，未重置或覆盖') }
  }
  write(file: string, doc: LocalDocument) {
    if (Buffer.byteLength(JSON.stringify(doc)) > localLimit || Object.keys(doc.values).length > 100 || (doc.imports?.length ?? 0) > 100) throw new Error('配置过大；请将业务内容存入仓库')
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 })
    writeLocalJson(file, doc)
  }
  state(plugin: string, scope: LocalScope, root: string | undefined, action: string, key: string, value?: LocalValue): LocalValue | undefined {
    if (!validLocalKey(key)) throw new Error('配置键无效')
    const file = this.file(plugin, localNamespace(scope, root), 'state'), doc = this.read(file)
    if (action === 'get') return doc.values[key]
    if (action === 'set') { assertLocalValue(value); doc.values[key] = value }
    else if (action === 'remove') delete doc.values[key]
    else if (action === 'importOnce') {
      assertLocalValue(value)
      if ((doc.imports ?? []).includes(key)) return doc.values[key]
      if (!(key in doc.values)) doc.values[key] = value
      doc.imports = [...(doc.imports ?? []), key]
    } else throw new Error('无效状态操作')
    this.write(file, doc)
    return doc.values[key]
  }
}
export function assertLocalValue(value: unknown, depth = 0): asserts value is LocalValue {
  if (depth > 30) throw new Error('JSON 层级过深')
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return
  if (Array.isArray(value)) { for (const item of value) assertLocalValue(item, depth + 1); return }
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) { for (const item of Object.values(value)) assertLocalValue(item, depth + 1); return }
  throw new Error('只能存取 JSON 数据')
}
