import type Database from 'better-sqlite3'
import type { Query } from '../shared/query'
import { AUDIO_EXTS, audioPlaybackBlock } from '../plugins/audio/blocks'
import { VIDEO_EXTS, videoPlaybackBlock } from '../plugins/video/blocks'
import type { PluginDataRegistration } from './plugin-data-registration'

/** 退役兼容边界：仅用于历史查询及无法判定媒体归属的旧记录，不是可启用插件。 */
export const legacyPlaybackKind = {
  id: 'playback', plugin: 'playback', title: '旧播放记录（音视频合并查询）', version: 1,
  rebuildable: false, history: false, dormant: true, fields: audioPlaybackBlock.fields
}

export function migratePlaybackQuery(q: Query): Query {
  const audio = q.has?.includes('audio'), video = q.has?.includes('video')
  // 不能从 title、当前结果或排除条件推测业务范围；混合查询走只读兼容投影。
  if (!!audio === !!video) return q
  const target = audio ? 'audioPlayback' : 'videoPlayback'
  return { ...q, ...(q.has && { has: q.has.map(k => k === 'playback' ? target : k) }),
    ...(q.lacks && { lacks: q.lacks.map(k => k === 'playback' ? target : k) }),
    ...(q.where && { where: q.where.map(c => c.kind === 'playback' ? { ...c, kind: target } : c) }),
    ...(q.sort && q.sort !== 'created' && q.sort.kind === 'playback' && { sort: { ...q.sort, kind: target } }) }
}

/** 打开事务内执行一次：值、序号和回收站身份保留；冲突或未知媒体留作可见休眠记录。 */
export function handoffPlayback(db: Database.Database): void {
  if (db.prepare("SELECT 1 FROM main.meta WHERE key='playback_handoff_v1'").get()) return
  const definition = db.prepare("SELECT def FROM main.kind_def WHERE id='playback'").pluck().get() as string | undefined
  const rawConfig = db.prepare("SELECT value FROM main.config WHERE key='plugins'").pluck().get() as string | undefined
  const config = rawConfig ? JSON.parse(rawConfig) : undefined
  if (!definition && !config?.disabled?.includes('playback')) return
  if (definition && (JSON.parse(definition).plugin !== 'playback' || JSON.parse(definition).rebuildable)) throw Error('旧播放记录归属异常，未自动迁移')
  db.transaction(() => {
    const used = new Set<string>()
    const rows = db.prepare("SELECT b.*, f.data AS file, EXISTS(SELECT 1 FROM derived.block WHERE entity_id=b.entity_id AND kind='audio') AS audio, EXISTS(SELECT 1 FROM derived.block WHERE entity_id=b.entity_id AND kind='video') AS video FROM main.block b LEFT JOIN main.block f ON f.entity_id=b.entity_id AND f.kind='file' WHERE b.kind='playback'").all() as { entity_id: string; data: string; file: string | null; audio: number; video: number }[]
    for (const row of rows) {
      const ext = row.file ? String(JSON.parse(row.file).ext ?? '').toLowerCase() : ''
      const media = row.audio && !row.video ? 'audio' : row.video && !row.audio ? 'video' : row.audio || row.video ? undefined : AUDIO_EXTS.has(ext) ? 'audio' : VIDEO_EXTS.has(ext) ? 'video' : undefined
      if (!media) continue
      const target = media + 'Playback'
      // 即使旧记录时间较新也不默默覆盖目标；冲突两份均保留供用户明确清理。
      if (db.prepare('SELECT 1 FROM main.block WHERE entity_id=? AND kind=?').get(row.entity_id, target)) continue
      db.prepare("UPDATE main.block SET kind=? WHERE entity_id=? AND kind='playback'").run(target, row.entity_id)
      db.prepare("UPDATE main.field_index SET kind=? WHERE entity_id=? AND kind='playback'").run(target, row.entity_id)
      used.add(media)
    }
    for (const media of used) {
      const kind = media === 'audio' ? audioPlaybackBlock : videoPlaybackBlock
      const existing = db.prepare('SELECT def FROM main.kind_def WHERE id=?').pluck().get(kind.id) as string | undefined
      if (existing && JSON.parse(existing).plugin !== media) throw Error('播放记录目标类型已被其他插件占用')
      db.prepare('INSERT OR IGNORE INTO main.kind_def(id,def) VALUES (?,?)').run(kind.id, JSON.stringify(kind))
      const key = 'pluginData:' + media
      const registration: PluginDataRegistration = { title: media === 'audio' ? '音频' : '视频', protected: false, lifecycle: { version: 1, disposableRecords: [], retainedEffects: [] }, systems: [] }
      db.prepare('INSERT OR IGNORE INTO main.config(key,value) VALUES (?,?)').run(key, JSON.stringify(registration))
    }
    const remaining = Number(db.prepare("SELECT count(*) FROM main.block WHERE kind='playback'").pluck().get())
    // 未接续记录可能仍满足原查询；整个库保留旧查询投影，不能因改名悄悄漏项。
    for (const row of (remaining ? [] : db.prepare("SELECT entity_id,data FROM main.block WHERE kind='view'").all()) as { entity_id: string; data: string }[]) {
      const data = JSON.parse(row.data)
      if (!data.query || typeof data.query !== 'object' || Array.isArray(data.query)) continue
      const next = migratePlaybackQuery(data.query)
      if (JSON.stringify(next) !== JSON.stringify(data.query)) db.prepare("UPDATE main.block SET data=? WHERE entity_id=? AND kind='view'").run(JSON.stringify({ ...data, query: next }), row.entity_id)
    }
    if (config?.disabled?.includes('playback')) {
      // 旧依赖曾令两类媒体一并停用，不能借退役依赖擅自启动加工。
      config.disabled = [...new Set([...config.disabled.filter((id: string) => id !== 'playback'), 'audio', 'video'])]
      db.prepare("UPDATE main.config SET value=? WHERE key='plugins'").run(JSON.stringify(config))
    }
    // 保留旧定义使历史保存视图、撤销后的视图和工作区筛选仍有友好字段名称。
    if (definition) db.prepare("UPDATE main.kind_def SET def=? WHERE id='playback'").run(JSON.stringify(legacyPlaybackKind))
    if (remaining) {
      const record: PluginDataRegistration = { title: '旧播放记录（未能自动归属）', protected: false, lifecycle: { version: 1, disposableRecords: [], retainedEffects: ['此处只清理无法归属或冲突的旧记录；音频和视频各自管理已接续的播放记录。'] }, systems: [] }
      db.prepare("INSERT INTO main.config(key,value) VALUES ('pluginData:playback',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(record))
    } else db.prepare("DELETE FROM main.config WHERE key='pluginData:playback'").run()
    db.prepare("INSERT INTO main.meta(key,value) VALUES ('playback_handoff_v1','1')").run()
  })()
}

/** 历史混合查询的只读投影。相同素材多份记录按最近播放选择，避免排序产生重复行。 */
export const playbackQueryCte = `WITH legacy_playback_rows AS (
  SELECT *, ROW_NUMBER() OVER (PARTITION BY entity_id ORDER BY COALESCE(json_extract(data,'$.lastPlayed'),0) DESC, kind ASC) AS rank
  FROM main.block WHERE kind IN ('playback','audioPlayback','videoPlayback')
), legacy_playback_block AS (
  SELECT entity_id, 'playback' AS kind FROM legacy_playback_rows WHERE rank=1
), legacy_playback_index AS (
  SELECT f.entity_id, 'playback' AS kind, f.field, f.num, f.txt FROM main.field_index f
  JOIN legacy_playback_rows p ON p.entity_id=f.entity_id AND p.kind=f.kind AND p.rank=1
)`
