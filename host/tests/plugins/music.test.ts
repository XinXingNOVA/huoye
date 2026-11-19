import { afterEach, expect, it } from 'vitest'
import { openHost } from '../helpers/helpers'
import { legacyCorePlugins, legacyManifest } from '../helpers/legacy-plugins'
import { plugin as music } from '@test-plugins/music/core'
import { parseLyrics, currentLine } from '@test-plugins/music/lyrics'
import { MusicSession, readSession, type SavedSession } from '@test-plugins/music/session'

let current: ReturnType<typeof openHost> | undefined
afterEach(async () => { if (current) { await current.host.scheduler.idle(); current.cleanup(); current = undefined } })
function setup() {
  current = openHost([...legacyCorePlugins, music], { manifest: [...legacyManifest, { id: 'music', title: '音乐', description: '', requires: ['audio'] }] })
  const h = current.host
  const songs = ['清晨', '黄昏', '夜晚'].map(name => {
    const id = h.store.createEntity(); h.store.put(id, 'file', { name: name + '.wav' }); h.store.put(id, 'audio', { title: name, duration: 20, playable: true }); return id
  })
  return { h, songs, run: (command: string, args: Record<string, unknown>) => h.api.run('music', command, args) as { id: string } }
}
it('歌单按引用保存顺序，重复加入去重，删除一次完成且撤销不影响歌曲、歌词与信息修正', async () => {
  const { h, songs, run } = setup()
  const p = run('createPlaylist', { title: '夜路', tracks: songs.slice(0, 2) }).id
  run('addTracks', { id: p, tracks: [songs[1], songs[2]] })
  run('moveTrack', { id: p, track: songs[2], before: songs[0] })
  expect(h.store.blocksOf(p).musicPlaylist.data.tracks).toEqual([songs[2], songs[0], songs[1]])
  h.api.undo(); expect(h.store.blocksOf(p).musicPlaylist.data.tracks).toEqual(songs)
  run('saveLyrics', { id: songs[0], text: '[00:01.00]归途', offset: 0.5 })
  run('editTrack', { id: songs[0], title: '清晨修正', artist: '', album: '' })
  const before = h.store.get(songs)
  run('deletePlaylist', { id: p })
  expect(h.store.exists(p)).toBe(false)
  expect((await h.api.query({ scope: 'trash', role: 'management' })).ids).toEqual([])
  expect(h.store.get(songs)).toEqual(before)
  h.api.undo(); expect(h.store.blocksOf(p).musicPlaylist.data.tracks).toEqual(songs)
  expect((await h.api.query({ search: [{ kind: 'musicLyrics', field: 'text', text: '归途' }] })).ids).toEqual([songs[0]])
  expect(() => h.api.put(p, 'note', { text: '不该附加' })).toThrow('管理记录')
})
it('坏歌曲整批拒绝，删除的歌曲仍保留引用；调整位置不覆盖并发增加的歌曲', () => {
  const { h, songs, run } = setup(), p = run('createPlaylist', { title: '测试', tracks: songs.slice(0, 2) }).id
  expect(() => run('addTracks', { id: p, tracks: [songs[2], 'missing'] })).toThrow('可用')
  expect(h.store.blocksOf(p).musicPlaylist.data.tracks).toEqual(songs.slice(0, 2))
  run('addTracks', { id: p, tracks: [songs[2]] }); run('moveTrack', { id: p, track: songs[0], before: null })
  expect(h.store.blocksOf(p).musicPlaylist.data.tracks).toEqual([songs[1], songs[2], songs[0]])
  h.api.trash([songs[1]])
  expect(h.store.blocksOf(p).musicPlaylist.data.tracks).toContain(songs[1])
  expect(() => run('saveLyrics', { id: songs[1], text: 'bad' })).toThrow('可用')
  expect(() => run('saveLyrics', { id: songs[0], text: 'bad', offset: Infinity })).toThrow('偏移')
  expect(h.store.blocksOf(songs[0]).musicLyrics).toBeUndefined()
})
it('LRC 支持多时间戳、毫秒、偏移、乱序与同一时刻的翻译，普通文本保持可读', () => {
  const lyrics = parseLyrics('\uFEFF[ar:Artist]\n[offset:-250]\n[00:10.50][00:20.125]副歌\n[00:01.0]第一句\n[00:10.50]译文')
  expect(lyrics.lines.map(l => l.time)).toEqual([1, 10.5, 10.5, 20.125])
  expect(lyrics.offset).toBe(-.25)
  expect(currentLine(lyrics.lines, 0)).toBe(-1)
  expect(currentLine(lyrics.lines, 10.6)).toBe(2)
  expect(currentLine(lyrics.lines, 99)).toBe(3)
  expect(parseLyrics('第一句\n第二句')).toEqual({ lines: [], plain: '第一句\n第二句', offset: 0 })
})
it('队列与播放模式独立于歌单；重开保持暂停，切歌清除旧时间，删除当前曲不意外播放', () => {
  let saved: SavedSession | undefined
  const session = new MusicSession({ version: 1, queue: ['a', 'b', 'c'], index: 1, position: 8 }, value => { saved = value })
  expect(session.getSnapshot().playing).toBe(false); expect(session.resume).toBe(8)
  session.next(false); expect(session.getSnapshot().index).toBe(2); expect(session.resume).toBe(0)
  session.next(false); expect(session.autoplay).toBe(false)
  session.mode('repeat'); session.next(false); expect(session.getSnapshot().index).toBe(2); expect(session.autoplay).toBe(true)
  session.mode('shuffle'); session.next(); expect(session.getSnapshot().index).not.toBe(2)
  session.enqueue(['d'], true); expect(session.getSnapshot().queue[session.getSnapshot().index + 1]).toBe('d')
  session.remove(session.getSnapshot().index); expect(session.autoplay).toBe(false)
  session.played(true); session.played(false); expect(session.autoplay).toBe(false)
  session.playQueue(['a', 'b', 'c'], 'a'); session.enqueue(['c'], true)
  expect(session.getSnapshot().queue).toEqual(['a', 'c', 'b'])
  expect(new MusicSession(saved, () => {}).getSnapshot().playing).toBe(false)
  expect(readSession({ version: 1, queue: ['a', 'a', 4], index: 99, volume: Infinity, position: NaN }).queue).toEqual(['a'])
})
