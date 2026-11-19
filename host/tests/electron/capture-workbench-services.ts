import { findSettingsSurface, settingsScript, settingsSurface } from './settings-surface'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dialog, type BrowserWindow } from 'electron'
import { localPackages } from '../../src/main/plugin-packages'
import { libraryOf } from '../../src/main/libraries'
import { callCore } from '../../src/main/core-client'
import { encodePackage } from '../../src/plugin-packages/archive'
import { packageManifestSchema } from '../../src/shared/external-plugins'

/** 临时外部 UI 包只用公共 host；同时核验设置浮层与命令面板的真实键盘行为。 */
export async function workbenchServicesFlow(win: BrowserWindow, dir: string, { js, shot }: { js(code: string): Promise<any>; shot(name: string): Promise<void> }) {
  const settingsJs = (code: string) => settingsScript(win, code)
  const settingsClosed = async () => !findSettingsSurface(win)
  const lib = () => libraryOf(win.webContents)!
  const wait = () => new Promise(r => setTimeout(r, 100))
  const until = async (test: () => Promise<unknown>) => {
    for (let i = 0; i < 150; i++) { if (await test().catch(() => false)) return; await wait() }
    throw new Error('工作台公共服务验证等待超时')
  }
  const manifest = packageManifestSchema.parse({ formatVersion: 1, apiVersion: 1, id: 'workbench-probe', title: '工作台验证', author: '临时回归', description: '仅验证公共 UI 契约', version: '1.0.0',
    uiFeatures: ['window-surfaces-v1', 'settings-navigation-v1', 'ui-commands-v1', 'quick-actions-v1'], entries: { ui: 'ui.mjs' } })
  const source = `const R=globalThis.__rmPluginSdk.react;
export const plugin={id:'workbench-probe',
windowProviders:[{id:'workbench-probe.provider',order:100,Component:({host,children})=>{globalThis.__workbenchHost=host;return children}}],
settingsSections:[{id:'workbench-probe.model',title:'验证模型',description:'连接参数',keywords:['model','API'],scope:'local',order:100,Component:()=>R.createElement('p',{id:'probe-model'},'临时模型设置')}],
commands:[{id:'workbench-probe.remember',title:'记录原选择',category:'验证',context:'selection',keywords:['snapshot'],run:(context,host)=>{globalThis.__commandTarget=[...context.ids];host.toggleFilter({kind:'file',field:'ext',op:'eq',value:'svg'})}},
{id:'workbench-probe.fail',title:'模拟命令失败',quickAction:{icon:'tool'},run:()=>{throw new Error('预期命令失败')}},
{id:'workbench-probe.order-a',title:'排序验证 A',category:'验证一',run:()=>{globalThis.__orderResult='a'}},
{id:'workbench-probe.order-b',title:'排序验证 B',category:'验证二',run:()=>{globalThis.__orderResult='b'}},
{id:'workbench-probe.order-c',title:'排序验证 C',category:'验证一',enabled:()=>false,run:()=>{globalThis.__orderResult='c'}}]};`
  const pack = localPackages().install(encodePackage(manifest, new Map([['ui.mjs', Buffer.from(source)]])))
  await js(`window.bridge.packages.apply({disabled:[],changes:[{hash:${JSON.stringify(pack.hash)},enabled:true}]})`)
  const old = lib().core
  await js('void window.bridge.vaults.reload()')
  await until(async () => lib().core !== old && !lib().reloading && await js('!!globalThis.__workbenchHost'))
  const file = join(dir, 'probe.svg')
  writeFileSync(file, '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12"><rect width="12" height="12" fill="red"/></svg>')
  const other = join(dir, 'other.svg')
  writeFileSync(other, '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="12"><rect width="16" height="12" fill="blue"/></svg>')
  const [first, second] = await callCore(lib().core, 'ingest', [{ type: 'file', path: file }, { type: 'file', path: other }])
  assert(first && second && first !== second)
  const select = async (id: string) => {
    const selector = `.tab-pane:not(.hidden) [data-entity-id="${id}"]`
    await until(() => js(`!!document.querySelector(${JSON.stringify(selector)})`))
    await js(`document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}))`)
    await wait()
  }
  await select(first)
  const context = await js(`(()=>{globalThis.__session=__workbenchHost.commands.createSession();return __session.context})()`)
  assert.deepEqual(context.ids, [first])
  assert(!('orderedIds' in (context.page.query ?? {})))
  const scope = await js('__workbenchHost.core.query(__session.context.page.query)')
  assert(scope.ids.includes(first) && scope.ids.includes(second))
  const items = await js('__session.list()')
  for (const id of ['host.import', 'host.file-spaces', 'host.plugin-presets', 'host.action.trash', 'workbench-probe.remember']) assert(items.some((c: { id: string }) => c.id === id), id)
  assert((await js('__session.list("验证 snapshot")')).some((c: { id: string }) => c.id === 'workbench-probe.remember'))
  await select(second)
  const page = await js('__workbenchHost.settings.pages().find(p=>p.id==="workbench-probe.model")')
  assert.deepEqual({ title: page.title, plugin: page.pluginId, scope: page.scope, storage: page.storage }, { title: '验证模型', plugin: 'workbench-probe', scope: 'library', storage: 'local' })
  assert(await js('__workbenchHost.openSettings({section:"workbench-probe.model"})'))
  await until(() => settingsJs('!!document.querySelector("#probe-model")'))
  await js('__session.execute("workbench-probe.remember")')
  assert.deepEqual(await js('globalThis.__commandTarget'), [first])
  // 虽然焦点已进入设置，动作仍作用于原选择，且复用既有仓库撤销。
  await js('__session.execute("host.action.trash")')
  await until(async () => !!(await callCore(lib().core, 'get', [first]))[0]?.deletedAt)
  assert(!(await callCore(lib().core, 'get', [second]))[0].deletedAt)
  await callCore(lib().core, 'undo')
  assert(!(await callCore(lib().core, 'get', [first]))[0].deletedAt)
  await js('void (globalThis.__guardOff=__workbenchHost.settings.registerGuard("probe.draft",{state:()=>({dirty:true,message:"尚未保存"}),beforeLeave:()=>false}))')
  assert.equal(await js('__workbenchHost.openSettings({scope:"application",section:"appearance"})'), false)
  assert.equal(await js('__workbenchHost.settings.getSnapshot().target.section'), 'workbench-probe.model')
  settingsSurface(win).webContents.send('menu:command', 'tab.close')
  await wait(); await wait()
  assert(await settingsJs('!!document.querySelector("#probe-model")'))
  // 设置草稿保护设置窗口里的切页；主工作台仍可打开素材页。
  const guardedTabs = await js('document.querySelectorAll("[data-tab]").length')
  await js('__workbenchHost.openTab("collection",{title:"另一个素材页",query:{}})')
  await wait(); await wait()
  assert.equal(await js('document.querySelectorAll("[data-tab]").length'), guardedTabs + 1)
  assert(await settingsJs('!!document.querySelector("#probe-model")'))
  await js('__guardOff()')
  assert(await js('__workbenchHost.openSettings({scope:"application",section:"appearance"})'))
  await until(() => settingsJs('!![...document.querySelectorAll(".application-settings-nav button")].find(b=>b.textContent==="外观与主题"&&b.getAttribute("aria-pressed")==="true")'))
  await js('__workbenchHost.openTab("settings",{section:"workbench-probe.model"})')
  await until(() => js('__workbenchHost.settings.getSnapshot().target.section==="workbench-probe.model"'))
  assert.equal(await settingsJs('document.querySelectorAll(".settings-window-content").length'), 1)
  // 导入规则即改即存，切页后仍从仓库读取保存结果。
  await js('__workbenchHost.openSettings({scope:"library",section:"import"})')
  await until(() => settingsJs('!!document.querySelector("#import-default-collect")'))
  const original = await settingsJs('document.querySelector("#import-default-collect").value')
  const changeCollect = (value: string) => settingsJs(`(()=>{const e=document.querySelector('#import-default-collect');e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('change',{bubbles:true}))})()`)
  const changed = original === 'true' ? 'false' : 'true'
  await changeCollect(changed)
  await until(async () => String((await callCore(lib().core, 'getImportSettings')).collect) === changed)
  await js('__workbenchHost.openSettings({section:"maintenance"})')
  await js('__workbenchHost.openSettings({section:"import"})')
  await until(() => settingsJs(`document.querySelector('#import-default-collect')?.value===${JSON.stringify(changed)}`))
  await changeCollect(original)
  await until(async () => String((await callCore(lib().core, 'getImportSettings')).collect) === original)
  assert(await js('__workbenchHost.settings.beforeLeave({reason:"reload"})'))
  await settingsJs('document.querySelector(".settings-close-btn").click()')
  await until(settingsClosed)
  await js(`document.querySelector('[aria-label="打开设置"]').focus();document.querySelector('[aria-label="打开设置"]').click()`)
  await until(() => settingsJs('!!document.querySelector(".settings-window-content")'))
  await settingsJs("document.querySelector('.settings-search-input').focus()")
  assert(await settingsJs("document.activeElement.matches('.settings-search-input')"))
  await settingsJs("document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))")
  await until(settingsClosed)
  // 真实命令列表：A、禁用 C 同组，B 在另一组；键盘不能按分组前的序号执行 B。
  await js(`document.querySelector('[aria-label="打开命令面板"]').click()`)
  await until(() => js('!!document.querySelector(".command-palette-input")'))
  await js(`(()=>{const e=document.querySelector('.command-palette-input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'排序验证');e.dispatchEvent(new Event('input',{bubbles:true}))})()`)
  await until(() => js('document.querySelectorAll("[data-command-id]").length===3'))
  assert.deepEqual(await js('[...document.querySelectorAll("[data-command-id]")].map(el=>el.dataset.commandId)'), ['workbench-probe.order-a','workbench-probe.order-c','workbench-probe.order-b'])
  const key = (key: string) => js(`document.querySelector('.command-palette-input').dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(key)},bubbles:true,cancelable:true}))`)
  await key('ArrowDown'); await wait()
  assert.equal(await js('document.querySelector(".command-item.active").dataset.commandId'), 'workbench-probe.order-c')
  await key('Enter'); await wait()
  assert.equal(await js('globalThis.__orderResult ?? null'), null)
  await key('ArrowDown'); await wait()
  await shot('command-palette-order.png')
  await key('Enter'); await until(() => js('globalThis.__orderResult==="b"'))
  const error = await js('__session.execute("workbench-probe.fail").then(()=>"",e=>e.message)')
  assert.equal(error, '预期命令失败')
  // 关闭来源页后不把选中项命令重定向到当前页面。
  await js(`__workbenchHost.commands.createSession().execute(${JSON.stringify('host.page.' + context.page.id)})`)
  win.webContents.send('menu:command', 'tab.close')
  await until(() => js(`!document.querySelector('[data-tab-content="${context.page.id}"]')`))
  assert.match(await js('__session.execute("workbench-probe.remember").then(()=>"",e=>e.message)'), /来源页面/)
  await js('__session.dispose()')
  // 当前仓库快捷入口不继承原视图准入；实际导入经过 utilityProcess 加工，取消不写入。
  await js(`__workbenchHost.openTab('collection',{title:'仅 PDF',query:{where:[{kind:'file',field:'ext',op:'eq',value:'pdf'}]}})`)
  await until(() => js(`document.querySelector('.tab.active')?.textContent.includes('仅 PDF')`))
  const countBefore = (await callCore(lib().core, 'query', { scope: 'content' })).ids.length
  const quick = async (id: string) => {
    await until(() => js(`!document.querySelector('[data-quick-action="${id}"]').disabled`))
    await js(`document.querySelector('[data-quick-action="${id}"]').click()`)
    await until(() => js(`!document.querySelector('[data-quick-action="${id}"]').disabled`))
  }
  await quick('workbench-probe.fail')
  await until(() => js(`document.querySelector('.toast')?.textContent.includes('预期命令失败')`))
  const picker = dialog.showOpenDialog
  let picks = 0
  try {
    dialog.showOpenDialog = (async () => { picks++; return { canceled: true, filePaths: [] } }) as typeof dialog.showOpenDialog
    await quick('host.library.import'); assert.equal(picks, 1)
    assert.equal((await callCore(lib().core, 'query', { scope: 'content' })).ids.length, countBefore)
    const added = join(dir, 'quick-import.svg')
    writeFileSync(added, '<svg xmlns="http://www.w3.org/2000/svg" width="25" height="25"><rect width="25" height="25" fill="green"/></svg>')
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [added] })) as typeof dialog.showOpenDialog
    await quick('host.library.import')
    await until(async () => (await callCore(lib().core, 'query', { where: [{ kind: 'file', field: 'name', op: 'eq', value: 'quick-import.svg' }] })).ids.length === 1)
    const importedId = (await callCore(lib().core, 'query', { where: [{ kind: 'file', field: 'name', op: 'eq', value: 'quick-import.svg' }] })).ids[0]
    await until(async () => !!(await callCore(lib().core, 'get', [importedId]))[0]?.blocks.image)
    assert.equal((await callCore(lib().core, 'get', [importedId]))[0].blocks.file.data.ext, 'svg')
    assert(!await js(`!!document.querySelector('.import-review')`))
    assert(await js(`document.querySelector('.tab.active')?.textContent.includes('仅 PDF')`))
    await quick('host.library.create-text')
    await until(() => js(`!!document.querySelector('.tab-pane:not(.hidden) .reader-editor')`))
    assert.equal((await callCore(lib().core, 'query', { has: ['text'] })).ids.length, 1)
    await quick('host.view.all')
    await until(() => js(`document.querySelector('.tab.active')?.textContent.includes('全部')`))
    assert.equal((await callCore(lib().core, 'query', { scope: 'content' })).ids.length, countBefore + 2)
    const tabs = await js('document.querySelectorAll("[data-tab]").length')
    const activeAll = await js('document.querySelector(".tab.active").dataset.tab')
    await quick('host.view.all')
    assert.equal(await js('document.querySelectorAll("[data-tab]").length'), tabs)
    assert.equal(await js('document.querySelector(".tab.active").dataset.tab'), activeAll)
    await shot('quick-actions.png')
  } finally { dialog.showOpenDialog = picker }
  await shot('workbench-services.png')
  // 实际主题控件与窄窗口，而不只在宽屏查看默认深色。
  const bounds = win.getBounds()
  try {
    await js('__workbenchHost.openSettings({scope:"application",section:"appearance"})')
    await until(() => settingsJs('!!document.querySelector(".theme-preset-card")'))
    await settingsJs(`[...document.querySelectorAll('.theme-preset-card')].find(e=>e.textContent.includes('晴空极简')).click()`)
    await settingsJs(`[...document.querySelectorAll('.theme-settings .segmented button')].find(e=>e.textContent==='紧凑').click()`)
    await until(() => js('document.documentElement.style.colorScheme==="light" && document.documentElement.dataset.density==="compact"'))
    settingsSurface(win).setSize(840, 700)
    win.setSize(840, 700)
    await wait(); await wait()
    assert(await settingsJs('document.querySelector(".settings-modal").getBoundingClientRect().right<=innerWidth && document.querySelector(".settings-modal").scrollWidth<=document.querySelector(".settings-modal").clientWidth+1'))
    writeFileSync(join(dir, 'settings-light-compact-narrow.png'), (await settingsSurface(win).webContents.capturePage()).toPNG())
    await settingsJs('document.querySelector(".settings-close-btn").click()')
    await until(settingsClosed)
    await shot('workbench-light-compact-narrow.png')
  } finally { win.setBounds(bounds) }
  writeFileSync(join(dir, 'workbenchservices-result.json'), JSON.stringify({ ok: true, checks: ['外部包注册', '设置来源与定点打开', '离开保护与导入规则即存', '独立设置窗口焦点与关闭', '命令分组键盘执行', '命令聚合与搜索', '原选择和页面快照', '撤销', '业务失败', '过期来源拒绝', '快捷栏插件失败释放', '筛选页仓库级新建与导入', '取消导入', '原生新文件加工', '浅色紧凑与窄窗口'] }))
}
