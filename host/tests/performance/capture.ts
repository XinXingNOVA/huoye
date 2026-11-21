import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import { app, type BrowserWindow } from 'electron'
import { openLibraries } from '../../src/main/libraries'
import { callCore } from '../../src/main/core-client'
import type { PerformanceFixture } from './fixture'
import { dailyFlow } from './daily'
import { glassScrollFlow } from './glass-scroll'
import { clearSearchFlow } from './clear-search'

export interface TimingSample {
  name: string; ms: number; rendererTimerLagMs: number[]; mainLoopMaxMs: number | null; coreProbeMs: number[]
}
export async function performanceFlow(win: BrowserWindow, dir: string) {
  const fixture: PerformanceFixture = JSON.parse(readFileSync(process.env.RM_BENCH_FIXTURE!, 'utf8'))
  const lib = openLibraries().find(l => l.win === win)!
  assert.equal(lib.root, fixture.root)
  const js = (source: string): Promise<any> => win.webContents.executeJavaScript(source)
  const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
  const until = async (fn: () => Promise<unknown>, name: string, limit = 60000) => {
    const start = performance.now()
    while (!await fn()) { if (performance.now() - start > limit) throw new Error('超时：' + name); await wait(20) }
  }
  const samples: TimingSample[] = []
  const memory = () => app.getAppMetrics().map(p => ({ type: p.type, name: p.name ?? '', workingSetKB: p.memory.workingSetSize, peakWorkingSetKB: p.memory.peakWorkingSetSize }))
  const result = { format: 1, phase: process.env.RM_BENCH_PHASE, count: fixture.count, spaces: fixture.spaceCount,
    launchToDomReadyMs: Date.now() - Number(process.env.RM_BENCH_SPAWN_MS), launchToFirstGridMs: 0,
    firstGridCards: 0, firstGridImages: 0, electron: process.versions.electron, chrome: process.versions.chrome,
    samples, memory: [] as { stage: string; processes: ReturnType<typeof memory> }[], plugins: [] as unknown[] }
  const output = process.env.RM_BENCH_RESULT!
  const gridReady = () => js(`(()=>{
    const c=[...document.querySelectorAll('.collection')].find(e=>e.checkVisibility());
    if(!c||c.querySelector('.toolbar-count')?.textContent.trim()!==${JSON.stringify(fixture.count + ' 项')})return false;
    const cards=[...c.querySelectorAll('.card')].filter(e=>{const r=e.getBoundingClientRect();return r.bottom>0&&r.top<innerHeight});
    const imgs=cards.flatMap(c=>[...c.querySelectorAll('img')]);
    return cards.length>0&&imgs.length===cards.length&&imgs.every(i=>i.complete&&i.naturalWidth>0);
  })()`)
  // 隐藏窗口会被 Chromium 节流；测试显示但不抢焦点，明确记录为前台绘制条件。
  win.webContents.setBackgroundThrottling(false); win.showInactive()
  try {
    await until(gridReady, '首屏卡片与可见缩略图')
    await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
    result.launchToFirstGridMs = Date.now() - Number(process.env.RM_BENCH_SPAWN_MS)
    const first = await js(`(()=>{const c=[...document.querySelectorAll('.collection')].find(e=>e.checkVisibility());return {cards:c.querySelectorAll('.card').length,imgs:c.querySelectorAll('.card img').length}})()`)
    result.firstGridCards = first.cards; result.firstGridImages = first.imgs
    result.memory.push({ stage: 'first-grid', processes: memory() })
    result.plugins = await callCore(lib.core, 'plugins')
    if (result.phase === 'startup') { writeFileSync(output, JSON.stringify(result, null, 2)); return }
    if (result.phase === 'glass-scroll') {
      const glassScroll = await glassScrollFlow(win, lib.id, dir, Number(process.env.RM_BENCH_SAMPLES ?? 6))
      writeFileSync(output, JSON.stringify({ ...result, glassScroll }, null, 2))
      return
    }
    if (result.phase === 'clear-search') {
      const clearSearch = await clearSearchFlow(lib, fixture, Number(process.env.RM_BENCH_SAMPLES ?? 5))
      writeFileSync(output, JSON.stringify({ ...result, clearSearch }, null, 2))
      return
    }
    if (result.phase === 'daily') {
      const daily = await dailyFlow(lib, fixture, dir, stage => result.memory.push({ stage, processes: memory() }))
      writeFileSync(output, JSON.stringify({ ...result, daily }, null, 2))
      return
    }

    const measure = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
      await js(`(()=>{const b={last:performance.now(),lags:[],timer:0};b.timer=setInterval(()=>{const now=performance.now();b.lags.push(Math.max(0,now-b.last-20));b.last=now},20);window.__rmPerf=b})()`)
      const loop = monitorEventLoopDelay({ resolution: 10 }); loop.enable()
      const probes: number[] = []; let probing = true
      const heartbeat = (async () => {
        while (probing) {
          const t = performance.now(); await callCore(lib.core, 'get', []); probes.push(performance.now() - t)
          await wait(100)
        }
      })()
      // 计时探针准备时间不计入操作；所有操作使用相同探针配置。
      await wait(25)
      const start = performance.now()
      try {
        const value = await fn(), ms = performance.now() - start
        const lags: number[] = await js(`(()=>{const b=window.__rmPerf;clearInterval(b.timer);b.lags.push(Math.max(0,performance.now()-b.last-20));delete window.__rmPerf;return b.lags})()`)
        loop.disable(); probing = false; await heartbeat
        samples.push({ name, ms, rendererTimerLagMs: lags, mainLoopMaxMs: loop.count ? loop.max / 1e6 : null, coreProbeMs: probes })
        console.log(`[performance] ${fixture.count}/${fixture.spaceCount} ${name}: ${ms.toFixed(1)} ms`)
        writeFileSync(output + '.partial', JSON.stringify(result))
        return value
      } finally {
        probing = false; loop.disable(); await heartbeat
        await js('if(window.__rmPerf){clearInterval(window.__rmPerf.timer);delete window.__rmPerf}')
      }
    }
    await measure('idle_1000ms', () => wait(1000))
    const repeats = Number(process.env.RM_BENCH_SAMPLES ?? 5)
    // 读操作先预热一次，然后记录每个样本。操作阶段均在写入前。
    const query = async () => { const r = await callCore(lib.core, 'query', {}); assert.equal(r.ids.length, fixture.count); return r }
    await query()
    for (let i = 0; i < repeats; i++) {
      await measure('query_all_rpc', query)
      await measure('search_note_rpc', async () => { const r = await callCore(lib.core, 'query', { text: 'perfneedle' }); assert.equal(r.ids.length, fixture.noteMatches) })
      await measure('get_100_rpc', async () => { assert.equal((await callCore(lib.core, 'get', fixture.ids.slice(0, 100))).length, Math.min(100, fixture.count)) })
      await measure('scan_spaces_unchanged', async () => { const r = await callCore(lib.core, 'scanSpaceImports'); assert.equal(r.errors.length, 0); assert.equal(r.collected, 0); assert.equal(r.updated, 0) })
      await measure('references_preview_10', async () => { assert.equal((await callCore(lib.core, 'itemDisposalSnapshot', fixture.ids.slice(-10))).files.length, 10) })
      await measure('space_page_50', async () => { const r = await callCore(lib.core, 'listSpaceFiles', { spaceId: fixture.spaces[0].id, limit: 50 }); assert(r.items.length > 0) })
      await measure('space_notification_refresh', () => callCore(lib.core, 'refreshFileSpace', fixture.spaces[0].id))
    }
    const search = async (text: string, count: number) => {
      await js(`(()=>{const e=[...document.querySelectorAll('.collection input[aria-label="搜索内容"]')].find(e=>e.checkVisibility());if(!e)throw Error('搜索框不存在');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(text)});e.dispatchEvent(new Event('input',{bubbles:true}))})()`)
      await until(() => js(`(()=>{const c=[...document.querySelectorAll('.collection')].find(e=>e.checkVisibility());return c?.querySelector('.toolbar-count')?.textContent.trim()===${JSON.stringify(count + ' 项')}&&c.querySelectorAll('.card').length>0})()`), '界面搜索结果')
      await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
    }
    for (let i = 0; i < 3; i++) {
      await measure('search_note_ui_including_debounce', () => search('perfneedle', fixture.noteMatches))
      await search('', fixture.count)
    }
    for (let i = 0; i < 3; i++) await measure('original_read_10', async () => {
      const items = await callCore(lib.core, 'get', fixture.ids.slice(i * 10, i * 10 + 10))
      const urls = items.map(v => 'lib://' + lib.id + '/' + v.blocks.file.data.path)
      await js(`Promise.all(${JSON.stringify(urls)}.map(async url=>{const r=await fetch(url,{cache:'no-store'});if(!r.ok)throw Error('读取失败');return(await r.arrayBuffer()).byteLength}))`)
    })
    result.memory.push({ stage: 'after-reads', processes: memory() })
    // 新文件必须走真实 utilityProcess 导入/加工；样本彼此内容不同，不把去重命中当导入速度。
    for (let round = 0; round < 3; round++) {
      const paths: string[] = []
      for (let j = 0; j < 10; j++) {
        const path = join(dir, `new-${round}-${j}.png`)
        await sharp({ create: { width: 1600, height: 1000, channels: 3, background: { r: 20 + round * 30 + j, g: 120 + j, b: 180 } } }).png().toFile(path)
        paths.push(path)
      }
      await measure('import_10_ready', async () => {
        const start = performance.now()
        const report = await callCore(lib.core, 'importToLibrary', paths.map(path => ({ type: 'file', path })), { requestId: randomUUID() })
        samples.push({ name: 'import_10_ack', ms: performance.now() - start, rendererTimerLagMs: [], mainLoopMaxMs: null, coreProbeMs: [] })
        assert.equal(report.errors.length, 0); assert.equal(report.items.length, 10)
        const ids = report.items.map(i => i.id)
        await until(async () => (await callCore(lib.core, 'get', ids)).every(v => v.blocks.thumb && Object.keys(v.failures).length === 0), '新图加工', 120000)
      })
    }
    for (let i = 0; i < 3; i++) {
      const ids = fixture.ids.slice(i * 10, i * 10 + 10)
      await measure('library_trash_10', () => callCore(lib.core, 'trash', ids))
      await callCore(lib.core, 'restore', ids)
    }
    if (process.platform !== 'darwin') throw new Error('物理处置基准目前仅启用 macOS；其他平台需先实现测试包的精确清理')
    for (let i = 0; i < 3; i++) {
      const selection = { ids: fixture.ids.slice(i * 10, i * 10 + 10) }
      const preview = await measure('combined_preview_10', () => js(`window.bridge.itemDisposal.preview(${JSON.stringify(selection)})`))
      assert.equal(preview.blocked.length, 0)
      const input = { selection, previewToken: preview.previewToken, requestId: randomUUID() }
      const applied = await measure('combined_delete_10', () => js(`window.bridge.itemDisposal.execute(${JSON.stringify(input)})`))
      assert.equal(applied.state, 'complete'); assert.equal(applied.completed, 10)
    }
    await until(() => js(`document.querySelector('.collection .toolbar-count')?.textContent.trim()===${JSON.stringify(fixture.count + ' 项')}`), '最终素材数量')
    result.memory.push({ stage: 'after-writes', processes: memory() })
    writeFileSync(join(dir, 'performance-final.png'), (await win.webContents.capturePage()).toPNG())
    writeFileSync(output, JSON.stringify(result, null, 2))
  } catch (e) {
    writeFileSync(output + '.error', String(e) + '\n' + await js('document.body.innerText'))
    writeFileSync(join(dir, 'performance-error.png'), (await win.webContents.capturePage()).toPNG())
    throw e
  }
}
