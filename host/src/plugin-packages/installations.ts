import { randomUUID } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import { decodeSuite, isSuite, MAX_SUITE_BYTES, type SuiteArchive, type SuiteCatalog } from './suites'
import { suitePresetId } from '../shared/plugin-suites'
import { z } from 'zod'
import { decodePackage, MAX_PACKAGE_BYTES } from './archive'
import type { PackageManager } from './manager'
import type { PackagePreview, PackageInstallItem } from '../shared/external-plugins'

const MAX_FILES = 50, MAX_RETAINED_BYTES = 128 * 1024 * 1024
const message = (error: unknown) => error instanceof Error ? error.message : String(error)
interface Pending { preview: PackagePreview; bytes: Map<number, Buffer>; suites: SuiteArchive[]; previous: Map<string, string | undefined>; choices: Map<number, string | null> }

/** 本机安装预览；按窗口隔离，保留已核对的字节，不在确认后重新读取来源文件。 */
export class PackageInstallations {
  private pending = new Map<number, Pending>()
  constructor(private packages: () => PackageManager, private catalog?: () => SuiteCatalog) {}

  clear(owner: number, token?: unknown): void {
    if (token === undefined || this.pending.get(owner)?.preview.token === token) this.pending.delete(owner)
  }

  preview(owner: number, paths: string[], suiteId?: string): PackagePreview | null {
    this.clear(owner)
    if (!paths.length) return null
    if (paths.length > MAX_FILES) throw new Error(`一次最多选择 ${MAX_FILES} 个插件包，请分批添加`)
    const manager = this.packages(), installed = new Set(manager.list().map(p => p.hash))
    const items: PackageInstallItem[] = [], bytes = new Map<number, Buffer>(), seen = new Set<string>()
    const previous = new Map<string, string | undefined>()
    const suites: SuiteArchive[] = [], suiteResults: NonNullable<PackagePreview['suites']> = []
    const inputs: { file: string; bytes?: Buffer; error?: string; suite?: boolean }[] = []
    let totalInput = 0, conflictingSuites = false
    for (const path of paths) {
      try {
        const stat = statSync(path)
        if (!stat.isFile() || stat.size > MAX_SUITE_BYTES || totalInput + stat.size > MAX_SUITE_BYTES) throw new Error('本批输入超过 128 MB 或不是文件')
        totalInput += stat.size
        const data = readFileSync(path)
        if (suiteId && !isSuite(data)) throw new Error('更新套件请选择 .hysuite 或 .rmsuite 文件')
        if (!isSuite(data)) inputs.push({ file: basename(path), bytes: data })
        else {
          if (!this.catalog) throw new Error('此入口不支持套件')
          const suite = decodeSuite(data)
          if (suiteId && suite.manifest.id !== suiteId) throw new Error('请选择同一个套件的新版本')
          const existing = this.catalog().inspect(suite), old = this.catalog().list().find(s => s.manifest.id === suite.manifest.id)
          if (suiteId && (!old || old.manifest.version === suite.manifest.version)) throw new Error('更新套件需要更高版本')
          previous.set(suite.manifest.id, old?.hash)
          if (suites.some(s => s.manifest.id === suite.manifest.id)) { conflictingSuites = true; throw new Error('同批同一套件只能选择一个文件') }
          suites.push(suite)
          suiteResults.push({ id: suite.manifest.id, title: suite.manifest.title, version: suite.manifest.version, status: existing ? 'existing' : 'ready', previousVersion: old?.manifest.version, changes: old ? suiteChanges(old.manifest, suite.manifest) : undefined, presets: suite.manifest.presets.map(p => ({ id: suitePresetId(suite.manifest.id, p.id), title: p.title })) })
          for (const [file, bytes] of suite.packages) inputs.push({ file: `${basename(path)} / ${file}`, bytes, suite: true })
        }
      } catch (error) { inputs.push({ file: basename(path), error: message(error) }) }
    }
    if (conflictingSuites) throw new Error('同批同一套件只能选择一个文件，请重新选择')
    if (inputs.length > MAX_FILES) throw new Error('本批展开后超过 50 个插件包，请分批安装')
    let retained = 0
    for (const [index, input] of inputs.entries()) {
      const row: PackageInstallItem = { index, file: input.file, status: 'invalid' }
      items.push(row)
      try {
        if (!input.bytes) throw new Error(input.error)
        if (input.bytes.length > MAX_PACKAGE_BYTES) throw new Error('插件包超过 16 MB')
        const data = input.bytes, pack = decodePackage(data)
        Object.assign(row, { manifest: pack.manifest, hash: pack.hash, bytes: pack.bytes, files: pack.files.size })
        if (input.suite) {
          row.alternatives = manager.list().filter(p => p.manifest.id === pack.manifest.id).map(p => ({ hash: p.hash, version: p.manifest.version }))
          if (!installed.has(pack.hash) && row.alternatives.length === 1) row.reuseHash = row.alternatives[0].hash
          if (!installed.has(pack.hash)) {
            if (retained + data.length > MAX_RETAINED_BYTES) throw new Error('本批待安装内容超过 128 MB')
            retained += data.length; bytes.set(index, data)
          }
        }
        // 归档完整性始终检查；仅选择安装附带包时才触发同版冲突检查。
        if (!row.reuseHash) manager.inspect(data)
        if (seen.has(pack.hash)) row.status = 'duplicate'
        else if (installed.has(pack.hash)) row.status = 'existing'
        else {
          if (!bytes.has(index) && retained + data.length > MAX_RETAINED_BYTES) throw new Error('本批待安装内容超过 128 MB，请将此包分批添加')
          if (!bytes.has(index)) { retained += data.length; bytes.set(index, data) }
          row.status = 'ready'
        }
        seen.add(pack.hash)
      } catch (error) { row.error = message(error) }
    }
    // 同批同 ID/版本的不同内容不能按文件顺序擅自选一个；两者都留给用户重新选择。
    const versions = new Map<string, Set<string>>()
    for (const row of items) if (row.manifest && row.hash) {
      const key = `${row.manifest.id}@${row.manifest.version}`
      const hashes = versions.get(key) ?? new Set<string>()
      hashes.add(row.hash); versions.set(key, hashes)
    }
    for (const row of items) if (row.manifest && versions.get(`${row.manifest.id}@${row.manifest.version}`)!.size > 1) {
      row.status = 'invalid'; row.error = '本批含有相同 ID 和版本的不同内容，请只保留其中一个包后重新选择'
      bytes.delete(row.index)
    }
    const preview: PackagePreview = { token: randomUUID(), items, ...(suites.length ? { suites: suiteResults } : {}) }
    this.pending.set(owner, { preview, bytes, suites, previous, choices: new Map() })
    return structuredClone(preview)
  }

  install(owner: number, token: unknown, rawChoices?: unknown): PackagePreview {
    const batch = this.pending.get(owner)
    if (!batch || typeof token !== 'string' || batch.preview.token !== token) throw new Error('安装预览已失效，请重新选择文件')
    const manager = this.packages(), installed = new Set(manager.list().map(p => p.hash))
    const choices = z.array(z.object({ index: z.number().int().nonnegative(), hash: z.string().regex(/^[a-f0-9]{64}$/).nullable() }).strict()).max(MAX_FILES).parse(rawChoices ?? [])
    if (new Set(choices.map(c => c.index)).size !== choices.length) throw new Error('安装选择重复')
    for (const c of choices) {
      const row = batch.preview.items.find(r => r.index === c.index)
      if (!row?.alternatives || (c.hash && c.hash !== row.hash && !row.alternatives.some(a => a.hash === c.hash))) throw new Error('安装选择不在预览范围')
    }
    for (const suite of batch.suites) {
      const now = this.catalog!().list().find(s => s.manifest.id === suite.manifest.id)?.hash
      if (now !== batch.previous.get(suite.manifest.id) && now !== suite.hash) throw new Error('套件登记已变化，请重新预览')
    }
    for (const c of choices) batch.choices.set(c.index, c.hash)
    for (const row of batch.preview.items) {
      if (row.status !== 'ready' && row.status !== 'failed' && !(row.alternatives && ['invalid','reused','skipped'].includes(row.status))) continue
      try {
        const chosen = batch.choices.has(row.index) ? batch.choices.get(row.index) : row.reuseHash ?? row.hash
        if (chosen === null) { row.status = 'skipped'; delete row.error; continue }
        if (chosen !== row.hash) {
          const ref = manager.find(chosen!)
          if (ref.manifest.id !== row.manifest?.id) throw new Error('插件身份不符')
          manager.verify(chosen!); row.reuseHash = chosen!; row.status = 'reused'; delete row.error; continue
        }
        delete row.reuseHash

        if (installed.has(row.hash!)) row.status = 'existing'
        else {
          const ref = manager.install(batch.bytes.get(row.index)!)
          installed.add(ref.hash); row.status = 'installed'
        }
        delete row.error
        batch.bytes.delete(row.index)
      } catch (error) { row.status = 'failed'; row.error = message(error) }
    }
    for (const suite of batch.suites) {
      const row = batch.preview.suites!.find(s => s.id === suite.manifest.id)!
      try {
        this.catalog!().install(suite)
        row.missing = suiteMissingPlugins(suite.manifest, manager)
        row.status = row.missing.length ? 'incomplete' : 'installed'; delete row.error
      } catch (e) { row.status = 'failed'; row.error = message(e) }
    }
    return structuredClone(batch.preview)
  }
}

function suiteChanges(old: SuiteArchive['manifest'], next: SuiteArchive['manifest']): string[] {
  const changes: string[] = []
  for (const p of next.presets) {
    const before = old.presets.find(v => v.id === p.id)
    if (!before) { changes.push(`新增方案：${p.title}`); continue }
    for (const r of p.plugins) {
      const prior = before.plugins.find(v => v.id === r.id)
      if (!prior) changes.push(`${p.title}：新增 ${r.title}`)
      else if (prior.hash !== r.hash || prior.version !== r.version) changes.push(`${p.title}：${r.title} 推荐 ${prior.version ?? '未指定'} → ${r.version ?? '未指定'}`)
    }
    for (const r of before.plugins) if (!p.plugins.some(v => v.id === r.id)) changes.push(`${p.title}：不再要求 ${r.title}（不卸载）`)
    if (JSON.stringify(before.layout) !== JSON.stringify(p.layout)) changes.push(`${p.title}：工作台安排变化`)
  }
  for (const p of old.presets) if (!next.presets.some(v => v.id === p.id)) changes.push(`移除原版方案：${p.title}（保留用户副本与当前工作台）`)
  return changes.length ? changes : ['方案说明或套件发布信息更新']
}

/** 准备状态按能力 ID 计算；推荐包缺失不等于插件缺失。运行兼容性仍由方案预演检查。 */
export function suiteMissingPlugins(manifest: SuiteArchive['manifest'], manager: PackageManager): string[] {
  const installed = new Set(manager.list().map(p => p.manifest.id))
  return [...new Set(manifest.presets.flatMap(p => p.plugins.map(r => r.id)))].filter(id => !manager.isReserved(id) && !installed.has(id))
}
