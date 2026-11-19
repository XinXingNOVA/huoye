import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import type { BrowserWindow } from 'electron'
import { openLibraries, openLibrary, allClosed } from '../../src/main/libraries'
import { callCore } from '../../src/main/core-client'
import { SpaceDisposal } from '../../src/storage/space-disposal'

export async function itemDisposalFlow(win: BrowserWindow, dir: string, chooseMenu: (text: string) => void) {
  const lib = openLibraries().find(l => l.win === win)!
  const js = (code: string): Promise<any> => win.webContents.executeJavaScript(code)
  const until = async (fn: () => Promise<unknown>, label: string) => {
    for (let i = 0; i < 250; i++) { if (await fn()) return; await new Promise(r => setTimeout(r, 100)) }
    throw new Error(label)
  }
  const click = (text: string, selector = 'button,.nav-item') => until(() => js(`(()=>{const b=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>e.checkVisibility()&&e.textContent.trim()===${JSON.stringify(text)});if(!b||b.disabled)return false;b.click();return true})()`), '不能点击 ' + text)
  const shot = async (name: string) => { writeFileSync(join(dir, name + '.png'), (await win.webContents.capturePage()).toPNG()) }
  const flow = process.env.CAPTURE_FLOW!
  try {
    if (flow === 'itemdisposalresume') {
      const state = JSON.parse(readFileSync(join(dir, 'itemdisposal-state.json'), 'utf8'))
      await click('文件空间')
      await until(() => js("(()=>{const b=document.querySelector('.space-tabs [aria-label=记录管理]');if(!b)return false;b.click();return true})()"), '记录管理')
      await click('组合删除记录…')
      await until(() => js("document.querySelector('.item-disposal-dialog')?.textContent.includes('1 / 2 个完成')"), '重启后没有读取原件回执')
      assert((await callCore(lib.core, 'get', state.ids)).every(v => !v.deletedAt))
      await click('预览剩余操作…')
      await until(() => js("document.querySelector('.item-disposal-dialog')?.textContent.includes('1 个原件待处置，1 个已完成')"), '接续未跳过已完成文件')
      await shot('itemdisposal-resume-preview')
      await click('确认处置并回收素材')
      await until(() => js("document.querySelector('.item-disposal-result')?.textContent.includes('仓库素材：已移入回收站')"), '组合删除未完成')
      const values = await callCore(lib.core, 'get', state.ids)
      assert(values.every(v => v.deletedAt && v.blocks.note.data.text === '组合删除后保留的笔记'))
      for (const id of state.ids) assert.equal((await callCore(lib.core, 'fileStorageInfo', id)).lifecycle, 'disposed')
      const other = await openLibrary(state.otherRoot, { show: false })
      try {
        assert(!(await callCore(other.core, 'get', [state.otherId]))[0].deletedAt)
        assert.equal((await callCore(other.core, 'fileStorageInfo', state.otherId)).lifecycle, 'disposed')
      } finally { other.win.close(); await until(async () => other.win.isDestroyed(), 'B 未关闭'); await allClosed() }
      await shot('itemdisposal-complete')
      await callCore(lib.core, 'undo')
      assert((await callCore(lib.core, 'get', state.ids)).every(v => !v.deletedAt), '仓库撤销没有恢复记录')
      await click('关闭'); await click('组合删除记录…')
      assert(!(await js("document.querySelector('.item-disposal-dialog')?.textContent.includes('预览剩余操作')")), '已完成任务不应重新删除撤销的素材')
      writeFileSync(join(dir, flow + '-result.json'), JSON.stringify({ ok: true, checks: ['重启只读回执', '重新预览剩余操作', '跨两空间完成原件处置', '仓库记录单步撤销', '另一仓库身份保留'] }))
      return
    }
    const privateSpace = (await callCore(lib.core, 'listFileSpaces')).find(s => s.default)!
    const shared = await js(`window.bridge.spaces.create(${JSON.stringify(dir)},'组合处置共享空间','shared')`)
    await callCore(lib.core, 'linkFileSpace', shared.root)
    const ids: string[] = []
    for (const [index, space] of [privateSpace, shared].entries()) {
      const path = join(dir, `组合处置-${index}.png`)
      await sharp({ create: { width: 160, height: 100, channels: 3, background: index ? '#aa6655' : '#5599aa' } }).png().toFile(path)
      const imported = await callCore(lib.core, 'importToLibrary', [{ type: 'file', path }], { spaceId: space.id, requestId: randomUUID() })
      assert.equal(imported.errors.length, 0); ids.push(imported.items[0].id)
    }
    await until(async () => (await callCore(lib.core, 'get', ids)).every(v => v.blocks.thumb && v.blocks.image), '新 PNG 未经 utilityProcess 完整加工')
    for (const id of ids) await callCore(lib.core, 'put', id, 'note', { text: '组合删除后保留的笔记' })
    const otherRoot = join(dir, '共享引用库.library'), other = await openLibrary(otherRoot, { show: false })
    const sharedFile = (await callCore(lib.core, 'itemDisposalSnapshot', [ids[1]])).files[0]
    let otherId: string
    try {
      await callCore(other.core, 'linkFileSpace', shared.root)
      const file = (await callCore(other.core, 'listSpaceFiles', { spaceId: shared.id })).items.find(f => f.id === sharedFile.fileId)!
      const adoption = await callCore(other.core, 'adoptSpaceFiles', { spaceId: shared.id, files: [{ id: file.id, revision: file.revision }], requestId: randomUUID() })
      otherId = (adoption.result as { items: { id: string }[] }).items[0].id
    } finally { other.win.close(); await until(async () => other.win.isDestroyed(), 'B 未关闭'); await allClosed() }
    writeFileSync(join(dir, 'itemdisposal-state.json'), JSON.stringify({ ids, otherRoot, otherId, roots: [privateSpace.root, shared.root] }))
    const openDialog = async () => {
      await until(() => js(`${JSON.stringify(ids)}.every(id=>[...document.querySelectorAll('.card')].some(c=>c.checkVisibility()&&c.dataset.entityId===id))`), '卡片未显示')
      await js("window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))")
      for (const [index, id] of ids.entries()) await js(`(()=>{const c=[...document.querySelectorAll('.card')].find(c=>c.checkVisibility()&&c.dataset.entityId===${JSON.stringify(id)});c.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0,metaKey:${index > 0}}))})()`)
      chooseMenu('连同原件移到系统废纸篓')
      await js(`(()=>{const c=[...document.querySelectorAll('.card')].find(c=>c.checkVisibility()&&c.dataset.entityId===${JSON.stringify(ids[0])});c.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:2}));c.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2}))})()`)
      await until(() => js("document.querySelector('.item-disposal-dialog')?.textContent.includes('2 个原件待处置')"), '未显示两项组合删除预览')
    }
    await openDialog()
    assert(await js("document.querySelector('.item-disposal-dialog').textContent.includes('关联 2 个仓库')"))
    await shot('itemdisposal-preview')
    win.setSize(760, 640)
    assert(await js("(()=>{const d=document.querySelector('.item-disposal-dialog'),r=d.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight&&d.scrollWidth<=d.clientWidth&&d.querySelector('footer').getBoundingClientRect().bottom<=innerHeight})()"), '窄窗口弹窗越界')
    await shot('itemdisposal-narrow')
    await click('取消', '.item-disposal-dialog button')
    for (const id of ids) assert.equal((await callCore(lib.core, 'fileStorageInfo', id)).lifecycle, 'active')
    await openDialog()
    // 实际完成第一个空间的系统移动后，模拟响应丢失；应用不能据此删除本库素材。
    const original = SpaceDisposal.prototype.execute
    SpaceDisposal.prototype.execute = async function(input) { await original.call(this, input); throw new Error('验收注入：空间提交后响应丢失') }
    try {
      await click('确认处置并回收素材')
      await until(() => js("document.querySelector('.item-disposal-result')?.textContent.includes('响应丢失')"), '未显示中断结果')
    } finally { SpaceDisposal.prototype.execute = original }
    assert((await callCore(lib.core, 'get', ids)).every(v => !v.deletedAt))
    const tasks = await js('window.bridge.itemDisposal.list()')
    assert.equal(tasks[0].completed, 1)
    await shot('itemdisposal-interrupted')
    writeFileSync(join(dir, flow + '-result.json'), JSON.stringify({ ok: true, checks: ['新 PNG 真实导入加工', '原件跨两空间', '两库共享引用提示', '右键多选预览和取消', '宽窄窗口', '真实系统移动后的响应丢失'] }))
  } catch (e) {
    writeFileSync(join(dir, flow + '-error.txt'), String(e) + '\n' + await js('document.body.innerText')); await shot(flow + '-error'); throw e
  }
}
