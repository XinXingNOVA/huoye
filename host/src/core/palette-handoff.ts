import type Database from 'better-sqlite3'
import type { PluginDataRegistration } from './plugin-data-registration'

/** 2026-11 色板拆包的一次归属交接；必须早于外部包结构校验。没有旧痕迹的库不写记录。 */
export function handoffPalette(db: Database.Database): void {
  const raw = db.prepare("SELECT def FROM main.kind_def WHERE id='palette'").pluck().get() as string | undefined
  const old = raw && JSON.parse(raw)
  const registration = db.prepare("SELECT value FROM main.config WHERE key='pluginData:preview'").pluck().get() as string | undefined
  const preview = registration ? JSON.parse(registration) as PluginDataRegistration : undefined
  const jobs = preview?.systems.filter(s => s.id === 'preview.palette') ?? []
  if (old?.plugin !== 'preview' && !jobs.length) return
  if (old && (old.plugin !== 'preview' || old.rebuildable !== true)) throw new Error('旧色板归属异常，未进行自动交接')
  db.transaction(() => {
    if (old) db.prepare("UPDATE main.kind_def SET def=? WHERE id='palette'").run(JSON.stringify({ ...old, plugin: 'palette' }))
    // 输出块原样保留；旧任务签名退役，新包首次启用会按 thumb 重算。
    db.prepare("DELETE FROM derived.derivation WHERE system='preview.palette'").run()
    if (preview) db.prepare("UPDATE main.config SET value=? WHERE key='pluginData:preview'").run(JSON.stringify({ ...preview, systems: preview.systems.filter(s => s.id !== 'preview.palette') }))
    const existing = db.prepare("SELECT value FROM main.config WHERE key='pluginData:palette'").pluck().get() as string | undefined
    const record: PluginDataRegistration = existing ? JSON.parse(existing) : { title: '色彩与色板', protected: false, lifecycle: { version: 1, disposableRecords: [], retainedEffects: [] }, systems: [] }
    if (!record.systems.some(s => s.id === 'palette.extract')) record.systems.push({ id: 'palette.extract', outputs: ['palette'] })
    db.prepare("INSERT INTO main.config(key,value) VALUES ('pluginData:palette',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(record))
  })()
}
