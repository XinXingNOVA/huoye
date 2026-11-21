import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { BrowserWindow } from 'electron'
import { callCore } from '../../src/main/core-client'
import { libraryOf, reloadLibrary } from '../../src/main/libraries'
import { encodePackage } from '../../src/plugin-packages/archive'
import { packageManifestSchema } from '../../src/shared/external-plugins'
import { localPackages } from '../../src/main/plugin-packages'
import { executeUiCommand } from './capture-command'

const wait = (ms = 80) => new Promise(resolve => setTimeout(resolve, ms))
async function until(test: () => Promise<unknown> | unknown, label: string) {
  for (let i = 0; i < 120; i++) { if (await test()) return; await wait() }
  throw Error(label)
}
const evaluate = (win: BrowserWindow) => async (code: string) => {
  try { return await win.webContents.executeJavaScript(code, true) }
  catch (cause) { throw new Error('界面操作失败：' + code, { cause }) }
}
function key(win: BrowserWindow, keyCode: string) {
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode })
  if (keyCode === 'Return') win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' })
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode })
}

export async function uiKitFlow(owner: BrowserWindow, dir: string, choose: (label: string) => void) {
  const main = evaluate(owner)
  await until(() => main("!!document.querySelector('.editor-group')"), '仓库未就绪')
  const store = localPackages()
  store.install(readFileSync(resolve('packaging/optional-plugins/kanban.hyplugin')))
  const probe = packageManifestSchema.parse({ id: 'kit-probe', title: '弹层验收', version: '1.0.0', author: 'test', description: '',
    formatVersion: 1, apiVersion: 1, uiFeatures: ['ui-kit-v1'], entries: { ui: 'ui.mjs' } })
  store.install(encodePackage(probe, new Map([['ui.mjs', readFileSync(resolve('tests/electron/ui-kit-layers-fixture.mjs'))]])))
  const changes = ['fields', 'table', 'kanban', 'kit-probe'].map(id => {
    const pack = store.list().find(p => p.manifest.id === id)
    assert(pack, id)
    return { hash: pack.hash, enabled: true }
  })
  await main(`window.bridge.packages.apply({disabled:[],changes:${JSON.stringify(changes)}})`)
  await reloadLibrary(libraryOf(owner.webContents)!)
  await until(() => main("!!document.querySelector('.editor-group')"), '重载失败')
  const lib = libraryOf(owner.webContents)!
  const { template, kind } = await callCore(lib.core, 'run', 'fields', 'createTemplate', { title: '跨窗验收' }) as { template: string; kind: string }
  for (const title of ['已读', '归档']) await callCore(lib.core, 'run', 'fields', 'addField', { template, title, type: 'checkbox' })
  const { id } = await callCore(lib.core, 'run', 'view', 'saveView', { title: '跨窗验收', query: { has: [kind] }, layout: 'table', options: {} }) as { id: string }
  await executeUiCommand(main, 'host.saved-view.' + id)
  const add = '[aria-label="新建字段"]:is(button)'
  const popup = '.hy-popover:popover-open'
  const openForm = async (win: BrowserWindow) => {
    const js = evaluate(win)
    await until(() => js(`!!document.querySelector('${add}')`), '缺少表头按钮')
    await js(`document.querySelector('${add}').click()`)
    await until(() => js(`!!document.querySelector('${popup} input')`), '字段表单未显示')
    const geometry = await js(`(()=>{const p=document.querySelector('${popup}'),r=p.getBoundingClientRect(),a=document.querySelector('${add}').getBoundingClientRect();return {separated:r.top>=a.bottom-1||r.bottom<=a.top+1,rect:[r.y,r.height,a.y,a.height],fits:r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight,focus:p.contains(document.activeElement),color:getComputedStyle(p).backgroundColor}})()`)
    assert(geometry.separated && geometry.fits && geometry.focus, JSON.stringify(geometry))
    return geometry.color as string
  }
  owner.focus()
  const dark = await openForm(owner)
  writeFileSync(join(dir, 'uikit-dark.png'), (await owner.webContents.capturePage()).toPNG())
  key(owner, 'Escape')
  await until(() => main(`!document.querySelector('${popup}')`), 'Esc 未关闭表头浮层')
  await wait(650)
  const tab = await main(`window.bridge.loadWorkspace(${JSON.stringify(lib.id)}).then(w=>w.active)`)
  choose('移到新窗口')
  await main(`document.querySelector('[data-tab="${tab}"]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}))`)
  const childWindow = () => BrowserWindow.getAllWindows().find(w => w !== owner && w.webContents.getURL() === 'about:blank')
  await until(() => !!childWindow(), '标签未移窗')
  const child = childWindow()!, js = evaluate(child)
  child.setSize(590, 470); child.focus()
  await main(`localStorage.setItem('rm:theme-preferences:v1',JSON.stringify({presetId:'daylight'}));window.dispatchEvent(new StorageEvent('storage',{key:'rm:theme-preferences:v1'}))`)
  await until(() => js("document.documentElement.dataset.theme === 'daylight'"), '小窗未同步浅色主题')
  const light = await openForm(child)
  assert.notEqual(light, dark)
  assert.equal(await main(`!!document.querySelector('${popup}')`), false)
  await js(`Object.assign(document.querySelector('${add}').style,{position:'relative',top:'14px'})`)
  await until(() => js(`(() => {
    const panel = document.querySelector('${popup}').getBoundingClientRect(), button = document.querySelector('${add}').getBoundingClientRect()
    return Math.min(Math.abs(panel.top - button.bottom - 4), Math.abs(button.top - panel.bottom - 4)) <= 1
  })()`), '表头位置变化后浮层没有跟随')
  await js(`document.querySelector('${add}').style.removeProperty('top')`)
  await child.webContents.insertText('小窗备注')
  assert.equal(await js(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true,isComposing:true}))`), false)
  assert.equal(await js(`document.querySelector('${popup} input').value`), '小窗备注')
  writeFileSync(join(dir, 'uikit-light.png'), (await child.webContents.capturePage()).toPNG())
  key(child, 'Return')
  await until(async () => {
    const fields = (await callCore(lib.core, 'get', [template]))[0].blocks.template.data.fields as {title: string}[]
    return fields.some(f => f.title === '小窗备注')
  }, '正常回车没有写入字段')
  await until(() => js(`(() => {
    const column = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '小窗备注' && b.checkVisibility())
    if (column) column.click()
    return !!column
  })()`), '新建字段已保存，表头未更新')
  await until(() => js(`!!document.querySelector('${popup}.field-menu input')`), '矩形锚点菜单没有在小窗显示')
  const inside = await js(`(()=>{const r=document.querySelector('${popup}').getBoundingClientRect();return r.right<=innerWidth && r.left>=0})()`)
  assert(inside)
  for (const type of ['mouseDown', 'mouseUp'] as const) child.webContents.sendInputEvent({type, x:12,y:120,button:'left',clickCount:1})
  await until(() => js(`!document.querySelector('${popup}')`), '点外部没有收起菜单')
  await js(`document.querySelector('[aria-label="显示设置"]').click()`)
  await js(`(()=>{const s=document.querySelector('select[aria-label="浏览布局"]');s.value='kanban';s.dispatchEvent(new Event('change',{bubbles:true}))})()`)
  const group = 'select.hy-select[aria-label="分组字段"]'
  await until(() => js(`!!document.querySelector('${group}')`), '看板分组选择器未显示')
  const first = await js(`(()=>{const s=document.querySelector('${group}');s.focus();s.showPicker();return s.value})()`)
  assert.equal(await js(`document.querySelector('${group}').matches(':open')`), true)
  key(child, 'Escape')
  await until(() => js(`!!document.querySelector('${group}') && !document.querySelector('${group}').matches(':open')`), 'Esc 应先收起原生选项')
  await js(`document.querySelector('${group}').showPicker()`)
  key(child, 'Down'); key(child, 'Return')
  await until(() => js(`document.querySelector('${group}').value !== ${JSON.stringify(first)} && !document.querySelector('${group}').matches(':open')`), '小窗选择器键盘选项未生效')
  assert.equal(await js("!!document.querySelector('.kanban .hy-badge')"), true)
  writeFileSync(join(dir, 'uikit-kanban.png'), (await child.webContents.capturePage()).toPNG())
  await js(`(()=>{const s=document.querySelector('select[aria-label="浏览布局"]');s.value='kit-probe';s.dispatchEvent(new Event('change',{bubbles:true}))})()`)
  await js(`document.querySelector('[aria-label="显示设置"]').click()`)
  await until(() => js("!!document.querySelector('#kit-open')"), '验收布局未显示')
  await js("document.querySelector('#kit-open').focus();document.querySelector('#kit-open').click()")
  await until(() => js("!!document.querySelector('dialog:modal #kit-menu')"), '小窗模态框未显示')
  const openMenu = async () => {
    await js("document.querySelector('#kit-menu').focus();document.querySelector('#kit-menu').click()")
    await until(() => js("document.activeElement.textContent==='甲' && !!document.querySelector('dialog:modal [role=menu]:popover-open')"), '弹窗内菜单未获焦')
  }
  await openMenu()
  key(child, 'Down'); key(child, 'Return')
  await until(() => js("document.querySelector('#kit-open').textContent==='last' && document.activeElement.id==='kit-menu'"), '菜单键盘选择或焦点恢复失败')
  await openMenu()
  key(child, 'Escape')
  await until(() => js("!!document.querySelector('dialog:modal') && !document.querySelector('[role=menu]')"), 'Esc 越过菜单关闭了弹窗')
  key(child, 'Escape')
  await until(() => js("!document.querySelector('dialog:modal') && document.activeElement.id==='kit-open'"), '模态框关闭后未还原焦点')
  writeFileSync(join(dir, 'uikit-result.json'), JSON.stringify({ dark, light, window: child.getSize(), fields: 3 }))
}
