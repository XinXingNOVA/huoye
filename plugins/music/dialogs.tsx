import { pluginMessages as packageMessages, useLocale as useUiLocale } from '@resource-manager/plugin-api/ui/locale'
import { acceleratorLabel } from '@resource-manager/plugin-api/ui/widgets'
import { useRef, useState, type FormEvent, type ReactNode } from 'react'
import type { UiHost } from '@resource-manager/plugin-api/ui/contracts'
import type { EntityView } from '@resource-manager/plugin-api/blocks'
import { useEntity } from '@resource-manager/plugin-api/ui/data'
import { useIds, trackInfo } from './runtime'
import { decodeLyrics, MAX_LYRIC_BYTES } from './lyric-match'

const uiText = packageMessages('music')


function Form({ title, children, close, submit, confirm = uiText("保存") }: { title: string; children: ReactNode; close(): void; submit(): Promise<void>; confirm?: string }) {
  useUiLocale()
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const saving = useRef(false)
  const onSubmit = async (e: FormEvent) => {
    e.preventDefault(); if (saving.current) return
    saving.current = true; setBusy(true); setError('')
    try { await submit(); close() } catch (e) { setError(String(e)); saving.current = false; setBusy(false) }
  }
  return <form className="music-form" onSubmit={onSubmit}>
    <h2>{title}</h2><fieldset disabled={busy}>{children}</fieldset>
    {error && <p role="alert" className="music-error">{error}</p>}
    <footer><button type="button" className="small" onClick={close}>{uiText("取消")}</button><button className="music-primary" disabled={busy}>{busy ? uiText("正在保存…") : confirm}</button></footer>
  </form>
}
export function playlistDialog(host: UiHost, id?: string, initial = '', tracks: string[] = []) {
  host.showDialog(close => <PlaylistForm host={host} close={close} id={id} initial={initial} tracks={tracks}/>)
}
function PlaylistForm({ host, close, id, initial, tracks }: { host: UiHost; close(): void; id?: string; initial: string; tracks: string[] }) {
  useUiLocale()
  const [title, setTitle] = useState(initial)
  return <Form title={id ? uiText("重命名歌单") : uiText("新建歌单")} close={close} submit={async () => {
    const result = await host.core.run('music', id ? 'renamePlaylist' : 'createPlaylist', { id, title, tracks }) as { id: string } | undefined
    if (result?.id) host.openTab('music.player', { playlist: result.id })
  }}><label>{uiText("歌单名称")}<input autoFocus required maxLength={300} value={title} onChange={e => setTitle(e.target.value)} /></label></Form>
}
export function deletePlaylist(host: UiHost, id: string, title: string) {
  host.showDialog(close => <Form title={uiText("删除歌单「{title}」", { title })} confirm={uiText("删除歌单")} close={close} submit={async () => {
    await host.core.run('music', 'deletePlaylist', { id }); host.notify(uiText("歌单已删除，歌曲保留；可以撤销（{value1}）", { value1: String(acceleratorLabel('CmdOrCtrl+Z')) }))
    host.openTab('music.player', { playlist: null })
  }}><p>{uiText("只删除这份歌单及排列，歌曲、原文件和歌词保留。本次操作可以撤销。")}</p></Form>)
}
export function addToPlaylist(host: UiHost, tracks: string[]) {
  host.showDialog(close => <ChoosePlaylist host={host} tracks={tracks} close={close}/>)
}
function PlaylistOption({ id }: { id: string }) {
  useUiLocale()
  const view = useEntity(id)
  return <option value={id}>{String(view?.blocks.musicPlaylist?.data.title ?? uiText("读取中…"))}</option>
}
function ChoosePlaylist({ host, tracks, close }: { host: UiHost; tracks: string[]; close(): void }) {
  useUiLocale()
  const list = useIds(host, 'musicPlaylist'), [id, setId] = useState(''), [title, setTitle] = useState('')
  return <Form title={uiText("将 {length} 首歌曲加入歌单", { length: String(tracks.length) })} close={close} confirm={uiText("加入歌单")} submit={async () => {
    await host.core.run('music', id ? 'addTracks' : 'createPlaylist', { id, title, tracks }); host.notify(uiText("已加入歌单，可以撤销"))
  }}>
    <label>{uiText("选择歌单")}<select value={id} onChange={e => setId(e.target.value)}><option value="">{uiText("新建歌单…")}</option>{list.ids.map(id => <PlaylistOption key={id} id={id}/>)}</select></label>
    {!id && <label>{uiText("新歌单名称")}<input autoFocus required maxLength={300} value={title} onChange={e => setTitle(e.target.value)} /></label>}
    {list.error && <p role="alert">{list.error}</p>}
  </Form>
}
export function editTrack(host: UiHost, view: EntityView) {
  host.showDialog(close => <TrackForm host={host} view={view} close={close}/>)
}
function TrackForm({ host, view, close }: { host: UiHost; view: EntityView; close(): void }) {
  useUiLocale()
  const original = view.blocks.audio.data, edited = view.blocks.musicTrack?.data ?? {}
  const [data, setData] = useState(() => Object.fromEntries(['title', 'artist', 'album'].map(f => [f, String(edited[f] ?? '')])))
  return <Form title={uiText("修正歌曲信息")} close={close} submit={async () => { await host.core.run('music', 'editTrack', { id: view.id, ...data }) }}>
    <p className="muted">{uiText("仅保存你的修正，不改写音频原文件；留空时继续使用文件中的信息。")}</p>
    {Object.entries({ title: uiText("曲名"), artist: uiText("艺术家"), album: uiText("专辑") }).map(([key, label]) => <label key={key}>{label}<input maxLength={500} value={data[key]} placeholder={String(original[key] ?? '')} onChange={e => setData({ ...data, [key]: e.target.value })}/></label>)}
  </Form>
}
export function editLyrics(host: UiHost, view: EntityView) {
  host.showDialog(close => <LyricsForm host={host} view={view} close={close}/>)
}
function LyricsForm({ host, view, close }: { host: UiHost; view: EntityView; close(): void }) {
  useUiLocale()
  const initial = view.blocks.musicLyrics?.data
  const [text, setText] = useState(String(initial?.text ?? '')), [offset, setOffset] = useState(Number(initial?.offset ?? 0))
  const [source, setSource] = useState(String(initial?.source ?? '')), [error, setError] = useState('')
  const [reading, setReading] = useState(false)
  const read = async (file: File | undefined) => {
    if (!file) return
    setError(''); setReading(true)
    try {
      if (file.size > MAX_LYRIC_BYTES) throw new Error(uiText("歌词文件不能超过 1 MB"))
      const content = decodeLyrics(await file.arrayBuffer())
      setText(content); setSource(file.name)
    } catch (e) { setError(String(e)) } finally { setReading(false) }
  }
  return <Form title={uiText("歌词 · {title}", { title: String(trackInfo(view, host).title) })} close={close} submit={async () => {
    if (reading) throw new Error(uiText("请等待文件读取完成"))
    await host.core.run('music', 'saveLyrics', { id: view.id, text, offset, source })
  }}>
    <label>{uiText("导入 LRC / 文本")}<input type="file" accept=".lrc,.txt,text/plain" disabled={reading} onChange={e => void read(e.target.files?.[0])}/></label>
    <label>{uiText("歌词文本")}<textarea aria-label={uiText("歌词文本")} value={text} maxLength={1_000_000} rows={12} placeholder={uiText("[00:00.00]第一句歌词\n[00:08.50]第二句歌词\n\n也可以粘贴没有时间戳的普通歌词")} onChange={e => setText(e.target.value)}/></label>
    <label>{uiText("歌词延后（秒，负数为提前）")}<input type="number" step="0.1" min="-600" max="600" value={offset} onChange={e => setOffset(Number(e.target.value))}/></label>
    {source && <small className="muted">{uiText("来源：")}{source}</small>}{error && <p role="alert">{error}</p>}
  </Form>
}
