import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { app, contentTracing, screen, type BrowserWindow } from 'electron'
import { localThemes } from '../../src/main/appearance'

const modeStyles = {
  off: ':root { --hy-surface-filter: none !important }',
  shell: ':root[data-hy-glass] [data-hy-part="resource-card"] { backdrop-filter: none !important }',
  cards: ':root[data-hy-glass] [data-hy-part="resource-card"] { backdrop-filter: var(--hy-surface-filter) !important }'
}
type Mode = keyof typeof modeStyles
const orders: Mode[][] = [
  ['off', 'shell', 'cards'], ['shell', 'cards', 'off'], ['cards', 'off', 'shell'],
  ['cards', 'shell', 'off'], ['off', 'cards', 'shell'], ['shell', 'off', 'cards']
]
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const pane = "document.querySelector('.tab-pane:not(.hidden) .collection')"
const grid = pane + ".querySelector('.grid-scroller')"
type RunScript = (code: string) => Promise<any>
async function until(read: () => Promise<boolean>, label: string) {
  for (let i = 0; i < 300; i++) {
    if (await read()) return
    await delay(40)
  }
  throw new Error('滚动基准未就绪：' + label)
}

interface TraceEvent {
  name: string; pid: number; ts: number; dur?: number
  args?: { name?: string; scroll_jank_v4?: unknown; args?: { data?: { expected: number; dropped_v4: number; checkerboarded: number } } }
}
function scrollMetrics(path: string, renderer: number) {
  const events: TraceEvent[] = JSON.parse(readFileSync(path, 'utf8')).traceEvents
  const sequences = events.filter(e => e.pid === renderer && e.name === 'FrameSequenceTrackerV3' && e.args?.name === 'WheelScroll')
  const data = sequences.flatMap(e => e.args?.args?.data ?? [])
  assert(data.every(d => d.expected > 0 && d.dropped_v4 >= 0 && d.checkerboarded >= 0), '缺少合成器滚动帧计数')
  const presented = [...new Set(events.filter(e => e.pid === renderer && e.name === 'Presentation' && e.args?.scroll_jank_v4).map(e => e.ts))].sort((a,b) => a-b)
  assert(presented.length >= 10, '缺少滚动画面呈现时间戳')
  const frameMs = presented.slice(1).map((ts,i) => (ts - presented[i]) / 1000)
  const drawMs = events.filter(e => e.name === 'DirectRenderer::DrawFrame' && e.dur !== undefined &&
    e.ts >= presented[0] && e.ts <= presented[presented.length-1]).map(e => e.dur! / 1000)
  assert(drawMs.length > 0, '缺少 Viz 绘制样本')
  // 少数手势的汇总事件可能延后至录制结束以后；保留已呈现帧，不把缺失计数冒充零。
  const counter = (key: 'expected' | 'dropped_v4' | 'checkerboarded') =>
    data.length && data.length === sequences.length ? data.reduce((n,d) => n + d[key], 0) : null
  return { expected: counter('expected'), dropped: counter('dropped_v4'), checkerboarded: counter('checkerboarded'), frameMs, drawMs }
}

async function setCardWidth(js: RunScript, width: number) {
  const trigger = pane + '.querySelector(\'[aria-label="显示设置"]\')'
  const slider = 'document.querySelector(\'input[aria-label="卡片大小"]\')'
  await js(trigger + '.click()')
  await until(() => js('!!' + slider), '显示设置')
  await js(`(() => {
    const el=${slider}
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el, ${JSON.stringify(String(width))})
    el.dispatchEvent(new Event('input',{bubbles:true}))
  })()`)
  await until(() => js(`${slider}.closest('label').querySelector('output').textContent === '${width}'`), '卡片大小 ' + width)
  await js(trigger + '.click()')
}

export async function glassScrollFlow(win: BrowserWindow, libraryId: string, dir: string, rounds: number) {
  const wc = win.webContents, js: RunScript = code => wc.executeJavaScript(code)
  const themes = localThemes()
  themes.install(readFileSync(resolve('tests/fixtures/themes/celadon-mist.zip')))
  themes.change(libraryId, { action: 'select', id: 'external:celadon-mist' })
  win.show()
  await until(() => js("document.documentElement.dataset.theme === 'external:celadon-mist'"), '包内主题')
  await js(`new Promise((done,fail) => {
    const image = new Image(); image.onload = () => done(true); image.onerror = () => fail(Error('基准壁纸不可读'))
    image.src = getComputedStyle(document.querySelector('.app'), '::before').backgroundImage.slice(5,-2)
  })`)
  const imagesReady = () => js(`(() => {
    const g = ${grid}, box = g.getBoundingClientRect()
    const visible = [...g.querySelectorAll('[data-entity-id]')].filter(c => { const b=c.getBoundingClientRect(); return b.bottom>box.top && b.top<box.bottom })
    return visible.length > 0 && visible.every(c => { const i=c.querySelector('img');return i?.complete && i.naturalWidth>0 })
  })()`)
  const bounds = await js(`(() => { const g=${grid}, b=g.getBoundingClientRect(); return {
    x: Math.round(b.x+b.width/2), y: Math.round(b.y+b.height/2), width:g.clientWidth,height:g.clientHeight,
    dpr:devicePixelRatio, viewport:[innerWidth,innerHeight] } })()`)
  const distance = Math.round(bounds.height * 5), speed = 1400
  const tracePath = join(dir, 'glass-scroll-trace.json')
  const dbg = wc.debugger
  dbg.attach()
  const scroll = () => dbg.sendCommand('Input.synthesizeScrollGesture', { x: bounds.x, y: bounds.y, yDistance: -distance,
    speed, gestureSourceType: 'mouse', preventFling: true })
  const reset = async () => {
    await js(`${grid}.scrollTop = 0`)
    await until(async () => (await js(`${grid}.scrollTop === 0`)) && await imagesReady(), '路线起点缩略图')
    await delay(150)
  }
  const runs = []
  let css: string | undefined, tracing = false
  try {
    for (const width of [220, 120]) {
      await setCardWidth(js, width)
      await reset()
      await scroll()
      await until(imagesReady, '预热终点')
      for (let round = 0; round < rounds; round++) for (const mode of orders[round % orders.length]) {
        if (css) await wc.removeInsertedCSS(css)
        css = await wc.insertCSS(modeStyles[mode])
        await reset()
        const state = await js(`(() => {
          const g=${grid}, card=g.querySelector('[data-entity-id]')
          return { card:getComputedStyle(card).backdropFilter, shell:getComputedStyle(document.querySelector('.window-toolbar')).backdropFilter,
            mounted:g.querySelectorAll('[data-entity-id]').length, first:card.dataset.entityId }
        })()`)
        assert.equal(state.card, mode === 'cards' ? 'blur(6px)' : 'none')
        assert.equal(state.shell, mode === 'off' ? 'none' : 'blur(6px)')
        await contentTracing.startRecording({ included_categories:['benchmark'], recording_mode:'record-until-full' })
        tracing = true
        await scroll()
        // WheelScroll 的结束统计晚于输入回执。绘制样本只取首次至末次滚动呈现之间。
        await delay(500)
        await contentTracing.stopRecording(tracePath); tracing = false
        const end = await js(`${grid}.scrollTop`) as number
        assert(Math.abs(end-distance) < 6, '滚动终点不符：' + end)
        await until(imagesReady, '动作后缩略图')
        assert.notEqual(await js(`${grid}.querySelector('[data-entity-id]').dataset.entityId`), state.first, '终点仍是起点素材')
        runs.push({ width, round:round+1, mode, mounted:state.mounted, end, ...scrollMetrics(tracePath,wc.getOSProcessId()) })
      }
    }
    return { bounds, displayHz: screen.getDisplayMatching(win.getBounds()).displayFrequency, gpu:app.getGPUFeatureStatus(),
      distance, speed, preset:'celadon-mist', blurPx:6, runs }
  } finally {
    if (tracing) await contentTracing.stopRecording(tracePath)
    if (css && !wc.isDestroyed()) await wc.removeInsertedCSS(css)
    if (dbg.isAttached()) dbg.detach()
    themes.change(libraryId, { action: 'follow' })
  }
}
