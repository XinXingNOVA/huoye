import assert from 'node:assert/strict'
import { executeUiCommand } from './capture-command'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import type { BrowserWindow } from 'electron'
import { libraryOf } from '../../src/main/libraries'
import { callCore } from '../../src/main/core-client'
import type { CoreApi } from '../../src/shared/rpc'
interface Tools { js(code: string): Promise<any>; shot(name: string): Promise<void>; chooseMenu(label: string): void }
export async function queryViewsFlow(win: BrowserWindow, dir: string, { js, shot, chooseMenu }: Tools) {
  const wait = (ms = 120) => new Promise(resolve => setTimeout(resolve, ms))
  const until = async (code: string) => { for (let i = 0; i < 100; i++) { if (await js(code)) return; await wait() } throw new Error(`界面未就绪：${code}`) }
  const call = <K extends keyof CoreApi>(method: K, ...args: Parameters<CoreApi[K]>) => callCore(libraryOf(win.webContents)!.core, method, ...args)
  const snapshot = async () => { await wait(600); return js(`window.bridge.loadWorkspace(${JSON.stringify(libraryOf(win.webContents)!.id)})`) }
  const click = async (selector: string) => { await js(`document.querySelector(${JSON.stringify(selector)}).click()`); await wait() }
  const button = async (scope: string, title: string) => { await js(`[...document.querySelectorAll(${JSON.stringify(scope + ' button')})].find(b=>b.textContent.trim()===${JSON.stringify(title)}).click()`); await wait() }
  const input = async (label: string, value: string, select = false) => { await js(`(()=>{const el=document.querySelector('[aria-label="${label}"]');Object.getOwnPropertyDescriptor(${select ? 'HTMLSelectElement' : 'HTMLInputElement'}.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('${select ? 'change' : 'input'}',{bubbles:true}))})()`); await wait() }
  const activate = async (id: string) => { await js(`document.querySelector('[data-tab="${id}"]').dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}))`); await wait() }
  const pane = (id: string) => `[data-tab-content="${id}"]`
  await until(`!!document.querySelector('.editor-group')`)
  if (process.env.CAPTURE_FLOW === 'queryviewsresume') {
    const expected = JSON.parse(readFileSync(join(dir, 'query-views-expected.json'), 'utf8'))
    const ws = await snapshot()
    assert(ws.tabs.some((t: any) => t.params.viewId === expected.viewId && t.params.title === '参考测试新版'))
    assert.deepEqual(((await call('get', [expected.viewId]))[0].blocks.view.data.query as { where: unknown }).where, [{ op: 'in', kind: 'file', field: 'ext', values: ['png', 'md'] }])
    await until(`document.querySelectorAll('[data-view-section="pinned"] [data-saved-view]').length===2`)
    assert.deepEqual(await js(`[...document.querySelectorAll('[data-view-section="pinned"] [data-saved-view]')].map(el=>el.dataset.savedView)`), expected.pinned)
    assert.equal(await js(`document.querySelector('[data-view-section="saved"] [data-saved-view]')?.dataset.savedView`), expected.extra)
    await shot('query-views-resume.png')
  } else {
    const png = join(dir, 'a.png'), md = join(dir, 'b.md')
    await sharp({ create: { width: 45, height: 30, channels: 3, background: '#6699cc' } }).png().toFile(png)
    writeFileSync(md, '# newly imported markdown\nThis is a fresh file.')
    const imported = await call('importToLibrary', [{ type: 'file', path: png }, { type: 'file', path: md }], { requestId: 'query-views-seed' })
    assert.equal(imported.items.length, 2)
    const pngId = imported.items[0].id
    for (let i = 0; i < 80; i++) { if ((await call('get', [pngId]))[0].blocks.image) break; await wait() }
    assert((await call('get', [pngId]))[0].blocks.image, 'Electron 新文件加工')
    const source = (await snapshot()).active
    await click('[aria-label="新建视图"]')
    await input('视图名称', '参考测试')
    await button('dialog', '＋添加条件')
    await input('条件数据块', 'file', true); await input('条件字段', 'ext', true); await input('条件运算', 'in', true)
    await input('条件值', 'png'); await button('dialog', '添加值')
    await input('条件值', 'md'); await button('dialog', '确定条件')
    await input('排序字段', JSON.stringify(['file', 'name']), true)
    await input('排序顺序', 'asc', true)
    await shot('query-view-editor.png')
    await button('dialog', '保存视图')
    await until(`!document.querySelector('dialog')`)
    const first = (await snapshot()).active, viewId = (await snapshot()).tabs.find((t: any) => t.id === first).params.viewId
    await until(`document.querySelector('${pane(first)} .toolbar-count')?.textContent.trim()==='2 项'`)
    assert.deepEqual((await call('searchPage', { query: { where: [{ op: 'in', kind: 'file', field: 'ext', values: ['png', 'md'] }] } })).items.map(i => i.id).sort(), imported.items.map(i => i.id).sort())
    // 第二个打开页共享保存规则，但临时筛选不共享。
    await js(`[...document.querySelectorAll('.view-item .nav-label')].find(b=>b.textContent==='参考测试').dispatchEvent(new MouseEvent('click',{bubbles:true,metaKey:true}))`)
    const second = (await snapshot()).active
    assert.notEqual(first, second)
    await button(pane(second), '＋筛选'); await button('dialog', '＋添加条件')
    await input('条件数据块', 'image', true); await button('dialog', '确定条件'); await button('dialog', '应用筛选')
    await until(`document.querySelector('${pane(second)} .toolbar-count')?.textContent.trim()==='1 项'`)
    assert.equal(await js(`document.querySelector('${pane(first)} .toolbar-count').textContent.trim()`), '2 项')
    // 普通导航／命令定位当前副本，不重置筛选，也不把另一个同源副本合并掉。
    const countBefore = (await snapshot()).tabs.length
    await executeUiCommand(js, `host.saved-view.${viewId}`)
    await click(`[data-saved-view="${viewId}"] .nav-label`)
    assert.equal((await snapshot()).active, second)
    assert.equal((await snapshot()).tabs.length, countBefore)
    assert.equal(await js(`document.querySelector('${pane(second)} .toolbar-count').textContent.trim()`), '1 项')
    // 排序可以撤回到视图默认；不会写入视图本身。
    await button(pane(second), '排序'); await input('排序顺序', 'desc', true); await button('dialog', '完成')
    assert.equal((await call('get', [viewId]))[0].blocks.view.data.query && ((await call('get', [viewId]))[0].blocks.view.data.query as any).dir, 'asc')
    // 规则编辑期间被另一方修改，旧保存必须失败，草案仍在。
    chooseMenu('编辑视图规则'); await click(`${pane(second)} [aria-label="视图操作"]`)
    await input('视图名称', '我的草案')
    await call('patch', viewId, 'view', { title: '参考测试新版' })
    await button('dialog', '保存视图')
    await until(`document.querySelector('dialog')?.textContent.includes('别处修改')`)
    assert.equal(await js(`document.querySelector('[aria-label="视图名称"]').value`), '我的草案')
    await shot('query-view-conflict.png')
    await button('dialog', '载入最新规则'); await button('dialog', '保存视图'); await until(`!document.querySelector('dialog')`)
    await until(`document.querySelector('${pane(first)} .toolbar-name')?.textContent==='参考测试新版'`)
    assert.equal(await js(`document.querySelector('${pane(second)} .toolbar-count').textContent.trim()`), '1 项')
    // 按最终目标规则显示拖入提示；外部文件已入库但未匹配时提供查看入口。
    await js(`(()=>{const dt=new DataTransfer();dt.setData('application/x-rm-entities',JSON.stringify([${JSON.stringify(pngId)}]));document.querySelector('${pane(second)} .collection').dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:dt}))})()`)
    await until(`document.querySelector('.drop-hint')?.textContent.includes('png')`)
    assert(await js(`document.querySelector('.drop-hint').textContent.includes('需要满足')`))
    await shot('query-drop-hint.png')
    await js(`(()=>{const dt=new DataTransfer();dt.items.add(new File(['unmatched import verification'], 'outside.txt', {type:'text/plain'}));document.querySelector('${pane(second)} .collection').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt}))})()`)
    await until(`!!document.querySelector('.view-import-review')`)
    assert.equal(await js(`document.querySelectorAll('.view-import-candidates input:checked').length`), 0)
    assert.equal((await call('query', { where: [{ op: 'eq', kind: 'file', field: 'name', value: 'outside.txt' }] })).ids.length, 0)
    await shot('query-import-review.png')
    await button('dialog', '跳过全部')
    await until(`document.querySelector('.admission-feedback')?.textContent.includes('未收录 1 项')`)
    await button('.admission-feedback', '查看结果与原因')
    assert(await js(`document.querySelector('.admission-details').textContent.includes('outside.txt')`))
    await button('dialog', '完成')
    // 明确额外选择后才收录；处理结果必须说明它已在仓库但没有进入视图。
    await js(`(()=>{const dt=new DataTransfer();dt.items.add(new File(['unmatched import verification'], 'outside.txt', {type:'text/plain'}));document.querySelector('${pane(second)} .collection').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt}))})()`)
    await until(`!!document.querySelector('.view-import-review')`)
    await click('.view-import-candidates input')
    await button('dialog', '收录所选 1 项（含额外选择）')
    await until(`document.querySelector('.admission-feedback')?.textContent.includes('1 项已新增到仓库')`)
    await button('.admission-feedback', '查看结果与原因')
    assert(await js(`document.querySelector('.admission-details').textContent.includes('outside.txt')`))
    await shot('query-admission-results.png')
    await button('dialog', '查看未进入的素材')
    const unmatched = (await snapshot()).tabs.find((t: any) => t.params.title === '未匹配 · 参考测试新版')
    assert.equal(unmatched.params.query.ids.length, 1)
    assert.equal((await call('get', unmatched.params.query.ids))[0].blocks.file.data.name, 'outside.txt')
    await click('[aria-label="关闭这批结果"]')
    await activate(first)
    await until(`document.querySelector('${pane(first)} .toolbar-count')?.textContent.trim()==='2 项'`)
    // 多开无关页面使原视图冻结，保存规则仍须更新其静态拖入目标。
    for (let i = 0; i < 3; i++) {
      await js(`[...document.querySelectorAll('.sidebar .nav-item')].find(b=>b.textContent==='全部').dispatchEvent(new MouseEvent('click',{bubbles:true,metaKey:true}))`)
      await snapshot()
    }
    await until(`!document.querySelector('${pane(first)} .collection')`)
    const original = (await call('get', [viewId]))[0].blocks.view.data.query as any
    const narrowed = { ...original, where: [{ op: 'eq', kind: 'file', field: 'ext', value: 'png' }] }
    await call('patch', viewId, 'view', { query: narrowed })
    await wait(300)
    assert.deepEqual((await snapshot()).tabs.find((t: any) => t.id === first).params.query.where, narrowed.where)
    await activate(first)
    await until(`document.querySelector('${pane(first)} .toolbar-count')?.textContent.trim()==='1 项'`)
    await call('patch', viewId, 'view', { query: original })
    await until(`document.querySelector('${pane(first)} .toolbar-count')?.textContent.trim()==='2 项'`)
    // 侧栏只按保存规则整理，不偷用当前页 has:image，也不切走当前标签。
    await activate(second)
    const row = `[data-saved-view="${viewId}"]`
    await until(`!!document.querySelector('${row}')`)
    await js(`(()=>{const dt=new DataTransfer();dt.setData('application/x-rm-entities',JSON.stringify([${JSON.stringify(imported.items[1].id)}]));const row=document.querySelector('${row}');row.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:dt}))})()`)
    await until(`!!document.querySelector('.sidebar-view-drop-hint')`)
    assert(!(await js(`document.querySelector('.sidebar-view-drop-hint').textContent`)).includes('有图片'))
    await shot('query-sidebar-drop.png')
    await js(`(()=>{const dt=new DataTransfer();dt.setData('application/x-rm-entities',JSON.stringify([${JSON.stringify(imported.items[1].id)}]));document.querySelector('${row}').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt}))})()`)
    await until(`document.body.textContent.includes('已放进「参考测试新版」1 项')`)
    assert.equal((await snapshot()).active, second)
    assert.equal(await js(`document.querySelector('${pane(second)} .toolbar-count').textContent.trim()`), '1 项')
    // 解析新文件期间修改规则，仍按放下时的快照接纳；拒绝项的回退继续共用原入口。
    await js(`(()=>{const dt=new DataTransfer();const file=new File(['sidebar new content'],'sidebar.md',{type:'text/markdown'});file.arrayBuffer=async()=>{await new Promise(r=>setTimeout(r,700));return new TextEncoder().encode('sidebar new content').buffer};dt.items.add(file);document.querySelector('${row}').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt}))})()`)
    await call('patch', viewId, 'view', { query: narrowed })
    for (let i = 0; i < 100; i++) { if ((await call('query', { where: [{ op: 'eq', kind: 'file', field: 'name', value: 'sidebar.md' }] })).ids.length) break; await wait() }
    await wait(500)
    assert(!(await js(`!!document.querySelector('.admission-feedback')`)), '侧栏导入保留放下时规则')
    assert.equal((await call('query', { where: [{ op: 'eq', kind: 'file', field: 'name', value: 'sidebar.md' }] })).ids.length, 1)
    assert.equal((await snapshot()).active, second)
    await call('patch', viewId, 'view', { query: original })
    // 混合批次默认只收录匹配项，未匹配项既不入库，也不复制进文件空间。
    await until(`document.querySelector('${row} .nav-label')?.textContent==='参考测试新版'`)
    await wait(150)
    await js(`(()=>{const dt=new DataTransfer();dt.items.add(new File(['batch good'],'batch-good.md',{type:'text/markdown'}));dt.items.add(new File(['batch skip'],'batch-skip.txt',{type:'text/plain'}));document.querySelector('${row}').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt}))})()`)
    await until(`!!document.querySelector('.view-import-review')`)
    assert.equal(await js(`document.querySelectorAll('.view-import-candidates input:checked').length`), 1)
    await button('dialog', '收录所选 1 项')
    await until(`document.querySelector('.admission-feedback')?.textContent.includes('已进入 1 项 · 未收录 1 项')`)
    assert.equal((await call('query', { where: [{ op: 'eq', kind: 'file', field: 'name', value: 'batch-skip.txt' }] })).ids.length, 0)
    // 连续库内拖入不覆盖上一批；分别查看结果，不能把原有素材说成新导入。
    await js(`(()=>{const dt=new DataTransfer();dt.setData('application/x-rm-entities',JSON.stringify(${JSON.stringify(imported.items.map(item => item.id))}));document.querySelector('${pane(second)} .collection').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt}))})()`)
    await until(`document.querySelector('.admission-batches')?.textContent.includes('/ 2 批')`)
    await click('[aria-label="下一批结果"]')
    assert(await js(`document.querySelector('.admission-feedback').textContent.includes('1 项原本就在仓库')`))
    await button('.admission-feedback', '查看结果与原因')
    assert(await js(`document.querySelector('.admission-details').textContent.includes('b.md')`))
    await shot('query-admission-batches.png')
    await button('dialog', '完成'); await click('[aria-label="关闭这批结果"]')
    // 导航空白不把文件误投到当前标签页。
    const beforeBlank = (await call('query', {})).ids.length
    await js(`(()=>{const dt=new DataTransfer();dt.items.add(new File(['do not import'],'sidebar-blank.txt',{type:'text/plain'}));document.querySelector('.sidebar .nav-title').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt}))})()`)
    await wait(350); assert.equal((await call('query', {})).ids.length, beforeBlank)
    const create = (title: string) => call('run', 'view', 'saveView', { title, query: { scope: 'content' }, layout: 'masonry', options: {} }) as Promise<{ id: string }>
    const extra = (await create('待整理')).id, common = (await create('工作参考')).id
    await until(`!!document.querySelector('[data-saved-view="${common}"]')`)
    const menu = async (id: string, label: string) => { chooseMenu(label); await click(`[data-saved-view="${id}"] .nav-view-menu`) }
    await menu(viewId, '固定到常用'); await menu(common, '固定到常用')
    // 真正的导航拖拽事件与素材拖入使用不同类型；跨分区变更固定状态。
    const reorder = async (from: string, to: string, after = false) => js(`(()=>{const dt=new DataTransfer();document.querySelector('[data-saved-view="${from}"] .nav-grip').dispatchEvent(new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer:dt}));const target=document.querySelector('[data-saved-view="${to}"]'),r=target.getBoundingClientRect(),y=${after ? 'r.bottom-1' : 'r.top+1'};for(const type of ['dragover','drop'])target.dispatchEvent(new DragEvent(type,{bubbles:true,cancelable:true,dataTransfer:dt,clientY:y}));})()`)
    await reorder(common, viewId)
    await until(`document.querySelector('[data-view-section="pinned"] [data-saved-view]')?.dataset.savedView===${JSON.stringify(common)}`)
    await reorder(extra, common, true)
    await until(`document.querySelectorAll('[data-view-section="pinned"] [data-saved-view]').length===3`)
    await menu(extra, '取消固定到常用')
    await menu(viewId, '上移')
    const pinned = [viewId, common]
    assert.deepEqual(await js(`[...document.querySelectorAll('[data-view-section="pinned"] [data-saved-view]')].map(el=>el.dataset.savedView)`), pinned)
    assert.equal((await call('query', {})).ids.length, beforeBlank, '导航排序没有导入副本')
    // 即使浏览器同时附带文字，拖导航到中央也不能生成文字素材。
    await js(`(()=>{const dt=new DataTransfer();dt.setData('application/x-rm-saved-view',${JSON.stringify(common)});dt.setData('text/plain','工作参考');document.querySelector('${pane(second)} .collection').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt}))})()`)
    await wait(300); assert.equal((await call('query', {})).ids.length, beforeBlank)
    // 删除后撤销回到原导航位置，素材仍在。
    await menu(common, '删除视图')
    await until(`!document.querySelector('[data-saved-view="${common}"]')`)
    await call('undo')
    await until(`document.querySelectorAll('[data-view-section="pinned"] [data-saved-view]').length===2`)
    assert.deepEqual(await js(`[...document.querySelectorAll('[data-view-section="pinned"] [data-saved-view]')].map(el=>el.dataset.savedView)`), pinned)
    // 阅读页返回集合优先定位同组最近副本，阅读页继续保留。
    await activate(second)
    await until(`!!document.querySelector('${pane(second)} [data-entity-id="${pngId}"]')`)
    await js(`document.querySelector('${pane(second)} [data-entity-id="${pngId}"]').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`)
    const reader = (await snapshot()).active
    assert.notEqual(reader, second)
    await executeUiCommand(js, `host.saved-view.${viewId}`)
    assert.equal((await snapshot()).active, second)
    assert((await snapshot()).tabs.some((t: any) => t.id === reader))
    // 预设命令与导航都原位切换集合；快捷栏重复打开不增加标签。
    await activate(source)
    const beforePreset = (await snapshot()).tabs.length
    await executeUiCommand(js, 'host.view.images')
    const images = (await snapshot()).active
    assert.equal((await snapshot()).tabs.length, beforePreset)
    await executeUiCommand(js, 'host.view.images')
    assert.equal((await snapshot()).active, images)
    await click('[data-quick-action="host.view.all"]')
    const leftAll = (await snapshot()).active
    assert.equal((await snapshot()).tabs.length, beforePreset)
    // 另一组只有开始页时，在当地新开全部，不搬走左侧页面；再次打开仍复用。
    chooseMenu('向右分屏'); await click('.editor-group[data-focused="true"] .editor-layout-button')
    await click('[data-quick-action="host.view.all"]')
    const rightAll = (await snapshot()).active, beforeRepeat = (await snapshot()).tabs.length
    assert.notEqual(rightAll, leftAll)
    await executeUiCommand(js, 'host.view.all')
    assert.equal((await snapshot()).active, rightAll)
    assert.equal((await snapshot()).tabs.length, beforeRepeat)
    assert((await snapshot()).editors.groups.some((g: any) => g.tabs.includes(leftAll) && !g.tabs.includes(rightAll)))
    await activate(second)
    // 检查可见摘要，并保留页面实例跨进程恢复。
    await shot('query-sidebar-navigation.png')
    await shot('query-views.png')
    writeFileSync(join(dir, 'query-views-expected.json'), JSON.stringify({ viewId, first, second, source, pinned, extra }))
    await snapshot()
  }
  writeFileSync(join(dir, `${process.env.CAPTURE_FLOW}-result.json`), JSON.stringify({ ok: true }))
}
