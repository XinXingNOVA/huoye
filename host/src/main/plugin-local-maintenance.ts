import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { localCleanupSchema, localPluginSchema, type LocalCleanupRequest, type LocalDataInfo, type LocalDataPreview, type LocalDataResult, type LocalCategory } from '../shared/plugin-local'
import { PluginLocalFiles, localNamespace, writeLocalJson } from './plugin-local-files'
import type { LocalScope } from '../plugin-api/local-service'

type Entry = { category: LocalCategory; before: string | null; after?: string; imports?: string[] }
type Receipt = { request: LocalCleanupRequest; namespace: string; entries: Entry[]; result: LocalDataResult }
const categories: LocalCategory[] = ['settings', 'secrets', 'state']
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const errorText = (e: unknown) => e instanceof Error ? e.message : String(e)
/** 单个作用域的显式维护，不解密凭据；回执只保存摘要、迁移标记和结果。 */
export class PluginLocalMaintenance {
  constructor(private files: PluginLocalFiles, private receipts: string, private blocked: (plugin: string, scope: LocalScope, root?: string) => string[]) {}
  private receiptFile(plugin: string, namespace: string) { localPluginSchema.parse(plugin); return join(this.receipts, hash([plugin, namespace]) + '.json') }
  private receipt(plugin: string, namespace: string): Receipt | undefined {
    const file = this.receiptFile(plugin, namespace)
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined
  }
  private save(receipt: Receipt) {
    mkdirSync(this.receipts, { recursive: true, mode: 0o700 })
    writeLocalJson(this.receiptFile(receipt.request.pluginId, receipt.namespace), receipt)
  }
  list(scope: LocalScope, root?: string): LocalDataInfo[] {
    const namespace = localNamespace(scope, root)
    const ids = new Set<string>()
    if (existsSync(this.files.directory)) for (const item of readdirSync(this.files.directory, { withFileTypes: true })) if (item.isDirectory() && localPluginSchema.safeParse(item.name).success) ids.add(item.name)
    if (existsSync(this.receipts)) for (const name of readdirSync(this.receipts)) if (/^[a-f0-9]{64}\.json$/.test(name)) {
      const receipt = JSON.parse(readFileSync(join(this.receipts, name), 'utf8')) as Receipt
      if (receipt.namespace === namespace) ids.add(receipt.request.pluginId)
    }
    return [...ids].sort().map(pluginId => {
      const files = categories.map(category => this.inspect(pluginId, namespace, category))
      const pending = this.receipt(pluginId, namespace)?.result.items.some(i => i.status === 'pending') ?? false
      return { pluginId, files, pending }
    }).filter(item => item.pending || item.files.some(f => f.keys.length || f.error))
  }
  private inspect(plugin: string, namespace: string, category: LocalCategory) {
    try {
      const file = this.files.file(plugin, namespace, category), doc = this.files.read(file)
      return { category, keys: Object.keys(doc.values).sort(), bytes: existsSync(file) ? lstatSync(file).size : 0 }
    } catch (e) { return { category, keys: [], bytes: 0, error: errorText(e) } }
  }
  private plan(raw: LocalCleanupRequest, root?: string) {
    const request = localCleanupSchema.parse(raw), namespace = localNamespace(request.scope, root)
    const files = request.categories.map(c => this.inspect(request.pluginId, namespace, c))
    const blocked = this.blocked(request.pluginId, request.scope, root)
    if (files.some(f => f.error)) blocked.push('本机记录无法安全读取，请先处理文件问题')
    if (this.receipt(request.pluginId, namespace)?.result.items.some(i => i.status === 'pending')) blocked.push('上次清理尚未完成，请先重试')
    const entries: Entry[] = files.map(info => {
      if (info.error) return { category: info.category, before: null }
      const file = this.files.file(request.pluginId, namespace, info.category)
      const before = this.files.signature(file)
      if (info.category !== 'state') return { category: info.category, before }
      const imports = this.files.read(file).imports
      return { category: info.category, before, imports, after: hash({ version: 1, values: {}, ...(imports ? { imports } : {}) }) }
    })
    const token = hash({ request, namespace, entries })
    return { preview: { ...request, token, files, blocked } satisfies LocalDataPreview, entries, namespace }
  }
  preview(raw: LocalCleanupRequest, root?: string) { return this.plan(raw, root).preview }
  clean(raw: LocalCleanupRequest & { token: string }, root?: string): LocalDataResult {
    const { token, ...input } = raw
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) throw new Error('清理凭据无效')
    const request = localCleanupSchema.parse(input), namespace = localNamespace(request.scope, root)
    const previous = this.receipt(request.pluginId, namespace)
    if (previous?.result.token === token) return this.retry(request.pluginId, request.scope, root)
    const plan = this.plan(request, root)
    if (plan.preview.blocked.length) throw new Error('[LOCAL_DATA_BLOCKED] ' + plan.preview.blocked.join('；'))
    if (plan.preview.token !== token) throw new Error('[LOCAL_DATA_CHANGED] 设置已变化，请重新预览')
    this.save({ request, namespace, entries: plan.entries, result: { pluginId: request.pluginId, scope: request.scope, token, items: request.categories.map(category => ({ category, status: 'pending' })) } })
    return this.retry(request.pluginId, request.scope, root)
  }
  retry(plugin: string, scope: LocalScope, root?: string): LocalDataResult {
    const namespace = localNamespace(scope, root), receipt = this.receipt(plugin, namespace)
    if (!receipt) throw new Error('[NOT_FOUND] 没有本机清理记录')
    if (!receipt.result.items.some(i => i.status === 'pending')) return receipt.result
    const blocked = this.blocked(plugin, scope, root)
    if (blocked.length) throw new Error('[LOCAL_DATA_BLOCKED] ' + blocked.join('；'))
    for (const item of receipt.result.items) {
      if (item.status !== 'pending') continue
      try {
        const entry = receipt.entries.find(e => e.category === item.category)!, file = this.files.file(plugin, namespace, item.category)
        const now = this.files.signature(file)
        if (now === null || (entry.category === 'state' && hash(this.files.read(file)) === entry.after)) item.status = 'done'
        else if (now !== entry.before) { item.status = 'retained'; item.error = '文件在预览后发生变化，已保留，请重新预览' }
        else {
          if (entry.category === 'state') this.files.write(file, { version: 1, values: {}, ...(entry.imports ? { imports: entry.imports } : {}) })
          else rmSync(file)
          item.status = 'done'
        }
        if (item.status === 'done') delete item.error
      } catch (e) { item.error = errorText(e) }
      // 每个文件独立反馈。保存失败向上抛出，下次凭文件摘要核对，绝不重复删除新值。
      this.save(receipt)
    }
    return receipt.result
  }
}
