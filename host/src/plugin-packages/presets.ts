import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'
import { pluginPresetSchema, presetKeySchema, presetTitleSchema, type PluginPreset, type PluginPresetOptions } from '../shared/plugin-presets'

const userPresetSchema = pluginPresetSchema.refine(p => presetKeySchema.safeParse(p.id).success && presetKeySchema.safeParse(p.revision).success, '用户组合标识无效')
const catalogSchema = z.object({ version: z.literal(1), presets: z.array(userPresetSchema).max(100) }).strict()
  .refine(c => new Set(c.presets.map(p => p.id)).size === c.presets.length, '组合 ID 重复')

/** 单主进程即时读写；先落盘再广播，不把坏配置解释为空目录。 */
export class PluginPresetCatalog {
  constructor(private file: string) {}
  list(): PluginPreset[] {
    try {
      const bytes = readFileSync(this.file)
      if (bytes.length > 1024 * 1024) throw new Error('配置过大')
      return catalogSchema.parse(JSON.parse(bytes.toString('utf8'))).presets
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw new Error('插件组合配置无法读取，未重置或覆盖', { cause: e })
    }
  }
  get(id: string): PluginPreset {
    presetKeySchema.parse(id)
    const preset = this.list().find(p => p.id === id)
    if (!preset) throw new Error('组合已删除，请刷新列表')
    return preset
  }
  private write(presets: PluginPreset[]) {
    const data = JSON.stringify(catalogSchema.parse({ version: 1, presets }))
    if (Buffer.byteLength(data) > 1024 * 1024) throw new Error('插件组合配置过大')
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.${randomUUID()}.tmp`
    try { writeFileSync(tmp, data, { flag: 'wx', mode: 0o600 }); renameSync(tmp, this.file) }
    finally { rmSync(tmp, { force: true }) }
  }
  save(title: string, plugins: PluginPreset['plugins'], options: PluginPresetOptions = {}) {
    const presets = this.list(), value = pluginPresetSchema.parse({ id: randomUUID(), revision: randomUUID(), title, plugins, description: options.description, ...(options.layout ? { layout: options.layout } : {}) })
    this.write([...presets, value]); return value
  }
  change(id: string, revision: string, patch?: { title?: string; plugins?: PluginPreset['plugins']; description?: string; layout?: unknown }) {
    presetKeySchema.parse(id); presetKeySchema.parse(revision)
    const presets = this.list(), old = presets.find(p => p.id === id)
    if (!old || old.revision !== revision) throw new Error('组合已被修改或删除，请刷新后重试')
    const value = patch ? pluginPresetSchema.parse({ ...old, ...patch, revision: randomUUID() }) : undefined
    this.write(presets.flatMap(p => p.id !== id ? [p] : value ? [value] : []))
    return value
  }
  rename(id: string, revision: string, title: string) { return this.change(id, revision, { title: presetTitleSchema.parse(title) })! }
}

/** 不把一次重载当成可回滚的数据事务：提交前失败保留旧选择，提交后失败明确要求续接重载。 */
export async function applyPresetSelection(steps: {
  check(): Promise<void>; prepare(): Promise<void>; save(): Promise<void>; reload(): Promise<void>; resume(): void
}) {
  await steps.check()
  let saved = false
  try {
    await steps.prepare()
    await steps.check() // 页面收尾可能等待用户；其间的安装和开发来源变化不能套用旧预览。
    await steps.save(); saved = true
    await steps.reload()
  } catch (e) {
    if (!saved) { steps.resume(); throw e }
    throw new Error(`[PLUGIN_PRESET_RELOAD] 插件选择已保存，重新加载未完成；请重试重载或重新打开仓库。${String(e)}`)
  }
}
