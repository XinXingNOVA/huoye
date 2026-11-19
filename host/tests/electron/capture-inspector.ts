// 新临时库与独立 RM_USER_DATA：真实编辑、菜单、键盘、DOM 拖放及重启恢复。
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import type { CoreApi } from '../../src/shared/rpc'
import { callCore } from '../../src/main/core-client'
import { libraryOf, openLibrary } from '../../src/main/libraries'
import { settingsScope } from './capture-settings'
import { inspectorLayoutKey } from '../../src/renderer/src/inspector-layout'

const wait = (ms: number) => new Promise(r => setTimeout(r, ms))
interface Tools { js(code: string): Promise<any>; log(label: string, value: unknown): void; shot(name: string): Promise<void>; chooseMenu(label: string): void }
export async function inspectorLayoutFlow(win: BrowserWindow, dir: string, { js, log, shot, chooseMenu }: Tools) {
  // 隐藏窗口默认不派发完整的焦点事件；模拟前台焦点，以覆盖真实失焦提交路径。
  win.webContents.debugger.attach('1.3')
  await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
  const lib = () => libraryOf(win.webContents)!
  const call = <K extends keyof CoreApi>(method: K, ...args: Parameters<CoreApi[K]>) => callCore(lib().core, method, ...args)
  const check = (ok: unknown, message: string) => { if (!ok) throw new Error(message) }
  const until = async (test: () => Promise<unknown>, message: string) => {
    for (let i = 0; i < 100; i++) { try { if (await test()) return } catch { /* 重载中 */ } await wait(100) }
    throw new Error(message)
  }
  const section = (id: string) => `document.querySelector(${JSON.stringify(`[data-inspector-section="${id}"]`)})`
  const order = () => js(`[...document.querySelectorAll('[data-inspector-section]')].filter(e=>e.getClientRects().length).map(e=>e.dataset.inspectorSection)`)
  const storage = () => js(`localStorage.getItem(${JSON.stringify(inspectorLayoutKey(lib().root))})`)
  const select = async (id: string) => {
    await until(() => js(`!!document.querySelector('.tab-pane:not(.hidden) [data-entity-id="${id}"]')`), '找不到素材卡片')
    await js(`document.querySelector('.tab-pane:not(.hidden) [data-entity-id="${id}"]').dispatchEvent(new MouseEvent('mousedown',{button:0,bubbles:true}))`)
    await until(() => js(`!!document.querySelector('.inspector-section')`), '未显示详情')
    await wait(200)
  }
  const fold = async (id: string) => { await js(`${section(id)}.querySelector('.inspector-section-toggle').click()`); await wait(100) }
  const menu = async (label: string, id?: string) => {
    chooseMenu(label)
    await js(id ? `${section(id)}.querySelector('.inspector-section-menu').click()` : `document.querySelector('[aria-label="详情布局"]').click()`)
    await wait(150)
  }
  const input = async (selector: string, value: string) => {
    await js(`(() => {const e=document.querySelector(${JSON.stringify(selector)});e.focus();const proto=e instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}))})()`)
    await wait(30) // 小于 AutoSaveText 的防抖时间，接下来的折叠必须主动保存。
  }
  const fixturePath = join(dir, '..', 'inspector-fixture.json')
  if (process.env.CAPTURE_FLOW === 'inspectlayoutresume') {
    const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'))
    await select(fixture.ids[0])
    check(await storage() === fixture.layout, '重启丢失布局偏好')
    check(JSON.stringify(await order()) === JSON.stringify(fixture.order), '重启顺序改变')
    check(await js(`${section(fixture.block)}.querySelector('.inspector-section-body').hidden`), '重启未恢复折叠')
    check(JSON.stringify(await call('get', fixture.ids)) === JSON.stringify(fixture.records), '重启改写数据')
    await shot('inspector-6-restart.png'); log('详情布局重启通过', fixture.order); return
  }

  const paths = ['分区布局.md', '第二份素材.md'].map((name, i) => {
    const path = join(dir, name); writeFileSync(path, `# ${name}\n详情分区验证 ${i}`); return path
  })
  const ids = await call('ingest', paths.map(path => ({ type: 'file' as const, path })))
  await until(async () => (await call('get', ids)).every(v => v.blocks.body), '文件正文未加工完成')
  const templates: { template: string; kind: string; field: string }[] = []
  for (const title of ['阅读记录', '创作线索与待补充的详细资料']) {
    const result = await call('run', 'fields', 'createTemplate', { title }) as { template: string; kind: string }
    const { field } = await call('run', 'fields', 'addField', { template: result.template, title: '备注', type: 'text' }) as { field: string }
    templates.push({ ...result, field })
    await call('put', ids[0], result.kind, { [field]: '原始内容' })
  }
  await call('run', 'fields', 'createTemplate', { title: '可添加的模板' })
  await call('put', ids[1], templates[0].kind, { [templates[0].field]: '第二份内容' })
  await select(ids[0])
  const block = `block:${templates[0].kind}`, otherBlock = `block:${templates[1].kind}`
  check(await js(`${section(block)}?.textContent.includes('原始内容') || !!${section(block)}?.querySelector('input')`), '模板没有独立分区')
  check(!(await order()).includes('section:backlinks'), '空分区仍显示标题')
  check((await order()).includes('section:templates'), '添加模板入口丢失')
  await shot('inspector-1-default.png')

  await input('[data-inspector-section="section:note"] textarea', '折叠前尚未防抖保存的笔记')
  await fold('section:note')
  check((await call('get', [ids[0]]))[0].blocks.note?.data.text === '折叠前尚未防抖保存的笔记', '折叠丢失笔记')
  await input(`[data-inspector-section="${block}"] input`, '折叠前正在填写的字段')
  await js(`window.__inspectorInput=${section(block)}.querySelector('input')`)
  await fold(block)
  check((await call('get', [ids[0]]))[0].blocks[templates[0].kind].data[templates[0].field] === '折叠前正在填写的字段', '折叠丢失字段')
  await menu('移到顶部', block)
  check((await order())[0] === block, '移到顶部失败')
  check(await js(`window.__inspectorInput===${section(block)}.querySelector('input')`), '排序卸载编辑器')
  let records = await call('get', ids)
  await js(`${section(block)}.querySelector('.inspector-section-grip').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true}))`)
  check((await order())[1] === block, '键盘移动失败')
  await menu('上移', block); check((await order())[0] === block, '菜单上移失败')
  await select(ids[1]); check((await order())[0] === block && !(await order()).includes(otherBlock), '切换素材未沿用分区顺序')
  await select(ids[0]); check((await order()).includes(otherBlock), '返回素材丢失另一个模板')
  check(JSON.stringify(await call('get', ids)) === JSON.stringify(records), '分区移动或切换素材改写数据')
  await call('run', 'fields', 'renameTemplate', { template: templates[0].template, title: '阅读记录（改名）' }); await wait(200)
  check(await js(`${section(block)}.textContent.includes('阅读记录（改名）') && ${section(block)}.querySelector('.inspector-section-body').hidden`), '改名丢失分区身份')
  await call('remove', ids[0], templates[0].kind); await wait(200)
  check(!(await order()).includes(block), '移除模板仍显示分区')
  await call('undo'); await wait(250)
  check((await order())[0] === block && await js(`${section(block)}.querySelector('.inspector-section-body').hidden`), '重新附加丢失位置或折叠')
  check(JSON.stringify((await call('get', ids))[0].blocks[templates[0].kind].data) === JSON.stringify(records[0].blocks[templates[0].kind].data), '撤销未还原模板内容')
  records = await call('get', ids) // 移除和撤销是业务写入，会推进写入序号。
  await menu('折叠全部')
  check(await js(`[...document.querySelectorAll('.inspector-section-body')].every(e=>e.hidden)`), '折叠全部失败')

  // 投递 DOM DragEvent 验证标题柄和目标之间的拖放；系统鼠标拖动另行手动体验。
  await js(`(() => {const source=${section(otherBlock)}.querySelector('.inspector-section-grip'),target=${section(block)};const dt=new DataTransfer();source.dispatchEvent(new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer:dt}));const y=target.getBoundingClientRect().top+1;target.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:dt,clientY:y}));target.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt,clientY:y}));source.dispatchEvent(new DragEvent('dragend',{bubbles:true,dataTransfer:dt}))})()`)
  await wait(150); check((await order())[0] === otherBlock, '分区拖动排序失败')
  const sorted = await order()
  await js(`(() => {const dt=new DataTransfer();dt.setData('application/x-rm-entities','[]');${section(block)}.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt}))})()`)
  check(JSON.stringify(await order()) === JSON.stringify(sorted), '素材拖放误触发分区排序')
  check(JSON.stringify(await call('get', ids)) === JSON.stringify(records), '布局操作改变素材数据')
  await menu('展开全部')
  check(await js(`[...document.querySelectorAll('.inspector-section-body')].every(e=>!e.hidden)`), '展开全部失败')
  await menu('恢复默认布局')
  check((await order())[0] === 'section:file' && JSON.parse(await storage()).collapsed.length === 0, '恢复默认失败')
  await menu('移到顶部', block); await fold(block)
  win.setSize(960, 720); await wait(350)
  check(await js(`[...document.querySelectorAll('.inspector-section-head')].every(e=>e.scrollWidth<=e.clientWidth+1)`), '窄栏标题溢出')
  await shot('inspector-2-narrow.png')

  const toggleFields = async (enabled: boolean) => {
    win.webContents.send('menu:command', 'settings'); await settingsScope(js, 'library')
    await until(() => js(`!!document.querySelector('.settings-library [data-package-id="fields"] input')`), '字段设置未就绪')
    await js(`document.querySelector('.settings-library [data-package-id="fields"] input').click()`); await wait(120)
    await js(`[...document.querySelectorAll('.settings-foot button')].find(e=>e.textContent==='应用并重新加载').click()`)
    await until(async () => !lib().reloading && (await call('plugins')).find(p => p.id === 'fields')?.enabled === enabled && await js(`!!document.querySelector('.app-titlebar')`), '字段启停失败')
    await js(`document.querySelector('.tab').dispatchEvent(new MouseEvent('mousedown',{button:0,bubbles:true}))`); await select(ids[0])
  }
  await toggleFields(false)
  check((await order())[0] === block && await js(`${section(block)}.querySelector('.inspector-section-body').hidden && !${section(block)}.querySelector('input') && ${section(block)}.textContent.includes('只读')`), '停用后的通用分区未沿用布局或只读')
  await fold(block); check(await js(`${section(block)}.textContent.includes('折叠前正在填写的字段')`), '停用未保留字段内容')
  await shot('inspector-3-dormant.png'); await fold(block)
  await toggleFields(true)
  check((await order())[0] === block && await js(`!!${section(block)}.querySelector('input') && ${section(block)}.querySelector('.inspector-section-body').hidden`), '重新启用未恢复模板编辑或布局')
  check(JSON.stringify(await call('get', ids)) === JSON.stringify(records), '启停改写素材数据')
  await shot('inspector-4-restored.png')

  const other = await openLibrary(join(dir, '..', 'other-library'), { show: false })
  try {
    const otherKey = inspectorLayoutKey(other.root)
    await until(() => other.win.webContents.executeJavaScript(`!!document.querySelector('.app-titlebar')`), '另一仓库未就绪')
    check(await other.win.webContents.executeJavaScript(`localStorage.getItem(${JSON.stringify(otherKey)})`) === null, '另一仓库继承了当前布局')
  } finally { other.win.close() }
  writeFileSync(fixturePath, JSON.stringify({ ids, block, records, order: await order(), layout: await storage() }))
  log('详情布局通过', ['新文件', '逐模板分区', '编辑失焦保存', '排序不卸载', '菜单与键盘', 'DOM 拖放与隔离', '切换素材', '改名和移除撤销', '展开折叠全部及复位', '窄栏', '插件启停只读', '仓库偏好隔离'])
}
