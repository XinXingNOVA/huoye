import { it, expect } from 'vitest'
import { Host } from '../../src/core/host'
import { corePlugins } from '../../src/plugins/core'
import { PLUGINS } from '../../src/plugins/manifest'
import { tempDir } from '../helpers/helpers'
import { rmSync } from 'node:fs'
import { handoffPlayback, migratePlaybackQuery } from '../../src/core/playback-handoff'
import type { BlockKind } from '../../src/shared/blocks'
import type { Query } from '../../src/shared/query'

const oldKind: BlockKind = { id: 'playback', plugin: 'playback', title: '播放进度', version: 1, rebuildable: false, history: false,
  fields: { position: { type: 'number', title: '上次位置' }, finished: { type: 'boolean', title: '已播完', index: true }, plays: { type: 'number', title: '播放次数', index: true }, lastPlayed: { type: 'date', title: '最后播放', index: true } } }
const open = (root: string, old = false) => new Host(root, [...corePlugins, ...(old ? [{ id: 'playback', version: 1, blocks: [oldKind] }] : [])], () => {},
  { manifest: [...PLUGINS, ...(old ? [{ id: 'playback', title: '播放记录', description: '' }] : [])] })

it('旧库分配归属、保留未知和回收站记录，保存视图接续，清理互不影响', async () => {
  const root = tempDir(); let h = open(root, true)
  try {
    const make = (ext: string, lastPlayed: number) => {
      const id = h.store.createEntity()
      h.store.put(id, 'file', { name: 'sample.' + ext, ext, path: 'missing', hash: ext })
      h.store.put(id, 'playback', { position: 12, finished: false, plays: 3, lastPlayed })
      return id
    }
    const audio = make('mp3', 20), video = make('mp4', 30), unknown = make('bin', 10), trashed = make('wav', 15)
    h.store.put(audio, 'audio', { duration: 120 }); h.store.put(video, 'video', { duration: 120 })
    h.lib.db.prepare('UPDATE entity SET deleted_at=123 WHERE id=?').run(trashed)
    const seq = h.store.blocksOf(audio).playback.seq
    const mixed: Query = { has: ['playback'], where: [{ op: 'eq', kind: 'playback', field: 'finished', value: false }], sort: { kind: 'playback', field: 'lastPlayed' } }
    const save = (query: Query) => { const id = h.store.createEntity(); h.store.put(id, 'view', { title: '未完成', query }); return id }
    const mixedView = save(mixed), audioView = save({ ...mixed, has: ['audio', 'playback'] })
    h.close(); h = open(root)
    expect(h.store.blocksOf(audio).audioPlayback).toMatchObject({ seq, data: { position: 12, plays: 3 } })
    expect(h.store.blocksOf(video).videoPlayback.data.plays).toBe(3)
    expect(h.store.blocksOf(trashed).audioPlayback.data.position).toBe(12)
    expect(h.store.blocksOf(unknown).playback.data.position).toBe(12)
    expect(h.reg.kind('playback')?.dormant).toBe(true)
    expect(h.store.blocksOf(audioView).view.data.query).toMatchObject({ has: ['audio', 'playback'] })
    expect(migratePlaybackQuery({ ...mixed, has: ['audio', 'playback'] })).toMatchObject({ has: ['audio', 'audioPlayback'], where: [{ kind: 'audioPlayback' }], sort: { kind: 'audioPlayback' } })
    expect(h.store.blocksOf(mixedView).view.data.query).toEqual(mixed)
    expect((await h.api.query(mixed)).ids).toEqual([video, audio, unknown])
    expect((await h.api.searchPage({ query: mixed })).items.map(v => v.id)).toEqual([video, audio, unknown])
    expect((await h.api.query({ scope: 'trash', has: ['playback'] })).ids).toEqual([trashed])
    await h.api.run('audio', 'recordPlayback', { id: audio, hash: 'mp3', session: 'new', sessionStarted: 100, lastPlayed: 110, position: 0, finished: true })
    expect((await h.api.query(mixed)).ids).toEqual([video, unknown])
    expect((await h.api.query({ has: ['playback'], where: [{ op: 'range', kind: 'playback', field: 'plays', min: 4 }] })).ids).toEqual([audio])
    expect((await h.api.query({ has: ['file'], lacks: ['playback'] })).ids).toEqual([])
    expect((await h.api.query({ has: ['file'], where: [{ op: 'empty', kind: 'playback', field: 'lastPlayed' }] })).ids).toEqual([])
    handoffPlayback(h.lib.db)
    expect(h.store.blocksOf(audio).audioPlayback.data.plays).toBe(4)
    await h.api.setPlugins(['audio']); h.close(); h = open(root)
    const p = await h.api.previewPluginDataCleanup({ pluginId: 'audio', mode: 'all' })
    expect(p.blocked).toEqual([])
    await h.api.cleanupPluginData({ pluginId: 'audio', mode: 'all', token: p.token })
    expect(h.store.blocksOf(audio).audioPlayback).toBeUndefined()
    expect(h.store.blocksOf(audio).file).toBeDefined()
    expect(h.store.blocksOf(video).videoPlayback.data.plays).toBe(3)
    h.close(); h = open(root)
    expect(h.store.blocksOf(audio).audioPlayback).toBeUndefined()
  } finally { h.close(); rmSync(root, { recursive: true, force: true }) }
})

it('播放命令拒绝旧文件、旧会话、回收站和倒序写入；同一会话只计一次且不进入撤销历史', async () => {
  const root = tempDir(), h = open(root)
  try {
    const id = h.store.createEntity(); h.store.put(id, 'file', { name: 'a.mp3', ext: 'mp3', hash: 'hash', path: 'missing' }); h.store.put(id, 'audio', { duration: 100 })
    h.lib.db.prepare('INSERT INTO kind_def(id,def) VALUES (?,?)').run('playback', JSON.stringify(oldKind))
    const savedView = h.store.createEntity(); h.store.put(savedView, 'view', { title: '音频未完成', query: { has: ['audio', 'playback'] }, layout: 'masonry' })
    handoffPlayback(h.lib.db)
    expect(JSON.parse(h.lib.db.prepare("SELECT data FROM block WHERE entity_id=? AND kind='view'").pluck().get(savedView) as string)).toMatchObject({ query: { has: ['audio', 'audioPlayback'] }, layout: 'masonry' })
    const sample = { id, hash: 'hash', session: 's1', sessionStarted: 100, lastPlayed: 101, position: 10, finished: false }
    await h.api.run('audio', 'recordPlayback', sample)
    await h.api.run('audio', 'recordPlayback', { ...sample, lastPlayed: 102, position: 12 })
    await h.api.run('audio', 'recordPlayback', { ...sample, lastPlayed: 103, session: 's2', sessionStarted: 103, position: 20 })
    for (const patch of [{ lastPlayed: 102 }, { hash: 'old', lastPlayed: 104 }, { lastPlayed: 105 }]) await h.api.run('audio', 'recordPlayback', { ...sample, ...patch })
    expect(h.store.blocksOf(id).audioPlayback.data).toMatchObject({ position: 20, plays: 2, session: 's2' })
    await h.api.run('audio', 'recordPlayback', { ...sample, sessionStarted: 200, lastPlayed: 201, position: 30 })
    expect(h.store.blocksOf(id).audioPlayback.data).toMatchObject({ position: 30, plays: 3, session: 's1' })
    h.lib.db.prepare('UPDATE entity SET deleted_at=123 WHERE id=?').run(id)
    await h.api.run('audio', 'recordPlayback', { ...sample, session: 's3', sessionStarted: 200, lastPlayed: 201 })
    expect(h.store.blocksOf(id).audioPlayback.data.plays).toBe(3)
    expect(h.lib.db.prepare("SELECT count(*) FROM block_history WHERE kind='audioPlayback'").pluck().get()).toBe(0)
  } finally { h.close(); rmSync(root, { recursive: true, force: true }) }
})

it('目标冲突保留两份，异常归属整批回滚，旧停用选择不会启动媒体加工', async () => {
  const root = tempDir(); let h = open(root, true)
  try {
    const id = h.store.createEntity(); h.store.put(id, 'file', { name: 'a.mp3', ext: 'mp3', hash: 'hash', path: 'missing' })
    h.store.put(id, 'playback', { position: 10, plays: 3, finished: false, lastPlayed: 100 })
    h.store.put(id, 'audioPlayback', { position: 20, plays: 4, finished: false, lastPlayed: 200 })
    h.lib.db.prepare("INSERT INTO config(key,value) VALUES ('plugins',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify({ disabled: ['playback'] }))
    h.lib.db.prepare("UPDATE kind_def SET def=? WHERE id='playback'").run(JSON.stringify({ ...oldKind, plugin: 'another' }))
    expect(() => handoffPlayback(h.lib.db)).toThrow('归属异常')
    expect(h.lib.db.prepare("SELECT 1 FROM meta WHERE key='playback_handoff_v1'").get()).toBeUndefined()
    h.lib.db.prepare("UPDATE kind_def SET def=? WHERE id='playback'").run(JSON.stringify(oldKind))
    h.close(); h = open(root)
    expect(h.store.blocksOf(id).playback.data.position).toBe(10)
    expect(h.store.blocksOf(id).audioPlayback.data.position).toBe(20)
    expect(h.reg.kind('audioPlayback')?.dormant).toBe(true)
    expect((await h.api.query({ has: ['playback'], sort: { kind: 'playback', field: 'lastPlayed' } })).ids).toEqual([id])
    const cleanup = await h.api.previewPluginDataCleanup({ pluginId: 'playback', mode: 'all' })
    expect(cleanup.blocked).toEqual([])
    await h.api.cleanupPluginData({ pluginId: 'playback', mode: 'all', token: cleanup.token })
    expect(h.store.blocksOf(id).playback).toBeUndefined()
    expect(h.store.blocksOf(id).audioPlayback.data.position).toBe(20)
    expect((await h.api.query({ has: ['playback'] })).ids).toEqual([id])
  } finally { h.close(); rmSync(root, { recursive: true, force: true }) }
})
