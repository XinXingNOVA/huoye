import { packageActionScope, afterPackageAction, finishPackageInstall } from './capture-settings'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { BrowserWindow } from 'electron'
import type { CoreApi } from '../../src/shared/rpc'
import { callCore } from '../../src/main/core-client'
import { libraryOf } from '../../src/main/libraries'
import { selectCapturePackage } from '../../src/main/plugin-packages'

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
interface Tools { js(code: string): Promise<any>; log(label: string, value: unknown): void; shot(name: string): Promise<void> }
export async function lyricMatchFlow(win: BrowserWindow, dir: string, { js, log, shot }: Tools) {
  win.webContents.setAudioMuted(true)
  const lib = () => libraryOf(win.webContents)!
  const call = <K extends keyof CoreApi>(method: K, ...args: Parameters<CoreApi[K]>) => callCore(lib().core, method, ...args)
  const check = (ok: unknown, message: string) => { if (!ok) throw new Error(message) }
  const until = async (test: () => Promise<unknown>, message: string) => {
    for (let i = 0; i < 150; i++) { try { if (await test()) return } catch { /* 等待重载 */ } await wait(100) }
    throw new Error(message)
  }
  const click = async (selector: string, title?: string) => {
    selector = await packageActionScope(js, selector, title)
    await until(() => js(`(() => { const b=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>e.getClientRects().length && ${title === undefined ? 'true' : `e.textContent.trim()===${JSON.stringify(title)}`}); if(!b||b.disabled)return false;b.click();return true })()`), `按钮不可用：${title ?? selector}`)
    await wait(200)
    await afterPackageAction(js, selector, title)
  }
  const lyrics = async (id: string) => (await call('get', [id]))[0].blocks.musicLyrics
  const media = `document.querySelector('audio.music-audio')`
  if (process.env.CAPTURE_FLOW === 'lyricmatchresume') {
    const saved = JSON.parse(readFileSync(join(dir, 'lyric-match-state.json'), 'utf8'))
    const records = (await call('get', saved.ids)).map(v => ({ id: v.id, lyrics: v.blocks.musicLyrics }))
    check(JSON.stringify(records) === JSON.stringify(saved.records), '重启改写了歌词')
    await until(() => js(`${media}?.readyState>=2`), '重启音乐未加载')
    check(await js(`${media}.paused`), '重启意外播放')
    await shot('lyrics-6-resume.png')
    log('库内歌词重启通过', { count: records.length, paused: true })
    return
  }
  const ffmpeg = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg'].find(existsSync)
  check(ffmpeg, '需要 ffmpeg 制作验证音频')
  const names = ['归途', '晨雾', '独行', '保留手写', '晚风', '回声', '回声']
  const files = names.map((name, i) => {
    const path = join(dir, `${name}-${i}.wav`)
    execFileSync(ffmpeg!, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=${440 + 30 * i}:duration=40`,
      '-metadata', `title=${name}`, '-metadata', 'artist=声音实验室', '-metadata', 'album=本地匹配', path])
    return path
  })
  const ids = await call('ingest', files.map(path => ({ type: 'file' as const, path })))
  await until(async () => (await call('get', ids)).every(v => v.blocks.audio), '新 WAV 未在 utilityProcess 解析')
  const oldText = '[00:01]我自己写的歌词，保持原样'
  await call('run', 'music', 'saveLyrics', { id: ids[3], text: oldText, offset: .3, source: '手写' })
  await call('run', 'music', 'saveLyrics', { id: ids[5], text: '[00:00]可复用的回声歌词', offset: -.2, source: '旧导入.lrc' })
  const playlist = await call('run', 'music', 'createPlaylist', { title: '升级前的歌单', tracks: ids.slice(0, 2) }) as { id: string }
  const retained = await call('get', [playlist.id, ids[3], ids[5]])
  // 使用已安装的 1.1.0 写好数据后，从实际安装入口升级到 1.2.0。
  if (process.env.CAPTURE_MUSIC_BASELINE) {
    selectCapturePackage(resolve('artifacts/plugins/music.rmplugin'))
    await click('.package-heading button', '安装套件或插件包…')
    await finishPackageInstall(js, true)
    const old = lib().core
    await click('.settings-foot button', '应用并重新加载')
    await until(() => Promise.resolve(lib().core !== old && !lib().reloading), '新版包未应用')
    await until(() => js(`!!document.querySelector('.package-settings')`), '升级未完成')
  }
  check(JSON.stringify(await call('get', [playlist.id, ids[3], ids[5]])) === JSON.stringify(retained), '升级改写旧歌单或歌词')
  const makeLrc = (title: string, line: string) => `[ti:${title}]\n[ar:声音实验室]\n[al:本地匹配]\n[length:00:40]\n[00:00.00]${line}\n[00:10.00]沿着时间慢慢走`
  const contents = [makeLrc('归途', '归途的路灯'), makeLrc('晨雾', '晨雾原版'), makeLrc('晨雾', '晨雾译文'), '[00:00]独行的普通版本', makeLrc('保留手写', '库里的另一个版本')]
  const lyricFiles = ['归途.lrc', '晨雾-原文.lrc', '晨雾-译文.lrc', '声音实验室 - 独行.lrc', '保留手写.lrc'].map((name, i) => {
    const path = join(dir, name); writeFileSync(path, contents[i]); return path
  })
  const sources = await call('ingest', lyricFiles.map(path => ({ type: 'file' as const, path })))
  await until(async () => (await call('get', sources)).every(v => v.blocks.musicLyricSource?.data.text), '新歌词文件未在真实核心建立索引')
  await click('.activity-entry[data-panel-id="music.library"]')
  await click('.music-navigation .music-nav-link', '全部歌曲')
  await click('.dock-tabs [data-panel-id="music.lyrics"]')
  const play = async (id: string) => {
    await click(`.music-song[data-track-id="${id}"] .music-row-play`)
    await until(() => js(`${media}?.readyState>=2 && !${media}.paused`), '歌曲未开始播放')
  }
  await play(ids[0])
  await until(async () => (await lyrics(ids[0]))?.data.text === contents[0], '唯一明确歌词未自动写入')
  await until(() => js(`document.querySelector('.music-lines .current')?.textContent==='归途的路灯'`), '采用后歌词未高亮')
  await shot('lyrics-1-automatic.png')
  await call('undo'); await wait(900)
  check(!await lyrics(ids[0]), '撤销后自动填回歌词')
  await click('.dock-tabs [data-panel-id="music.queue"]'); await click('.dock-tabs [data-panel-id="music.lyrics"]')
  await click('.music-match-heading button', '重新匹配'); await wait(400)
  check(!await lyrics(ids[0]), '重新查询覆盖了撤销意图')
  await click('.music-lyric-candidate .music-primary', '采用这份歌词')
  await until(async () => !!await lyrics(ids[0]), '撤销后无法手动采用')
  await play(ids[1]); await until(() => js(`document.querySelectorAll('.music-lyric-candidate').length===2`), '多候选未显示')
  await wait(700); check(!await lyrics(ids[1]), '多候选被自动采用')
  await shot('lyrics-2-choices.png')
  // 窄栏仍可滚动查看预览和采用，不侵入播放控制。
  win.setSize(960, 720)
  await js(`(async()=>{for(let i=0;i<6;i++){document.querySelector('.panel-resize-right').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));await new Promise(r=>setTimeout(r,30))}})()`)
  await wait(300)
  check(await js(`(() => {const panel=document.querySelector('.music-lyric-scroll');return panel.scrollWidth<=panel.clientWidth+1 && panel.clientHeight>100})()`), '窄栏候选横向溢出或无滚动空间')
  await shot('lyrics-3-narrow-choices.png')
  await click(`.music-lyric-candidate[data-candidate-id="${sources[2]}"] .music-primary`)
  await until(async () => (await lyrics(ids[1]))?.data.text === contents[2], '未采用指定候选')
  check((await call('query', { has: ['audio'], search: [{ kind: 'musicLyrics', field: 'text', text: '晨雾译文' }] })).ids.includes(ids[1]), '采用的歌词未参与搜索')
  const edited = await call('prepareFileEdit', { id: sources[2], requestId: 'lyrics-source-edit', destination: { mode: 'publish' }, content: { type: 'text', text: makeLrc('晨雾', '来源后来编辑了') } })
  await call('commitFileEdit', { editId: edited.editId, previewToken: edited.previewToken, requestId: 'lyrics-source-commit' })
  await wait(700); check((await lyrics(ids[1]))?.data.text === contents[2], '源文件变化覆盖歌曲快照')
  await play(ids[2]); await until(() => js(`document.querySelectorAll('.music-lyric-candidate').length===1`), '文件名候选未出现')
  await wait(600); check(!await lyrics(ids[2]), '只有文件名也被自动采用')
  await click('.music-lyric-candidate .music-primary'); await until(async () => !!await lyrics(ids[2]), '文件名候选不能手动采用')
  await play(ids[3]); await wait(700)
  check((await lyrics(ids[3]))?.data.text === oldText && (await lyrics(ids[3]))?.data.offset === .3, '原手写歌词或校时被覆盖')
  await play(ids[4]); await until(() => js(`document.querySelector('.music-lyric-matches')?.textContent.includes('没有找到')`), '缺歌词状态未显示')
  await click('.dock-tabs [data-panel-id="host.inspector"]'); await click('.tab-new')
  const late = join(dir, '晚风.lrc'); writeFileSync(late, makeLrc('晚风', '播放后才收录的晚风'))
  await call('ingest', [{ type: 'file', path: late }])
  await until(async () => (await lyrics(ids[4]))?.data.text === makeLrc('晚风', '播放后才收录的晚风'), '侧栏隐藏时新收录的歌词未自动匹配')
  await click('.music-navigation .music-nav-link', '全部歌曲'); await click('.dock-tabs [data-panel-id="music.lyrics"]')
  await play(ids[6]); await until(async () => (await lyrics(ids[6]))?.data.text === '[00:00]可复用的回声歌词', '已有音频上的歌词未复用')
  check((await lyrics(ids[6]))?.data.offset === -.2, '复用丢失原校时')
  await click('[aria-label="暂停音乐"]')
  for (const [index, id] of ids.entries()) {
    const file = (await call('get', [id]))[0].blocks.file
    check(readFileSync(join(lib().root, String(file.data.path))).equals(readFileSync(files[index])), '匹配改写音频原文件')
  }
  await shot('lyrics-4-reused.png')
  const records = (await call('get', ids)).map(v => ({ id: v.id, lyrics: v.blocks.musicLyrics }))
  writeFileSync(join(dir, 'lyric-match-state.json'), JSON.stringify({ ids, records }))
  log('库内歌词全流程通过', { upgraded: !!process.env.CAPTURE_MUSIC_BASELINE, songs: ids.length, indexed: sources.length + 1, undo: true, snapshot: true, muted: true })
}
