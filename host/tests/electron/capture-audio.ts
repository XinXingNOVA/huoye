import { captureMcpSettings, scopedMcpCall } from './capture-settings'
// 临时库验证：真实 utilityProcess 导入、Chromium 解码与跳转、续听、插件启停和 MCP 共用数据。
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport, type StdioServerParameters } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { CoreApi } from '../../src/shared/rpc'
import { callCore } from '../../src/main/core-client'
import { libraryOf } from '../../src/main/libraries'

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
interface Tools { js(code: string): Promise<any>; log(label: string, value: unknown): void; shot(name: string): Promise<void> }

export async function audioFlow(win: BrowserWindow, dir: string, { js, log, shot }: Tools) {
  win.webContents.setAudioMuted(true)
  const call = <K extends keyof CoreApi>(method: K, ...args: Parameters<CoreApi[K]>) => callCore(libraryOf(win.webContents)!.core, method, ...args)
  const check = (ok: unknown, message: string) => { if (!ok) throw new Error(message) }
  const pane = `document.querySelector('.tab-pane:not(.hidden)')`
  const media = `${pane}.querySelector('audio')`
  const until = async (test: () => Promise<unknown>, message: string) => {
    for (let i = 0; i < 80; i++) { if (await test()) return; await wait(100) }
    throw new Error(message)
  }
  const click = async (selector: string, title: string) => {
    check(await js(`(() => {const e=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>e.textContent.trim()===${JSON.stringify(title)});e?.click();return !!e})()`), `缺少入口 ${title}`)
    await wait(250)
  }
  const ready = () => until(() => js(`!!${media} && ${media}.readyState >= 2 && Number.isFinite(${media}.duration)`), '音频未能解码')
  const open = async (id: string) => {
    await click('.sidebar .nav-item', '音频')
    await until(() => js(`!!${pane}.querySelector('[data-entity-id="${id}"]')`), '音频卡片未显示')
    await js(`${pane}.querySelector('[data-entity-id="${id}"]').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`)
    await ready()
  }
  const key = (key: string) => js(`window.dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(key)},bubbles:true}))`)
  const setPlugins = async (ids: string[]) => {
    win.webContents.send('menu:command', 'settings'); await wait(350)
    for (const title of ids) await js(`(() => {const row=[...document.querySelectorAll('.plugin-row')].find(r=>r.querySelector('.plugin-title')?.textContent===${JSON.stringify(title)});if(!row)throw new Error('找不到插件 '+${JSON.stringify(title)});row.querySelector('input').click()})()`)
    await click('.settings-foot button', '应用并重新加载')
    await wait(2200)
  }

  if (process.env.CAPTURE_FLOW === 'audioresume') {
    await ready()
    check(await js(`${media}.paused && Math.abs(${media}.currentTime-8)<0.3`), '应用重启未恢复位置或自动播放了')
    const player = await js(`${media}.outerHTML`)
    await shot('audio-8-resume.png')
    log('音频应用重启续听通过', { player })
    return
  }
  const ffmpeg = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg'].find(existsSync)
  check(ffmpeg, '需要 ffmpeg 生成新的音频样本')
  const formats = ['wav', 'mp3', 'flac', 'm4a', 'ogg', 'aiff']
  const paths = formats.map(ext => {
    const file = join(dir, `清晨录音.${ext}`)
    execFileSync(ffmpeg!, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=20',
      ...(ext === 'ogg' ? ['-c:a', 'vorbis', '-strict', 'experimental', '-ac', '2'] : []),
      '-metadata', 'title=清晨的声音', '-metadata', 'artist=audio-search-needle', '-metadata', 'album=环境采样', file])
    return file
  })
  // 首份从真实外部拖入入口进入；其余通过应用核心收录接口，均在 utilityProcess 里探测。
  const point = await js(`(() => {const r=${pane}.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+130)}})()`)
  win.webContents.debugger.attach('1.3')
  try {
    for (const type of ['dragEnter', 'dragOver', 'drop']) await win.webContents.debugger.sendCommand('Input.dispatchDragEvent', { type, ...point, data: { items: [], files: [paths[0]], dragOperationsMask: 1 } })
  } finally { win.webContents.debugger.detach() }
  await until(async () => (await call('query', { has: ['audio'] })).ids.length === 1, '拖入的新音频没有加工成功')
  const [first] = (await call('query', { has: ['audio'] })).ids
  const rest = await call('ingest', paths.slice(1).map(path => ({ type: 'file' as const, path })))
  const ids = [first, ...rest]
  await until(async () => (await call('get', ids)).every(v => v.blocks.audio), '音频信息未生成')
  check((await call('get', ids)).every(v => !v.blocks.audioProxy && !v.blocks.video), '导入时多余转码或被视频接管')
  await click('.sidebar .nav-item', '音频')
  await shot('audio-1-cards.png')
  const before = (await call('get', ids)).map(v => v.blocks.file)

  // MCP 无需增加任何音频专用工具：按定义发现、检索、读取并复用标签命令。
  const settings = await captureMcpSettings(win, 'organize')
  const params = Object.values(JSON.parse(settings.config).mcpServers)[0] as StdioServerParameters
  const client = new Client({ name: 'audio-capture', version: '1.0.0' })
  const transport = new StdioClientTransport({ ...params, stderr: 'pipe' })
  const tool = async (name: string, args: Record<string, unknown>) => {
    const result = await scopedMcpCall(client, libraryOf(win.webContents)!.id, { name, arguments: args })
    check(!result.isError, `${name} 失败：${JSON.stringify(result.content)}`)
    return result.structuredContent as any
  }
  try {
    await client.connect(transport)
    check((await tool('describe_library', {})).kinds.some((k: any) => k.id === 'audio'), 'MCP 没有发现音频定义')
    const found = await tool('search_items', { query: { has: ['audio'], search: [{ kind: 'audio', field: 'artist', text: 'audio-search-needle' }] } })
    check(found.items.some((i: any) => i.id === ids[1]), 'MCP 没有按音频艺术家字段查到结果')
    check((await tool('read_content', { id: ids[1], kind: 'audio', field: 'title' })).text === '清晨的声音', 'MCP 音频字段读取错误')
    await tool('update_tags', { ids: [ids[1]], add: ['音效参考'], requestId: 'audio-integration-tag' })
    check((await call('get', [ids[1]]))[0].blocks.tags.data.values instanceof Array, 'MCP 标签没有写入音频素材')
  } finally { await client.close(); await transport.close() }
  log('音频 MCP 发现、按字段搜索、读取、打标签通过', true)

  for (const [i, id] of ids.entries()) {
    await open(id)
    await js(`${media}.play()`)
    await wait(200)
    check(await js(`!${media}.paused && ${media}.currentTime>0`), `${formats[i]} 没有真正开始播放`)
    await js(`${media}.currentTime=6;${media}.pause()`)
    await wait(150)
    check(await js(`Math.abs(${media}.currentTime-6)<0.3`), `${formats[i]} 跳转失败`)
    if (formats[i] === 'aiff') {
      check((await call('get', [id]))[0].blocks.audioProxy, 'AIFF 未生成播放副本')
      await shot('audio-2-converted.png')
    }
  }
  log('六种格式实际播放及跳转通过', formats)
  await open(first)
  check(await js(`${media}.paused`), '再次切回已打开的标签页自动开始播放')
  await js(`(() => {const e=${pane}.querySelector('[aria-label="播放速度"]');e.value='1.5';e.dispatchEvent(new Event('change',{bubbles:true}));${pane}.querySelector('input[type=checkbox]').click()})()`)
  await wait(120)
  check(await js(`${media}.playbackRate===1.5 && ${media}.loop`), '倍速或循环未生效')
  await js(`${media}.currentTime=19.8;${media}.play()`); await wait(650)
  check(await js(`!${media}.paused && ${media}.currentTime<2`), '循环没有从开头继续')
  await js(`${media}.pause();${media}.currentTime=6`)
  await key('ArrowRight'); await wait(120)
  check(await js(`Math.abs(${media}.currentTime-11)<0.3`), '方向键跳转未生效')
  await key(' '); await wait(120)
  check(await js(`!${media}.paused`), '空格播放失败')
  await click('.sidebar .nav-item', '音频')
  check(await js(`[...document.querySelectorAll('.tab-pane.hidden audio')].every(e=>e.paused)`), '隐藏标签页没有暂停')
  // 空格预览也走同一播放器与进度记录。
  await js(`${pane}.querySelector('[data-entity-id="${ids[1]}"]').dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}))`)
  await key(' ')
  await until(() => js(`!!document.querySelector('.preview-overlay audio') || !!document.querySelector('.preview audio')`), '空格预览未显示音频')
  await shot('audio-3-preview.png')
  await key('Escape')

  // 公共进度 hook 迁出视频后，也用新视频走一次播放、暂停与保存，避免只验证音频。
  const videoPath = join(dir, '播放记录回归.mp4')
  execFileSync(ffmpeg!, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=10', '-t', '6', '-c:v', 'libx264', videoPath])
  const [videoId] = await call('ingest', [{ type: 'file', path: videoPath }])
  await until(async () => !!(await call('get', [videoId]))[0].blocks.video, '新视频加工失败')
  await click('.sidebar .nav-item', '视频')
  await until(() => js(`!!${pane}.querySelector('[data-entity-id="${videoId}"]')`), '新视频卡片未显示')
  await js(`${pane}.querySelector('[data-entity-id="${videoId}"]').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`)
  await until(() => js(`!!${pane}.querySelector('video') && ${pane}.querySelector('video').readyState>=2`), '新视频无法播放')
  await js(`${pane}.querySelector('video').play()`); await wait(150)
  await js(`(() => {const e=${pane}.querySelector('video');e.currentTime=2;e.pause()})()`)
  await until(async () => Number((await call('get', [videoId]))[0].blocks.videoPlayback?.data.position) >= 2, '视频公共进度记录失败')
  log('新视频播放与公共进度回归通过', videoId)

  // 停用前保证进度已保存。停用后不丢数据，音频与视频启停没有依赖。
  await open(first)
  await js(`(() => {const loop=${pane}.querySelector('input[type=checkbox]');if(loop.checked)loop.click();${media}.playbackRate=1;${media}.currentTime=19.9;return ${media}.play()})()`)
  await until(async () => (await call('get', [first]))[0].blocks.audioPlayback?.data.finished === true, '播完没有标记已完成')
  check((await call('get', [first]))[0].blocks.audioPlayback.data.position === 0, '播完没有清除续听位置')
  await js(`${media}.currentTime=8;${media}.play()`)
  await wait(100); await js(`${media}.pause();${media}.currentTime=8;${media}.dispatchEvent(new Event('pause'))`)
  await wait(250)
  await shot('audio-4-player.png')
  const playback = (await call('get', [first]))[0].blocks.audioPlayback
  await setPlugins(['音频'])
  check((await call('plugins')).find(p => p.id === 'audio')?.enabled === false, '音频未停用')
  check((await call('get', [first]))[0].blocks.audioPlayback.seq === playback.seq, '停用修改了播放记录')
  check((await call('query', { has: ['audio'] })).ids.length === ids.length, '停用后查不到音频')
  const out = await call('exportRun', { ids: [first], titles: { [first]: '录音' }, parent: dir, name: '原文件导出' })
  check(out.written === 1 && !out.failed.length, '停用音频后不能导出原文件')
  check(readFileSync(join(out.dir, '素材', String(before[0].data.name))).equals(readFileSync(paths[0])), '导出没有保留原文件字节')
  for (let i = 0; i < ids.length; i++) check(readFileSync(join(libraryOf(win.webContents)!.root, String(before[i].data.path))).equals(readFileSync(paths[i])), '原文件字节发生变化')
  await shot('audio-5-disabled.png')
  await setPlugins(['音频', '视频'])
  check((await call('plugins')).find(p => p.id === 'audio')?.enabled && !(await call('plugins')).find(p => p.id === 'video')?.enabled, '音频仍依赖视频')
  await open(first)
  // 停用时工作区会移除未知标签页；这里用户双击新开应继续播放，重启恢复才要求暂停。
  const restored = await js(`({paused:${media}.paused,position:${media}.currentTime})`)
  log('重新启用后新开音频的进度', restored)
  check(restored.position >= 7.8 && restored.position < 9, '重新启用后没有从保存位置继续')
  await js(`${media}.pause();${media}.currentTime=8;${media}.dispatchEvent(new Event('pause'))`)
  await wait(250)
  await shot('audio-6-reenabled.png')
  win.setSize(850, 650); await wait(350)
  check(await js(`${pane}.scrollWidth<=${pane}.clientWidth+1`), '窄窗口音频页横向溢出')
  await shot('audio-7-narrow.png')
  writeFileSync(join(dir, 'audio-result.json'), JSON.stringify({ ids, formats, checks: ['fresh import', 'metadata', 'play', 'seek', 'proxy', 'preview', 'speed', 'loop', 'hidden pause', 'plugin toggle', 'MCP', 'original bytes', 'narrow'] }, null, 2))
  log('音频插件端到端验证通过', { ids, formats })
}
