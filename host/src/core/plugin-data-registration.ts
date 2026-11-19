import type Database from 'better-sqlite3'
import type { CorePlugin } from './plugin'
import type { PluginInfo } from '../shared/plugin-plan'
import { dataLifecycleSchema } from '../shared/plugin-data'

export interface PluginDataRegistration {
  title: string
  protected: boolean
  lifecycle?: ReturnType<typeof dataLifecycleSchema.parse>
  systems: { id: string; outputs: string[] }[]
}
export const registrationKey = (id: string) => `pluginData:${id}`

export function validateDataLifecycle(plugin: CorePlugin): void {
  if (!plugin.dataLifecycle) return
  const declaration = dataLifecycleSchema.parse(plugin.dataLifecycle)
  if (new Set(declaration.disposableRecords).size !== declaration.disposableRecords.length) throw new Error('生命周期记录类型不能重复')
  for (const id of declaration.disposableRecords) {
    const kind = plugin.blocks?.find(k => k.id === id)
    if (!kind || kind.plugin !== plugin.id || kind.rebuildable || !(kind.content || kind.standalone || kind.management))
      throw new Error(`生命周期记录 ${id} 必须是本插件拥有的持久内容或独立记录类型`)
    if (Object.values(kind.fields).some(f => f.file)) throw new Error(`含原件引用的记录 ${id} 不能声明随插件销毁`)
  }
}

/** 与定义快照在同一初始化事务登记。只记录成功装配者，加载失败不能覆盖旧责任记录。 */
export function registerPluginData(db: Database.Database, plugins: CorePlugin[], manifest: PluginInfo[]): void {
  const read = db.prepare('SELECT value FROM main.config WHERE key=?')
  const write = db.prepare('INSERT INTO main.config(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
  for (const plugin of plugins) {
    validateDataLifecycle(plugin)
    const oldJson = read.pluck().get(registrationKey(plugin.id)) as string | undefined
    const old = oldJson ? JSON.parse(oldJson) as PluginDataRegistration : undefined
    const current = plugin.dataLifecycle && dataLifecycleSchema.parse(plugin.dataLifecycle)
    // 老版本产生的记录及共享影响不能因为新版本删掉声明就失去归属；执行时仍核验当前定义归属。
    const lifecycle = current || old?.lifecycle ? {
      version: 1 as const,
      disposableRecords: [...new Set([...(old?.lifecycle?.disposableRecords ?? []), ...(current?.disposableRecords ?? [])])],
      retainedEffects: [...new Set([...(old?.lifecycle?.retainedEffects ?? []), ...(current?.retainedEffects ?? [])])]
    } : undefined
    const info = manifest.find(p => p.id === plugin.id)
    const systems = new Map((old?.systems ?? []).map(s => [s.id, s]))
    for (const system of plugin.systems ?? []) systems.set(system.id, { id: system.id, outputs: [...new Set([...(systems.get(system.id)?.outputs ?? []), ...system.outputs])] })
    const record: PluginDataRegistration = { title: info?.title ?? old?.title ?? plugin.id, protected: !!info?.required || !!old?.protected, lifecycle, systems: [...systems.values()] }
    write.run(registrationKey(plugin.id), JSON.stringify(record))
  }
}
