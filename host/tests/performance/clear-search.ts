// 真实集合窗口。用页面时钟区分输入、查询往返、DOM 提交和可见图片就绪。
import assert from 'node:assert/strict'
import type { OpenLibrary } from '../../src/main/libraries'
import { callCore } from '../../src/main/core-client'
import type { PerformanceFixture } from './fixture'

export async function clearSearchFlow(lib: OpenLibrary, fixture: PerformanceFixture, repeats: number) {
  const js = (source: string) => lib.win.webContents.executeJavaScript(source)
  const samples = []
  await js(`(() => {
    const pane = document.querySelector('.tab-pane:not(.hidden) .collection')
    const field = pane.querySelector('input[aria-label="搜索内容"]')
    const grid = pane.querySelector('.grid-scroller')
    const count = () => Number.parseInt(pane.querySelector('.toolbar-count').textContent, 10)
    const type = value => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(field, value)
      field.dispatchEvent(new Event('input', { bubbles: true }))
    }
    const frame = () => new Promise(requestAnimationFrame)
    const until = async (check, label) => {
      const start = performance.now()
      while (!check()) {
        if (performance.now() - start > 45000) throw Error('等待超时 ' + label)
        await frame()
      }
    }
    const cards = () => {
      const bounds = grid.getBoundingClientRect()
      return [...grid.querySelectorAll('.card')].filter(card => {
        const rect = card.getBoundingClientRect()
        return rect.bottom > bounds.top && rect.top < bounds.bottom
      })
    }
    const imageReady = card => {
      const image = card.querySelector('img')
      return image?.complete && image.naturalWidth > 0
    }
    const original = MessagePort.prototype.postMessage
    let sample
    MessagePort.prototype.postMessage = function(msg, ...args) {
      if (sample && msg?.method === 'query' && msg.args[0]?.role === 'browse' && !msg.args[0]?.search?.length && !msg.args[0]?.text) {
        const current = sample, sent = performance.now()
        const received = ev => {
          if (ev.data.id !== msg.id) return
          this.removeEventListener('message', received, true)
          if (ev.data.result?.ids.length === ${fixture.count}) {
            current.sent = sent
            current.received = performance.now()
          }
        }
        this.addEventListener('message', received, true)
      }
      return original.call(this, msg, ...args)
    }
    window.__gridBenchmark = {
      async search() {
        type('perfneedle')
        await until(() => count() === ${fixture.noteMatches}, '搜索命中数')
        grid.scrollTop = Math.min(grid.scrollHeight - grid.clientHeight, 7 * grid.clientHeight)
        await frame(); await frame()
        let target
        await until(() => target = cards().find(c => imageReady(c) && c.querySelector('.card-caption')?.title), '搜索结果缩略图')
        target.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}))
        await until(() => target.classList.contains('selected'), '选中搜索结果')
      },
      async clear(method) {
        const s = sample = { start: performance.now() }
        if (method === 'button') pane.querySelector('.search-clear').click()
        else type('')
        await until(() => count() === ${fixture.count}, '全库数量')
        const committed = performance.now()
        let visible
        await until(() => {
          visible = cards()
          return visible.length && visible.every(imageReady)
            && visible.some(c => Number(/bench-(\\d+)/.exec(c.querySelector('.card-caption')?.title)?.[1]) % 10 > 0)
        }, '全库可见素材及缩略图')
        await frame(); await frame()
        const end = performance.now()
        sample = undefined
        if (!(s.sent >= s.start && s.received >= s.sent && committed >= s.received)) throw Error('未捕获本次全库查询')
        return { inputToSend: s.sent-s.start, queryRoundTrip: s.received-s.sent, replyToGrid: committed-s.received,
          gridToImages: end-committed, total: end-s.start, visibleCards: visible.length }
      },
      stop() { MessagePort.prototype.postMessage = original; delete window.__gridBenchmark }
    }
  })()`)
  try {
    for (let index = 0; index < repeats * 4; index++) {
      // 每四轮覆盖两种清空入口、空闲和刷新；第二组交换执行顺序。
      const slot = Math.floor(index / 4) % 2 ? 3 - index % 4 : index % 4
      const refreshed = slot === 1 || slot === 2, method = slot < 2 ? 'input' : 'button'
      const refresh = refreshed ? callCore(lib.core, 'refreshFileSpace', fixture.spaces[0].id) : Promise.resolve()
      await Promise.all([refresh, js('window.__gridBenchmark.search()')])
      if (refreshed) await callCore(lib.core, 'get', [])
      const timing = await js(`window.__gridBenchmark.clear(${JSON.stringify(method)})`)
      samples.push({ refreshed, method, ...timing })
    }
    assert.equal(samples.length, repeats * 4)
    return samples
  } finally { await js('window.__gridBenchmark.stop()') }
}
