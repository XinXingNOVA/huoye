// 大库里前台浏览和后台写入共用生产入口；所有时间戳相对当前阶段开始。
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import sharp from 'sharp'
import { callCore } from '../../src/main/core-client'
import type { OpenLibrary } from '../../src/main/libraries'
import type { PerformanceFixture } from './fixture'

type Span = { action: string; startMs: number; endMs: number; error?: string }

export async function dailyFlow(lib: OpenLibrary, fixture: PerformanceFixture, dir: string, memory: (stage: string) => void) {
  const js = (source: string) => lib.win.webContents.executeJavaScript(source)
  const until = async (check: () => Promise<unknown>, label: string) => {
    const start = performance.now()
    while (!await check()) {
      if (performance.now() - start > 120000) throw new Error('等待超时：' + label)
      await delay(25)
    }
  }
  const frames = () => js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  const pane = "document.querySelector('.tab-pane:not(.hidden) .collection')"
  const countReady = (count: number) => until(() => js(`${pane}?.querySelector('.toolbar-count')?.textContent.trim() === '${count} 项'`), '工作台数量 ' + count)
  const search = async (text: string, count: number) => {
    await js(`(() => {
      const input = ${pane}.querySelector('input[aria-label="搜索内容"]')
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(text)})
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })()`)
    await countReady(count)
    await frames()
  }
  const visibleCards = `const grid = ${pane}.querySelector('.grid-scroller')
    const bounds = grid.getBoundingClientRect()
    const cards = [...grid.querySelectorAll('.card')].filter(card => {
      const r = card.getBoundingClientRect()
      return r.top >= bounds.top && r.bottom <= bounds.bottom
    })`
  const paths: string[] = []
  for (let i = 0; i < 50; i++) {
    const path = join(dir, 'daily-' + i + '.png')
    await sharp({ create: { width: 1600, height: 1000, channels: 3, background: { r: i * 5, g: 100, b: 160 } } }).png().toFile(path)
    paths.push(path)
  }
  const stages = []
  let expected = fixture.count
  for (const [index, mode] of (['idle', 'import', 'refresh'] as const).entries()) {
    const samples: Span[] = [], probes: Span[] = []
    const origin = performance.now()
    const now = () => Math.round((performance.now() - origin) * 10) / 10
    const time = async <T>(action: string, work: () => Promise<T>) => {
      const startMs = now()
      try {
        const result = await work()
        samples.push({ action, startMs, endMs: now() })
        return result
      } catch (error) {
        samples.push({ action, startMs, endMs: now(), error: String(error) })
        throw error
      }
    }
    const background = async () => {
      if (mode === 'refresh') {
        // 调用超时本身也是结果。后续 UI 与核心读回仍必须成功。
        try { await time('refresh-rpc', () => callCore(lib.core, 'refreshFileSpace', fixture.spaces[0].id)) }
        catch (error) { if (!String(error).includes('[TIMEOUT]')) throw error }
      }
      if (mode !== 'import') return
      let ids: string[] = []
      try {
        const report = await time('import-ack', () => callCore(lib.core, 'importToLibrary',
          paths.map(path => ({ type: 'file', path })), { requestId: randomUUID() }))
        assert.equal(report.errors.length, 0)
        ids = report.items.map(item => item.id)
      } catch (error) {
        if (!String(error).includes('[TIMEOUT]')) throw error
        // 回执超时仍可能已经提交。在独立夹具内按原有身份求差，绝不重发导入。
        const existing = new Set(fixture.ids)
        await time('recover-import-ids', () => until(async () => {
          ids = (await callCore(lib.core, 'query', {})).ids.filter(id => !existing.has(id))
          return ids.length === paths.length
        }, '回读导入身份'))
      }
      assert.equal(new Set(ids).size, 50)
      await time('processing-after-ack', () => until(async () => {
        const status = await callCore(lib.core, 'processingStatus', { ids, kinds: ['thumb', 'palette'] })
        assert.equal(status.items.length, 50)
        for (const item of status.items) {
          assert.equal(item.kinds.length, 2)
          assert(item.kinds.every(k => k.state === 'pending' || k.state === 'ready'), JSON.stringify(item))
        }
        return status.items.every(item => item.kinds.every(k => k.state === 'ready'))
      }, '50 张新图的缩略图与色板'))
      expected += 50
    }
    const browse = async () => {
      await time('search-to-result', () => search('perfneedle', fixture.noteMatches))
      const target = await time('scroll-to-thumbnail', async () => {
        const position = await js(`(() => {
          ${visibleCards}
          const old = cards.map(c => c.dataset.entityId)
          const top = Math.min(grid.scrollHeight - grid.clientHeight, grid.clientHeight * ${3 + index * 2})
          grid.scrollTop = top
          return { old, top }
        })()`)
        assert(position.top > 0)
        let card: { id: string; title: string } | undefined
        await until(async () => {
          card = await js(`(() => {
            ${visibleCards}
            if (Math.abs(grid.scrollTop - ${position.top}) > 1) return null
            const c = cards.find(c => !${JSON.stringify(position.old)}.includes(c.dataset.entityId) &&
              c.querySelector('.card-caption')?.title && c.querySelector('img')?.naturalWidth > 0)
            return c && { id: c.dataset.entityId, title: c.querySelector('.card-caption').title }
          })()`)
          return card
        }, '滚动后的新素材缩略图')
        await frames()
        return card!
      })
      await time('click-to-detail', async () => {
        await js(`${pane}.querySelector('.card[data-entity-id="${target.id}"]').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))`)
        await until(() => js(`[...document.querySelectorAll('.inspector-title')].some(el =>
          el.checkVisibility() && el.textContent.trim() === ${JSON.stringify(target.title)}) &&
          !!${pane}.querySelector('.card.selected[data-entity-id="${target.id}"]')`), '选中卡片并显示对应详情')
        await frames()
      })
    }
    let running = true
    const work = background()
    const probe = (async () => {
      while (running) {
        const startMs = now()
        try { await callCore(lib.core, 'get', []); probes.push({ action: 'get', startMs, endMs: now() }) }
        catch (error) { probes.push({ action: 'get', startMs, endMs: now(), error: String(error) }) }
        await delay(250)
      }
    })()
    try {
      const outcomes = await Promise.allSettled([work, browse()])
      for (const outcome of outcomes) if (outcome.status === 'rejected') throw outcome.reason
    } finally {
      running = false
      await probe
      console.log('[daily measurements]', fixture.count, mode, JSON.stringify({ samples, probes }))
    }
    await time('clear-to-full-grid', () => search('', expected))
    memory(mode)
    console.log('[daily]', fixture.count, mode, JSON.stringify(samples))
    stages.push({ mode, samples, probes })
  }
  await delay(30000)
  memory('idle-30s')
  assert.equal((await callCore(lib.core, 'query', {})).ids.length, expected)
  return { stages, imported: expected - fixture.count, finalCount: expected }
}
