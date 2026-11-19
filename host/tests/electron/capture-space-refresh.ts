import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { closeSync, fstatSync, openSync, readSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import type { BrowserWindow } from 'electron'
import { openLibraries } from '../../src/main/libraries'
import { callCore } from '../../src/main/core-client'
import { imagePdf } from '../helpers/image-pdf'

/** 新版随库独享空间：清理另一文件，不应重算原有 PDF，也不应让列表等待失联的核心。 */
export async function spaceRefreshFlow(win: BrowserWindow, dir: string) {
  const lib = openLibraries().find(l => l.win === win)!
  let exited = false, intentionalExit = false
  lib.core.once('exit', code => { if (!intentionalExit) { exited = true; writeFileSync(join(dir, 'core-exit.json'), JSON.stringify({ code })) } })
  const js = (code: string): Promise<any> => win.webContents.executeJavaScript(code)
  const visiblePanel = "[...document.querySelectorAll('.space-content')].find(e=>e.checkVisibility())"
  const until = async (check: () => Promise<unknown>, label: string) => {
    for (let n = 0; n < 300; n++) { if (exited) throw new Error('核心进程已退出：' + label); if (await check()) return; await new Promise(r => setTimeout(r, 100)) }
    throw new Error(label)
  }
  const click = (label: string, selector = 'button,.nav-item,summary') => until(() => js(`(()=>{const e=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>e.checkVisibility()&&(e.getAttribute('aria-label')||e.textContent.trim())===${JSON.stringify(label)});if(!e||e.disabled)return false;e.click();return true})()`), '不能点击 ' + label)
  const settled = (ids: string[]) => until(async () => {
    for (const id of ids) if ((await callCore(lib.core, 'readItem', { id })).processing !== 'idle') return false
    return true
  }, '加工没有收尾')
  const snapshot = async (ids: string[]) => (await callCore(lib.core, 'get', ids)).map(v => ({ id: v.id, still: v.blocks.still?.seq, thumb: v.blocks.thumb?.seq }))
  const pageReady = () => until(() => js(`(()=>{const p=${visiblePanel};return p&&!p.textContent.includes('读取文件…')&&[...p.querySelectorAll('button')].some(b=>b.textContent==='检查并刷新'&&!b.disabled)})()`), '列表一直显示读取文件')
  try {
    const space = (await callCore(lib.core, 'listFileSpaces')).find(s => s.default)!
    assert(space.embedded && space.versioned)
    writeFileSync(join(dir, 'refresh-space.json'), JSON.stringify({ root: space.root }))
    const sources: string[] = []
    for (let n = 0; n < 18; n++) {
      const jpeg = await sharp(randomBytes(600 * 800 * 3), { raw: { width: 600, height: 800, channels: 3 } }).jpeg({ quality: 85 }).toBuffer()
      const path = join(dir, `保留的文档-${n}.pdf`); writeFileSync(path, imagePdf(jpeg, 600, 800)); sources.push(path)
    }
    const imported = await callCore(lib.core, 'importToLibrary', sources.map(path => ({ type: 'file', path })), { requestId: randomUUID() })
    assert.equal(imported.errors.length, 0)
    const ids = imported.items.map(i => i.id); await settled(ids)
    const before = await snapshot(ids)
    assert(before.every(v => v.still && v.thumb), 'PDF 未完整生成代表图和缩略图')
    writeFileSync(join(dir, 'refresh-before.json'), JSON.stringify(before))
    const path = join(dir, '仅处置这个文件.png')
    await sharp({ create: { width: 120, height: 80, channels: 3, background: '#5588aa' } }).png().toFile(path)
    const target = await callCore(lib.core, 'importToLibrary', [{ type: 'file', path }], { requestId: randomUUID() })
    await settled(target.items.map(i => i.id))
    // 对齐用户场景：仓库已清理素材，只在空间留下原件；不触碰 PDF。
    await callCore(lib.core, 'trash', target.items.map(i => i.id))
    await callCore(lib.core, 'purge', target.items.map(i => i.id))
    await click('文件空间'); await pageReady()
    const choose = () => until(() => js(`(()=>{const p=${visiblePanel};const i=[...p.querySelectorAll('.space-file')].find(e=>e.textContent.includes('仅处置这个文件.png'))?.querySelector('input');if(!i||i.disabled)return false;if(!i.checked)i.click();return true})()`), '不能选择测试文件')
    const results: unknown[] = []
    for (const action of ['移到系统废纸篓', '清理版本明细']) {
      if (action === '清理版本明细') await click('记录管理')
      await pageReady(); await choose()
      if (action === '清理版本明细') await click('记录操作')
      await click(action + '…'); await click('确认' + action)
      await until(() => js(`(${visiblePanel})?.textContent.includes('1 项完成，0 项未完成')`), '操作未完成')
      await pageReady(); await settled(ids)
      const after = await snapshot(ids), recomputed = after.filter((v, i) => JSON.stringify(v) !== JSON.stringify(before[i])).length
      results.push({ action, recomputed, coreAlive: !exited }); writeFileSync(join(dir, 'refresh-observed.json'), JSON.stringify(results, null, 2))
      console.log('[space-refresh]', action, '未改动 PDF 重算', recomputed, '/', ids.length)
    }
    assert(results.every(r => (r as { recomputed: number }).recomputed === 0), '处置其他文件导致未改动 PDF 全量重新加工')
    // 显式重新生成仍是合法入口；旧文件描述符在发布期间保持完整，未原位截断 JPEG / WebP。
    const v = (await callCore(lib.core, 'get', [ids[0]]))[0]
    const readers = ['still', 'thumb'].map(kind => {
      const path = join(lib.root, String(v.blocks[kind].data.path)), fd = openSync(path, 'r'), stat = fstatSync(fd)
      const bytes = Buffer.alloc(stat.size); readSync(fd, bytes, 0, bytes.length, 0)
      return { path, fd, stat, bytes }
    })
    try {
      for (let n = 0; n < 2; n++) { await callCore(lib.core, 'regenerate', ids); await settled(ids) }
      for (const r of readers) {
        assert.notEqual(statSync(r.path).ino, r.stat.ino, '派生缓存仍在原位改写')
        const bytes = Buffer.alloc(r.bytes.length); assert.equal(readSync(r.fd, bytes, 0, bytes.length, 0), bytes.length)
        assert.deepEqual(bytes, r.bytes, '读取中的旧缓存被改写')
      }
    } finally { readers.forEach(r => closeSync(r.fd)) }
    // 模拟后台意外退出；页面下一次读取必须结束等待并提供重载，不自动重发写操作。
    intentionalExit = true
    const oldCore = lib.core, stopped = new Promise<void>(resolve => oldCore.once('exit', () => resolve()))
    oldCore.kill(); await stopped
    await click('空间回收站')
    await until(() => js(`(${visiblePanel})?.textContent.includes('[LIBRARY_OFFLINE]')&&!(${visiblePanel})?.textContent.includes('读取文件…')`), '后台退出仍一直等待')
    writeFileSync(join(dir, 'refresh-offline.png'), (await win.webContents.capturePage()).toPNG())
    await click('重新加载仓库')
    await until(async () => lib.core !== oldCore && !lib.reloading && await js("!!document.querySelector('.tabbar')"), '仓库重载失败')
    assert.equal((await callCore(lib.core, 'get', ids)).length, 18)
    writeFileSync(join(dir, 'spacerefresh-result.json'), JSON.stringify({ ok: true, results, checks: ['缓存原子发布', '两轮显式重生成', '后台退出结束读取', '界面重载恢复'] }))
  } catch (error) {
    writeFileSync(join(dir, 'refresh-error.txt'), String(error) + '\n' + await js('document.body.innerText'))
    writeFileSync(join(dir, 'refresh-error.png'), (await win.webContents.capturePage()).toPNG())
    throw error
  }
}
