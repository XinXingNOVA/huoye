import { packageActionScope, afterPackageAction, finishPackageInstall } from './capture-settings'
// 使用独立 userData / 临时仓库安装真实外部包，再从 utilityProcess 导入新音频。
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { BrowserWindow } from 'electron'
import type { CoreApi } from '../../src/shared/rpc'
import { callCore } from '../../src/main/core-client'
import { libraryOf } from '../../src/main/libraries'
import { selectCapturePackage } from '../../src/main/plugin-packages'
import { lyricMatchFlow } from './capture-lyrics'

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
interface Tools { js(code: string): Promise<any>; log(label: string, value: unknown): void; shot(name: string): Promise<void>; chooseMenu(label: string): void }
export async function musicFlow(win: BrowserWindow, dir: string, { js, log, shot, chooseMenu }: Tools) {
  win.webContents.setAudioMuted(true)
  const lib = () => libraryOf(win.webContents)!
  const call = <K extends keyof CoreApi>(method: K, ...args: Parameters<CoreApi[K]>) => callCore(lib().core, method, ...args)
  const check = (ok: unknown, message: string) => { if (!ok) throw new Error(message) }
  const until = async (test: () => Promise<unknown>, message: string) => {
    for (let i = 0; i < 150; i++) { try { if (await test()) return } catch { /* 正在重载 */ } await wait(100) }
    throw new Error(message)
  }
  const click = async (selector: string, title?: string) => {
    selector = await packageActionScope(js, selector, title)
    await until(() => js(`(() => {const b=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>e.getClientRects().length && ${title === undefined ? 'true' : `e.textContent.trim()===${JSON.stringify(title)}`});if(!b||b.disabled)return false;b.click();return true})()`), `按钮不可用：${title ?? selector}`)
    await wait(180)
    await afterPackageAction(js, selector, title)
  }
  const fill = async (selector: string, value: string, select = false) => {
    await js(`(() => {const e=document.querySelector(${JSON.stringify(selector)}); if(!e)throw new Error('输入框不存在'); const proto=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:e.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event(${JSON.stringify(select ? 'change' : 'input')},{bubbles:true}))})()`)
    await wait(150)
  }
  const media = `document.querySelector('audio.music-audio')`
  const ready = () => until(() => js(`${media}?.readyState>=2`), '音乐没有解码成功')
  const openMusic = async () => {
    if (!await js(`document.querySelector('.activity-entry[data-panel-id="music.library"]').getAttribute('aria-pressed')==='true'`)) await click('.activity-entry[data-panel-id="music.library"]')
    await click('.music-navigation .music-nav-link', '全部歌曲')
    await until(() => js(`!!document.querySelector('.tab-pane:not(.hidden) .music-page')`), '未打开音乐标签页')
  }
  const apply = async () => {
    const old = lib().core
    await click('.settings-foot button', '应用并重新加载')
    await until(() => Promise.resolve(lib().core !== old && !lib().reloading), '仓库未重新加载')
    await until(() => js(`!!document.querySelector('.package-settings')`), '重载后设置页未恢复')
  }
  const settings = async () => { win.webContents.send('menu:command', 'settings'); await until(() => js(`!!document.querySelector('.tab-pane:not(.hidden) .package-settings')`), '未打开设置') }
  const pack = resolve(process.env.CAPTURE_MUSIC_BASELINE ?? 'artifacts/plugins/music.rmplugin')
  const install = async () => {
    selectCapturePackage(pack)
    await click('.package-heading button', '安装套件或插件包…')
    await until(() => js(`!!document.querySelector('.package-dialog')`), '安装确认未出现')
    await finishPackageInstall(js, true); await apply()
  }

  if (process.env.CAPTURE_FLOW === 'lyricmatchresume') { await lyricMatchFlow(win, dir, { js, log, shot }); return }
  if (process.env.CAPTURE_FLOW === 'musicresume') {
    await ready()
    check(await js(`${media}.paused && Math.abs(${media}.currentTime-7)<.4`), '重启后没有保持暂停或位置不正确')
    check(await js(`document.querySelector('.dock-tabs [data-panel-id="music.lyrics"]').getAttribute('aria-pressed')==='true'`), '歌词面板选择没有恢复')
    await js(`(() => {const button=document.querySelector('.dock-tabs [data-panel-id="music.queue"]');button.focus();button.click()})()`)
    check(await js(`document.activeElement===document.querySelector('.dock-tabs [data-panel-id="music.queue"]') && ${media}.paused`), '切换面板丢失键盘焦点或意外播放')
    await click('.dock-tabs [data-panel-id="music.lyrics"]')
    check(await js(`(() => {const button=document.querySelector('[aria-label="播放音乐"]');button.focus();const event=new KeyboardEvent('keydown',{key:' ',bubbles:true,cancelable:true});return button.dispatchEvent(event) && ${media}.paused})()`), '侧栏的空格被中央音乐标签截获')
    const playlists = await call('query', { scope: 'all', has: ['musicPlaylist'] })
    check(playlists.ids.length === 1, '歌单没有恢复')
    await shot('music-7-resume.png')
    log('音乐应用重启通过', { position: await js(`${media}.currentTime`), paused: true, playlist: playlists.ids[0] })
    return
  }
  await settings(); await install()
  check((await call('plugins')).find(p => p.id === 'music')?.enabled, '外部播放器未装配')
  if (process.env.CAPTURE_FLOW === 'lyricmatch') { await lyricMatchFlow(win, dir, { js, log, shot }); return }
  const ffmpeg = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg'].find(existsSync)
  check(ffmpeg, '需要 ffmpeg 制作新音频')
  const names = ['清晨的航线', '雨停之后', '夜色漫游']
  const files = names.map((name, index) => {
    const file = join(dir, `${name}.${index === 1 ? 'mp3' : 'wav'}`)
    execFileSync(ffmpeg!, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=${440 + index * 110}:duration=40`, '-metadata', `title=${name}`, '-metadata', 'artist=声音实验室', '-metadata', 'album=日常的切片', file])
    return file
  })
  const ids = await call('ingest', files.map(path => ({ type: 'file' as const, path })))
  await until(async () => (await call('get', ids)).every(v => v.blocks.audio), '新音频未由实际核心解析')
  const original = (await call('get', ids)).map(v => v.blocks.file)
  await openMusic()
  await until(() => js(`document.querySelectorAll('.music-song').length===3`), '歌曲列表不完整')
  check(await js(`document.querySelector('.dock-tabs [data-panel-id="host.inspector"]').getAttribute('aria-pressed')==='true'`), '打开音乐标签擅自替换了右栏')
  check(await js(`!document.querySelector('.music-playerbar') && !document.querySelector('.dock-heading select') && !document.querySelector('.statusbar')`), '仍有底部播放条或旧的面板选择器')
  // 左入口只换导航，不影响中央标签；再次点击收起，入口条仍可用。
  const mainTab = await js(`document.querySelector('.tab.active').textContent`)
  await click('.activity-entry[data-panel-id="music.library"]'); await wait(300)
  check(await js(`document.querySelector('#sidebar-panel').inert && document.querySelector('.activity-entry[data-panel-id="music.library"]').getBoundingClientRect().width>0`), '收起左栏时入口一同消失')
  await click('.activity-entry[data-panel-id="host.navigation"]'); await wait(300)
  check(await js(`document.querySelector('.tab.active').textContent===${JSON.stringify(mainTab)}`), '切入口意外换了中央标签')
  await click('.activity-entry[data-panel-id="music.library"]')
  await click('.dock-tabs [data-panel-id="music.lyrics"]')
  await shot('music-1-library.png')
  // 多选创建歌单。
  for (const id of ids.slice(0, 2)) await click(`.music-song[data-track-id="${id}"] input`)
  await click('.music-list-toolbar button', '加入歌单')
  await fill('.music-form input', '走路时听')
  await click('.music-form footer button', '加入歌单')
  await until(async () => (await call('query', { scope: 'all', has: ['musicPlaylist'] })).ids.length === 1, '未创建歌单')
  const [playlist] = (await call('query', { scope: 'all', has: ['musicPlaylist'] })).ids
  await until(() => js(`!!document.querySelector('[data-playlist-id="${playlist}"]')`), '左栏歌单未更新')
  await click(`[data-playlist-id="${playlist}"]`)
  await until(() => js(`document.querySelectorAll('.music-song').length===2`), '未切换歌单')
  await click('.music-head-actions button', '重命名'); await fill('.music-form input', '散步与远行'); await click('.music-form footer button', '保存')
  await js(`(() => {const dt=new DataTransfer();dt.setData('application/x-rm-music-track',${JSON.stringify(ids[1])});document.querySelector('.music-song[data-track-id="${ids[0]}"]').dispatchEvent(new DragEvent('drop',{bubbles:true,dataTransfer:dt}))})()`)
  await until(async () => ((await call('get', [playlist]))[0].blocks.musicPlaylist.data.tracks as string[])[0] === ids[1], '拖动排序未保存')
  await call('undo')
  await click('.music-head-actions button', '删除歌单'); await click('.music-form footer button', '删除歌单')
  check(!(await call('get', [playlist])).length && (await call('get', ids)).length === 3, '删除歌单影响歌曲')
  await call('undo')
  await until(() => js(`!!document.querySelector('[data-playlist-id="${playlist}"]')`), '撤销未恢复歌单')
  await click(`[data-playlist-id="${playlist}"]`)
  await click(`.music-song[data-track-id="${ids[0]}"] .music-row-play`); await ready()
  await until(() => js(`!${media}.paused && ${media}.currentTime>0.1`), '未开始播放')
  await click('.music-lyric-actions button', '添加歌词')
  const lrc = '[ar:声音实验室]\n[00:00.00]风从街角经过\n[00:05.00]把清晨留在耳边\n[00:10.00]脚步慢慢向前\n[00:15.00]我们走向新的风景\n[00:25.00]光照亮了远方'
  writeFileSync(join(dir, '清晨的航线.lrc'), lrc)
  await js(`(() => {const dt=new DataTransfer();dt.items.add(new File([${JSON.stringify(lrc)}],'清晨的航线.lrc',{type:'text/plain'}));const input=document.querySelector('.music-form input[type=file]');input.files=dt.files;input.dispatchEvent(new Event('change',{bubbles:true}))})()`)
  await until(() => js(`document.querySelector('.music-form textarea').value.includes('新的风景')`), 'LRC 未读取')
  await click('.music-form footer button', '保存')
  await until(() => js(`document.querySelectorAll('.music-lines button').length===5`), '歌词未显示')
  await click('.music-lines button', '脚步慢慢向前')
  check(await js(`${media}.currentTime>=10 && ${media}.currentTime<12`), '点击歌词没有跳转')
  await until(() => js(`document.querySelector('.music-lines .current')?.textContent==='脚步慢慢向前'`), '歌词未随实际时间高亮')
  await js(`document.querySelector('.music-lyric-scroll').dispatchEvent(new WheelEvent('wheel',{bubbles:true,deltaY:100}))`)
  await click('.music-lyric-actions button', '回到当前歌词')
  // 改信息仍保留原解析与文件块。
  chooseMenu('修正歌曲信息')
  await click(`.music-song[data-track-id="${ids[0]}"] .music-row-menu`)
  await fill('.music-form input', '清晨 · 手动修正'); await click('.music-form footer button', '保存')
  await until(async () => (await call('get', [ids[0]]))[0].blocks.musicTrack?.data.title === '清晨 · 手动修正', '歌曲修正未保存')
  await shot('music-2-playing-lyrics.png')
  await js(`window.__musicElement=${media}`)
  await click('.dock-tabs [data-panel-id="music.queue"]')
  check(await js(`!document.querySelector('.music-playback-controls').getClientRects().length && !${media}.paused`), '切到队列时控制区未隐藏或音乐停止')
  await click('.dock-tabs [data-panel-id="host.inspector"]')
  check(await js(`!document.querySelector('.music-playback-controls').getClientRects().length && ${media}===window.__musicElement`), '详情页残留音乐控制或重建了会话')
  await click('.dock-tabs [data-panel-id="music.lyrics"]')
  const before = await js(`${media}.currentTime`)
  await click('.tab-new'); await wait(700)
  check(await js(`${media}===window.__musicElement && !${media}.paused && ${media}.currentTime>${before}`), '切标签页打断播放或重建了音频')
  check(await js(`document.querySelector('.dock-tabs [data-panel-id="music.lyrics"]').getAttribute('aria-pressed')==='true' && document.querySelector('.activity-entry[data-panel-id="music.library"]').getAttribute('aria-pressed')==='true'`), '中央标签切换意外更改面板选择')
  // 歌词不跟随素材选择，收起两栏也不影响声音。
  win.webContents.send('menu:command', 'panel.inspector'); win.webContents.send('menu:command', 'panel.sidebar'); await wait(400)
  check(await js(`!${media}.paused && ${media}===window.__musicElement`), '收起侧栏打断播放')
  win.webContents.send('menu:command', 'panel.inspector'); win.webContents.send('menu:command', 'panel.sidebar')
  // 把音乐标签页真正关闭，常驻会话仍在。
  await js(`(() => {const t=[...document.querySelectorAll('.tab')].find(t=>t.querySelector('.tab-title').textContent==='音乐');t.querySelector('.tab-x').click()})()`)
  check(await js(`!${media}.paused && ${media}===window.__musicElement`), '关闭音乐标签页打断播放')
  await shot('music-3-other-tab.png')
  // 现有试听与音乐互斥；直接从已有音频标签页启动真实媒体。
  await click('.activity-entry[data-panel-id="host.navigation"]')
  await click('.sidebar .nav-item', '音频')
  await until(() => js(`!!document.querySelector('[data-entity-id="${ids[2]}"]')`), '原音频视图未显示')
  await js(`document.querySelector('[data-entity-id="${ids[2]}"]').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`)
  await until(() => js(`document.querySelector('.tab-pane:not(.hidden) audio')?.readyState>=2`), '原音频播放器未加载')
  await js(`document.querySelector('.tab-pane:not(.hidden) audio').play()`)
  check(await js(`${media}.paused`), '试听未暂停背景音乐')
  await click('[aria-label="播放音乐"]'); check(await js(`document.querySelector('.tab-pane:not(.hidden) audio').paused`), '音乐未暂停试听')
  await openMusic()
  await click('[aria-label="下一首"]'); await ready()
  await until(() => js(`document.querySelector('.music-lyrics header h2')?.textContent==='雨停之后'`), '切歌未更新')
  await click('[aria-label="上一首"]'); await ready()
  // 真正触发媒体 ended，而不是只调用下一首按钮。
  await fill('[aria-label="播放模式"]', 'repeat', true)
  await js(`${media}.currentTime=${media}.duration-.15`)
  await until(() => js(`!${media}.paused && ${media}.currentTime<2 && document.querySelector('.music-lyrics header h2').textContent==='清晨 · 手动修正'`), '单曲循环没有重新播放')
  await fill('[aria-label="播放模式"]', 'sequence', true)
  await js(`${media}.currentTime=${media}.duration-.15`)
  await until(() => js(`!${media}.paused && document.querySelector('.music-lyrics header h2').textContent==='雨停之后'`), '播完没有自动接续队列')
  await js(`${media}.currentTime=${media}.duration-.15`)
  await until(() => js(`${media}.paused && ${media}.currentTime<.3`), '顺序播放到队尾没有停止并复位')
  await click('[aria-label="上一首"]'); await ready()
  await until(() => js(`!${media}.paused`), '上一首未恢复播放')
  await click('[aria-label="暂停音乐"]')
  await fill('[aria-label="音乐进度"]', '7')
  await until(() => js(`Math.abs(${media}.currentTime-7)<.3`), '进度条未跳转')
  await shot('music-4-paused.png')
  // 停用、卸载、重装：检查业务记录和本地会话保留。
  const retained = (await call('get', [playlist, ...ids])).map(v => ({ id: v.id, blocks: Object.fromEntries(Object.entries(v.blocks).filter(([k]) => k.startsWith('music'))) }))
  await settings(); await click('.package-row[data-package-id="music"] input'); await apply()
  check(await js(`!document.querySelector('.music-audio') && !document.querySelector('.music-playback-controls')`), '停用仍有播放实例')
  check(await js(`document.querySelector('.dock-tabs [data-panel-id="host.inspector"]').getAttribute('aria-pressed')==='true'`), '停用插件没有回退详情面板')
  check((await call('kinds')).find(k => k.id === 'musicLyrics')?.dormant, '停用未保留只读定义')
  await click('.package-row[data-package-id="music"] button', '卸载…'); await click('.package-dialog .package-danger')
  check((await call('get', [playlist])).length === 1, '卸载删除歌单')
  await install(); await ready()
  check(await js(`document.querySelector('.dock-tabs [data-panel-id="music.lyrics"]').getAttribute('aria-pressed')==='true'`), '重装没有恢复此前选择的面板')
  check(await js(`${media}.paused && Math.abs(${media}.currentTime-7)<.3`), '重装未恢复暂停位置')
  check(JSON.stringify(retained) === JSON.stringify((await call('get', [playlist, ...ids])).map(v => ({ id: v.id, blocks: Object.fromEntries(Object.entries(v.blocks).filter(([k]) => k.startsWith('music'))) }))), '启停卸载改写了用户数据')
  await openMusic()
  win.setSize(960, 720); await wait(350)
  check(await js(`document.querySelector('.music-page').scrollWidth<=document.querySelector('.music-page').clientWidth+1`), '窄窗口音乐页溢出')
  check(await js(`(() => {
    const panel=document.querySelector('.music-lyrics'), controls=panel.querySelector('.music-playback-controls'), scroll=panel.querySelector('.music-lyric-scroll');
    const p=panel.getBoundingClientRect(),c=controls.getBoundingClientRect(),s=scroll.getBoundingClientRect();
    return controls.scrollWidth<=controls.clientWidth && c.bottom<=p.bottom+1 && c.top>=s.bottom && s.height>80 && !document.querySelector('.main .music-playback-controls');
  })()`), '控制区未限制在歌词底部或挤没了歌词空间')
  await shot('music-5-narrow.png')
  await js(`(async()=>{for(let i=0;i<6;i++){document.querySelector('.panel-resize-right').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));await new Promise(r=>setTimeout(r,30))}})()`)
  await wait(350)
  check(await js(`(() => {
    const controls=document.querySelector('.music-playback-controls'), r=controls.getBoundingClientRect();
    return document.querySelector('#inspector-panel').clientWidth===240 && [...controls.querySelectorAll('button,input,select')].every(e=>{const b=e.getBoundingClientRect();return b.left>=r.left && b.right<=r.right && b.bottom<=r.bottom});
  })()`), '最窄歌词面板的控制溢出')
  await shot('music-6-minimum-panel.png')
  await js(`document.querySelector('.panel-resize-right').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`)
  for (const [index, id] of ids.entries()) {
    const file = (await call('get', [id]))[0].blocks.file
    check(JSON.stringify(file) === JSON.stringify(original[index]), '文件数据被改写')
    check(readFileSync(join(lib().root, String(file.data.path))).equals(readFileSync(files[index])), '原文件字节变化')
  }
  check((await call('query', { search: [{ kind: 'musicLyrics', field: 'text', text: '新的风景' }] })).ids.includes(ids[0]), '歌词不能按字段搜索')
  log('外部音乐播放器全流程通过', { ids, playlist, checks: ['实际安装包', '新 WAV/MP3 导入解码', '多选建歌单、改名、排序与撤销', '删除歌单保留歌曲', 'LRC 文件导入与点击跳转', '播放时间驱动歌词', '跨标签页及关闭标签持续播放', '收起侧栏', '原音频试听互斥', '统一停用、卸载、重装恢复', '窄窗口', '原文件字节与业务数据保留', '歌词字段搜索'] })
}
