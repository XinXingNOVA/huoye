import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import type { BrowserWindow } from 'electron'
import { findProgram, programDirectories } from '../../src/platform/programs'
import { libraryOf, reloadLibrary } from '../../src/main/libraries'
import { localPackages } from '../../src/main/plugin-packages'
import { encodePackage } from '../../src/plugin-packages/archive'
import { packageManifestSchema } from '../../src/shared/external-plugins'
import { callCore } from '../../src/main/core-client'
import type { CoreApi } from '../../src/shared/rpc'

export async function playbackFlow(win: BrowserWindow, dir: string) {
  win.webContents.setAudioMuted(true)
  const js = (code: string) => win.webContents.executeJavaScript(code)
  const wait = (ms = 150) => new Promise(r => setTimeout(r, ms))
  const until = async (test: () => Promise<unknown>, message: string) => { for (let i=0;i<160;i++) { if (await test()) return; await wait(100) } throw Error(message) }
  const call = <K extends keyof CoreApi>(m: K, ...a: Parameters<CoreApi[K]>) => callCore(libraryOf(win.webContents)!.core, m, ...a)
  const manifest = packageManifestSchema.parse({ formatVersion: 1, apiVersion: 1, id: 'playback-probe', title: '播放验收', version: '1.0.0', author: 'test', description: '', entries: { ui: 'ui.mjs' } })
  localPackages().install(encodePackage(manifest, new Map([['ui.mjs', Buffer.from("export const plugin={id:'playback-probe',windowProviders:[{id:'playback-probe.host',order:1,Component:({host,children})=>{globalThis.__playHost=host;return children}}]}")]])))
  const probe = localPackages().list().find(p=>p.manifest.id==='playback-probe')!
  const music = localPackages().list().find(p=>p.manifest.id==='music')!
  await js(`window.bridge.packages.apply({disabled:[],changes:[{hash:${JSON.stringify(probe.hash)},enabled:true},{hash:${JSON.stringify(music.hash)},enabled:true}]})`)
  await reloadLibrary(libraryOf(win.webContents)!); await wait(1200)
  await until(()=>js(`!!globalThis.__playHost`),'测试宿主未就绪')
  assert.ok((await call('plugins')).some(p=>p.id==='music'&&p.enabled),'音乐包未加载：'+JSON.stringify(await call('plugins')))
  const ffmpeg = findProgram('ffmpeg', programDirectories())!
  const song = join(dir,'record.wav'), movie = join(dir,'record.mp4')
  execFileSync(ffmpeg,['-v','error','-y','-f','lavfi','-i','sine=frequency=440:duration=12',song])
  execFileSync(ffmpeg,['-v','error','-y','-f','lavfi','-i','color=c=blue:s=160x90:d=12','-c:v','libx264','-pix_fmt','yuv420p',movie])
  const [audio,video] = await call('ingest',[{type:'file',path:song},{type:'file',path:movie}])
  const view = async (id: string)=>(await call('get',[id]))[0]
  await until(async()=> (await view(audio)).blocks.audio && (await view(video)).blocks.video,'媒体加工失败')
  const sample = async (selector: string, position: number) => {
    await until(()=>js(`document.querySelector(${JSON.stringify(selector)})?.readyState>=2`),'媒体未解码：'+selector)
    await js(`(async()=>{const e=document.querySelector(${JSON.stringify(selector)});e.muted=true;await e.play();e.currentTime=${position}})()`)
    await wait(160)
    await js(`document.querySelector(${JSON.stringify(selector)}).pause()`)
  }
  await js(`__playHost.open(${JSON.stringify(audio)})`)
  await sample('.audio-player audio',3)
  await until(async()=>Number((await view(audio)).blocks.audioPlayback?.data.position)>=3,'试听未保存')
  assert.equal((await view(audio)).blocks.playback,undefined)
  await js(`__playHost.open(${JSON.stringify(video)})`)
  await sample('video.player-video',4)
  await until(async()=>Number((await view(video)).blocks.videoPlayback?.data.position)>=4,'视频未保存')
  const videoBefore = (await view(video)).blocks.videoPlayback
  await call('run','music','createPlaylist',{title:'播放接续',tracks:[audio]})
  await call('run','music','saveLyrics',{id:audio,text:'[00:00.00]测试歌词',offset:0})
  await js(`__playHost.openTab('music.player',{playIds:[${JSON.stringify(audio)}]});__playHost.showView('music.lyrics')`)
  await sample('audio.music-audio',6)
  await until(async()=>Number((await view(audio)).blocks.audioPlayback?.data.position)>=6,'音乐未共用音频记录')
  const record = (await view(audio)).blocks.audioPlayback
  assert.equal(record.data.plays,2)
  assert.deepEqual((await view(video)).blocks.videoPlayback,videoBefore)
  await js(`document.querySelector('audio.music-audio').play();__playHost.open(${JSON.stringify(video)})`)
  assert.equal(await js(`document.querySelector('audio.music-audio').paused`),false,'切换标签停止音乐')
  await js(`document.querySelector('audio.music-audio').pause()`)
  await until(async()=>Number((await view(audio)).blocks.audioPlayback.data.position)>=6,'音乐暂停保存失败')
  const beforeReload = (await view(audio)).blocks.audioPlayback.data
  await reloadLibrary(libraryOf(win.webContents)!); await wait(1200)
  await until(()=>js(`document.querySelector('audio.music-audio')?.readyState>=2`),'重开未恢复音乐会话')
  assert.equal(await js(`document.querySelector('audio.music-audio').paused`),true)
  assert.ok(Math.abs(await js(`document.querySelector('audio.music-audio').currentTime`) - Number(beforeReload.position)) < .5)
  assert.equal((await view(audio)).blocks.audioPlayback.data.plays,2)
  assert.equal((await view(audio)).blocks.musicLyrics.data.text,'[00:00.00]测试歌词')
  assert.equal((await call('query',{scope:'all',has:['musicPlaylist']})).ids.length,1)
  writeFileSync(join(dir,'playback-result.json'),JSON.stringify({audio,video,utilityImport:true,audioAndVideoSave:true,musicSharesAudio:true,plays:2,backgroundPlayback:true,reloadResume:true,playlistAndLyrics:true}))
}
