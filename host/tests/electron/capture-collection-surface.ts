import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dialog, type BrowserWindow } from 'electron'
import sharp from 'sharp'
import { callCore } from '../../src/main/core-client'
import { libraryOf } from '../../src/main/libraries'

/** 外部示例只使用公共入口；用真实窗口检验动态范围、共享角标与窗口输入边界。 */
export async function collectionSurfaceFlow(win: BrowserWindow, dir: string) {
  const lib = libraryOf(win.webContents)!, js = (code: string): Promise<any> => win.webContents.executeJavaScript(code)
  const wait = (ms = 120) => new Promise(resolve => setTimeout(resolve, ms))
  const until = async (code: string) => { for (let n = 0; n < 100; n++) { if (await js(code)) return; await wait() } throw new Error('未完成：' + code) }
  const pane = "document.querySelector('.tab-pane:not(.hidden)')"
  const click = async (text: string) => {
    await until(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.checkVisibility()&&b.textContent.trim()===${JSON.stringify(text)});if(!b||b.disabled)return false;b.click();return true})()`)
  }
  const workspace = () => js(`window.bridge.loadWorkspace(${JSON.stringify(lib.id)})`)
  const picker = dialog.showOpenDialog
  try {
    if (process.env.CAPTURE_FLOW === 'collectionsurfaceresume') {
      const saved = JSON.parse(readFileSync(join(dir, 'collection-surface-saved.json'), 'utf8'))
      await until(`${pane}?.querySelector('.search-input')?.value===${JSON.stringify(saved.search)}`)
      await until(`${pane}?.querySelector('.toolbar-count')?.textContent.trim()==='1 项'`)
      assert.equal(await js(`${pane}.querySelectorAll('[data-entity-id]').length`), 1)
      assert.equal(await js(`${pane}.querySelector('.view-menu')`), null)
      assert(!await js(`${pane}.textContent.includes('本机示例标记')`), '本机状态不应变成业务数据或页面草稿')
      const w = await workspace(), tab = w.tabs.find((t: any) => t.type === 'demo-collection.page')
      assert.equal(tab.state.search, saved.search); assert.equal(tab.params.query.ids, undefined)
      await click('清空范围'); await until(`${pane}.querySelector('.toolbar-count').textContent.trim()==='0 项'`)
      writeFileSync(join(dir, 'collectionsurfaceresume-result.json'), JSON.stringify({ ok: true })); return
    }
    const names = ['集合封面.png', '集合说明.md', '集合文字.txt'], files = names.map(name => join(dir, name))
    await sharp({ create: { width: 90, height: 60, channels: 3, background: '#609eb3' } }).png().toFile(files[0])
    writeFileSync(files[1], '# 集合说明'); writeFileSync(files[2], '集合文字')
    const imported = await callCore(lib.core, 'importToLibrary', files.map(path => ({ type: 'file', path })), { requestId: randomUUID() })
    assert.equal(imported.errors.length, 0)
    const ids = imported.items.map(v => v.id)
    for (let i = 0; i < 80; i++) { if ((await callCore(lib.core, 'get', ids)).every(v => v.blocks.image || v.blocks.body)) break; await wait() }
    assert((await callCore(lib.core, 'get', ids)).every(v => v.blocks.image || v.blocks.body), '新文件原生加工')
    await click('动态集合示例')
    await until(`${pane}.querySelector('.toolbar-count')?.textContent.trim()==='2 项'`)
    assert.equal(await js(`${pane}.querySelectorAll('.card').length`), 2)
    assert.equal(await js(`${pane}.querySelectorAll('.view-menu').length`), 0)
    const visible: string[] = await js(`[...${pane}.querySelectorAll('.card')].map(c=>c.dataset.entityId)`)
    const first = visible[0], card = `${pane}.querySelector('[data-entity-id="${first}"]')`
    const before = await callCore(lib.core, 'get', ids)
    await js(`${card}.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}))`)
    await until(`${pane}.querySelector('.demo-collection-toolbar')?.textContent.includes('已选 1 项')`)
    await js(`${card}.dispatchEvent(new MouseEvent('dblclick',{bubbles:true,button:0}))`)
    await until(`${pane}.querySelector('[data-demo-opened]')?.dataset.demoOpened===${JSON.stringify(first)}`)
    await click('切换本机角标')
    await until(`${card}.textContent.includes('本机示例标记')`)
    assert(await js(`${card}.textContent.includes('静态示例')`))
    assert.deepEqual(await callCore(lib.core, 'get', ids), before, '本机角标不能写业务数据')

    // 三条收录输入及新建走同一静态声明，在文件选择／剪贴板读取前拒绝。
    let picks = 0
    dialog.showOpenDialog = (async () => { picks++; return { canceled: false, filePaths: [files[0]] } }) as typeof dialog.showOpenDialog
    win.webContents.send('menu:command', 'import')
    await until("document.querySelector('.toast')?.textContent.includes('动态集合示例只展示临时范围')")
    assert.equal(picks, 0)
    win.webContents.send('menu:command', 'new')
    await wait(200)
    await js(`(()=>{const dt=new DataTransfer();dt.setData('text/plain','不应被收录的文字');window.dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}))})()`)
    await wait(200)
    const dropEffect = await js(`(()=>{const dt=new DataTransfer();dt.setData('text/plain','不应被拖入的文字');const el=${pane}.querySelector('.collection');el.dispatchEvent(new DragEvent('dragenter',{bubbles:true,cancelable:true,dataTransfer:dt}));el.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:dt}));return dt.dropEffect})()`)
    assert.equal(dropEffect, 'none')
    await until("document.querySelector('.drop-overlay')?.textContent.includes('动态集合示例只展示临时范围')")
    await js(`(()=>{const dt=new DataTransfer();dt.setData('text/plain','不应被拖入的文字');${pane}.querySelector('.collection').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt}))})()`)
    await wait(300)
    assert.equal((await callCore(lib.core, 'query', { scope: 'content' })).ids.length, 3)
    assert.deepEqual(await callCore(lib.core, 'get', ids), before)

    await click('清空范围'); await until(`${pane}.querySelector('.toolbar-count').textContent.trim()==='0 项'`)
    assert.equal(await js(`${pane}.querySelectorAll('.card').length`), 0)
    await click('恢复范围'); await until(`${pane}.querySelector('.toolbar-count').textContent.trim()==='2 项'`)
    const search = String(before.find(v => v.id === first)!.blocks.file.data.name)
    await js(`(()=>{const input=${pane}.querySelector('.search-input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(search)});input.dispatchEvent(new Event('input',{bubbles:true}))})()`)
    await until(`${pane}.querySelector('.toolbar-count').textContent.trim()==='1 项'`)
    await wait(700)
    const w = await workspace(), tab = w.tabs.find((t: any) => t.type === 'demo-collection.page')
    assert.equal(tab.state.search, search); assert.equal(tab.params.query.ids, undefined)
    win.setSize(960, 760); await wait(200)
    assert(await js('document.documentElement.scrollWidth <= innerWidth'))
    writeFileSync(join(dir, 'collection-surface.png'), (await win.webContents.capturePage()).toPNG())
    writeFileSync(join(dir, 'collection-surface-saved.json'), JSON.stringify({ search }))
    writeFileSync(join(dir, 'collectionsurface-result.json'), JSON.stringify({ ok: true, checks: ['外部包加载', '动态范围', '查询选择', '自定义打开', '静态与动态角标', '拒绝输入', '空范围', '临时状态存档'] }))
  } catch (e) {
    writeFileSync(join(dir, 'collection-surface-error.txt'), String(e) + '\n' + await js('document.body.innerText'))
    writeFileSync(join(dir, 'collection-surface-error.png'), (await win.webContents.capturePage()).toPNG()); throw e
  } finally { dialog.showOpenDialog = picker }
}
