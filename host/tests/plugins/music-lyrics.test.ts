import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { openHost, saveTextFile } from '../helpers/helpers'
import { legacyCorePlugins, legacyManifest } from '../helpers/legacy-plugins'
import { plugin as music } from '@test-plugins/music/core'
import { assessLyrics, decodeLyrics, lyricMetadata, type LyricMatches } from '@test-plugins/music/lyric-match'
import { checkPackageKinds } from '../../src/core/external-plugins'
import { canonical, kindSnapshot } from '../../src/shared/external-plugins'

let current: ReturnType<typeof openHost> | undefined
afterEach(async () => { if (current) { await current.host.scheduler.idle(); current.cleanup(); current = undefined } })
function setup() {
  current = openHost([...legacyCorePlugins, music], { manifest: [...legacyManifest, { id: 'music', title: '音乐', description: '', requires: ['file', 'audio'] }] })
  const { host: h, root } = current
  const song = (title = '归途', artist = '歌手甲', album = '专辑甲', duration = 30) => {
    const id = h.store.createEntity()
    h.store.put(id, 'file', { name: title + '.wav' })
    h.store.put(id, 'audio', { title, artist, album, duration, playable: true })
    return id
  }
  const run = (command: string, args: Record<string, unknown>) => h.api.run('music', command, args)
  const find = (id: string) => run('findLyrics', { id }) as LyricMatches
  const apply = (matches: LyricMatches, index = 0, automatic = true) => run('applyMatchedLyrics', {
    id: matches.id, target: matches.target, candidate: matches.candidates[index].id, token: matches.candidates[index].token, automatic
  })
  const ingest = async (name: string, content: string | Buffer) => {
    const path = join(root, name); writeFileSync(path, content)
    const [id] = await h.api.ingest([{ type: 'file', path }]); await h.scheduler.idle(); return id
  }
  return { h, root, song, run, find, apply, ingest }
}
const lrc = '[ti:归途]\n[ar:歌手甲]\n[al:专辑甲]\n[length:00:30]\n[offset:250]\n[00:01.00]路灯亮起来\n[00:08.50]一起走回家'

it('新增可重建歌词索引兼容原安装包的持久定义，旧歌单与歌词无需迁移', () => {
  const { h } = setup()
  const previous = music.blocks!.filter(b => !b.rebuildable).map(kindSnapshot).sort((a, b) => a.id.localeCompare(b.id))
  h.lib.db.prepare('INSERT INTO main.config (key, value) VALUES (?, ?)').run('externalSchema:music', canonical(previous))
  expect(() => checkPackageKinds(h.lib, 'music', music.blocks!)).not.toThrow()
})
it('实际收录 LRC 建立索引，唯一明确结果采用为歌曲快照，可搜索、撤销、重做且不改原文件', async () => {
  const { h, song, ingest, find, apply } = setup(), id = song()
  const source = await ingest('归途.lrc', lrc)
  const original = h.store.blocksOf(source).file
  expect(h.store.blocksOf(source).musicLyricSource.data.title).toBe('归途')
  const matches = find(id)
  expect(matches).toMatchObject({ existing: false, pending: 0, candidates: [{ id: source, strong: true, synced: true }] })
  apply(matches)
  expect(h.store.blocksOf(id).musicLyrics.data).toEqual({ text: lrc, offset: 0, source: '归途.lrc' })
  expect((await h.api.query({ has: ['audio'], search: [{ kind: 'musicLyrics', field: 'text', text: '路灯' }] })).ids).toEqual([id])
  h.api.undo(); expect(h.store.blocksOf(id).musicLyrics).toBeUndefined()
  h.api.redo(); expect(h.store.blocksOf(id).musicLyrics.data.text).toBe(lrc)
  expect(h.store.blocksOf(source).file).toEqual(original)
  await saveTextFile(h, source, lrc.replace('一起走回家', '全新的歌词')); await h.scheduler.idle()
  expect(h.store.blocksOf(id).musicLyrics.data.text).toBe(lrc)
})
it('多个候选禁止自动采用；用户选择具体版本后保存', async () => {
  const { h, song, ingest, find, apply } = setup(), id = song()
  await ingest('归途-原文.lrc', lrc)
  const translated = await ingest('归途-翻译.lrc', lrc + '\n[00:01.00]The lights are on')
  const result = find(id)
  expect(result.candidates).toHaveLength(2)
  expect(() => apply(result)).toThrow('唯一明确')
  apply(result, result.candidates.findIndex(c => c.id === translated), false)
  expect(h.store.blocksOf(id).musicLyrics.data.text).toContain('The lights')
})
it('只有元信息没有歌词正文的文件不能自动采用', async () => {
  const { song, ingest, find } = setup(), id = song()
  await ingest('空歌词.lrc', '[ti:归途]\n[ar:歌手甲]\n[al:专辑甲]')
  expect(find(id).candidates).toEqual([])
})
it('仅文件名吻合只能手选；普通 TXT 不冒充歌词，带时间戳的 TXT 可以参与', async () => {
  const { h, song, ingest, find, apply } = setup(), id = song()
  await ingest('归途.txt', '这是普通日记，不是歌词')
  expect(find(id).candidates).toHaveLength(0)
  const source = await ingest('歌手甲 - 归途.txt', '[00:01]没有元信息的歌词')
  const matches = find(id)
  expect(matches.candidates).toMatchObject([{ id: source, strong: false }])
  expect(() => apply(matches)).toThrow('唯一明确')
  apply(matches, 0, false)
  expect(h.store.blocksOf(id).musicLyrics.data.text).toContain('没有元信息')
})
it('已有歌词包括主动清空的块都保留，并拒绝在查询后覆盖并发编辑', async () => {
  const { h, song, ingest, find, apply, run } = setup(), id = song()
  await ingest('归途.lrc', lrc)
  const result = find(id)
  run('saveLyrics', { id, text: '我的手动编辑', offset: .7 })
  expect(() => apply(result)).toThrow('已有歌词')
  expect(find(id)).toMatchObject({ existing: true, candidates: [] })
  expect(h.store.blocksOf(id).musicLyrics.data.text).toBe('我的手动编辑')
  run('saveLyrics', { id, text: '' })
  expect(find(id).existing).toBe(true)
})
it('查询后的信息修正、候选变化、回收和新候选到达均在采用时复查', async () => {
  const { h, song, ingest, find, apply, run } = setup(), id = song()
  const source = await ingest('归途.lrc', lrc)
  let result = find(id)
  run('editTrack', { id, title: '新曲名', artist: '', album: '' })
  expect(() => apply(result)).toThrow('歌曲信息已变化')
  h.api.undo(); result = find(id)
  await saveTextFile(h, source, lrc + '\n[00:20]新增内容')
  expect(() => apply(result)).toThrow('候选歌词已变化')
  await h.scheduler.idle(); result = find(id)
  h.api.trash([source]); expect(() => apply(result)).toThrow('候选歌词已变化')
  h.api.restore([source]); result = find(id)
  await ingest('归途-第二份.lrc', lrc + '\n[00:21]另一版本')
  expect(() => apply(result)).toThrow('唯一明确')
  expect(h.store.blocksOf(id).musicLyrics).toBeUndefined()
})
it('文件改名使旧索引暂时失效，未完成索引时不自动采用', async () => {
  const { h, song, ingest, find, apply } = setup(), id = song()
  await ingest('归途.lrc', lrc)
  const result = find(id)
  const pending = h.store.createEntity(); h.store.put(pending, 'file', { name: '等待.lrc', ext: 'lrc', hash: 'pending' })
  expect(find(id).pending).toBe(1)
  expect(() => apply(result)).toThrow('唯一明确')
  h.api.trash([pending])
  const source = result.candidates[0].id, file = h.store.blocksOf(source).file
  h.store.put(source, 'file', { ...file.data, name: '改名.lrc' })
  expect(find(id)).toMatchObject({ pending: 1, candidates: [] })
})
it('可复用其他音频的歌词及校时，歌曲修正优先于音频元信息；回收内容不参与', () => {
  const { h, song, run, find, apply } = setup(), id = song(), source = song('临时名称')
  run('saveLyrics', { id: source, text: lrc, offset: -.5, source: '原导入.lrc' })
  run('editTrack', { id: source, title: '归途', artist: '', album: '' })
  const result = find(id)
  expect(result.candidates).toMatchObject([{ id: source, strong: true, offset: -.5 }])
  apply(result); expect(h.store.blocksOf(id).musicLyrics.data.offset).toBe(-.5)
  h.api.undo(); h.api.trash([source]); expect(find(id).candidates).toHaveLength(0)
})
it('匹配保留版本差异，歌手冲突排除，专辑和时长冲突要求手选', () => {
  const song = { title: '归途', artist: '歌手甲', album: '专辑甲', duration: 30, tagged: true }
  const source = { ...song, text: lrc, offset: 0, label: '示例' }
  expect(assessLyrics(song, { ...source, title: '归途 (Live)' })).toBeUndefined()
  expect(assessLyrics(song, { ...source, artist: '歌手乙' })).toBeUndefined()
  expect(assessLyrics(song, { ...source, album: '现场' })?.strong).toBe(false)
  expect(assessLyrics(song, { ...source, duration: 60 })?.strong).toBe(false)
  expect(assessLyrics(song, { ...source, artist: '' })?.strong).toBe(false)
  expect(assessLyrics({ ...song, title: 'ＳＯＮＧ' }, { ...source, title: 'Song' })?.strong).toBe(true)
})
it('歌词解析支持元信息与 GB18030；过大或坏文件报告问题而不阻挡其他明确候选', async () => {
  expect(decodeLyrics(Uint8Array.from([0xb9, 0xe9, 0xcd, 0xbe]))).toBe('归途')
  expect(lyricMetadata(lrc, 'wrong.lrc')).toMatchObject({ title: '归途', artist: '歌手甲', duration: 30, tagged: true })
  const { song, ingest, find, apply } = setup(), id = song()
  await ingest('过大.lrc', Buffer.alloc(1_000_001, 65))
  await ingest('坏编码.lrc', Buffer.from([0xff]))
  await ingest('归途.lrc', lrc)
  const result = find(id)
  expect(result).toMatchObject({ pending: 0, failed: 2, candidates: [{ strong: true }] })
  expect(() => apply(result)).not.toThrow()
})
