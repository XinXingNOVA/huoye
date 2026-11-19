import { settingsScript } from './settings-surface'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, type BrowserWindow } from 'electron'
import { localPackages, selectCapturePackage } from '../../src/main/plugin-packages'
import { libraryOf } from '../../src/main/libraries'
import { callCore } from '../../src/main/core-client'
import { encodePackage, digest } from '../../src/plugin-packages/archive'
import { encodeSuite } from '../../src/plugin-packages/suites'
import { PresetApplications } from '../../src/plugin-packages/preset-applications'
import { packageManifestSchema } from '../../src/shared/external-plugins'
import { suiteManifestSchema } from '../../src/shared/plugin-suites'
import { settingsScope } from './capture-settings'
import type { WorkbenchLayout } from '../../src/shared/workbench-layout'

export async function pluginSuitesFlow(win: BrowserWindow, dir: string, { js, shot }: { js(code: string): Promise<any>; shot(name: string): Promise<void> }) {
  const ui = (code: string) => settingsScript(win, code)
  const lib = () => libraryOf(win.webContents)!, pause = () => new Promise(r => setTimeout(r, 100))
  const until = async (test: () => Promise<unknown>, name: string) => { for (let n = 0; n < 150; n++) { if (await test().catch(() => false)) return; await pause() } throw new Error(`套件验证未就绪：${name}`) }
  const click = async (scope: string, label: string) => { assert(await ui(`(()=>{const b=[...document.querySelectorAll(${JSON.stringify(scope + ' button')})].find(b=>b.textContent===${JSON.stringify(label)});if(!b||b.disabled)return false;b.click();return true})()`), label); await pause() }
  const text = async (selector: string, value: string) => { await ui(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}))})()`); await pause() }
  const select = async (id: string) => {
    await ui(`document.querySelector('[data-preset-id="${id}"]').click()`)
    await until(() => ui(`!!document.querySelector('[data-preset-preview="${id}"]')`), '卡片预览')
  }
  const snapshot = () => js(`window.bridge.loadWorkspace(${JSON.stringify(lib().id)})`)
  const pending = () => js('window.bridge.pluginPresets.pending()')
  const catalog = () => js('window.bridge.pluginPresets.list()')
  const originalId = 'suite:study-suite:study'
  const flow = process.env.CAPTURE_FLOW!
  await until(() => js(`!!document.querySelector('.editor-group')`), '工作台')
  if (flow === 'pluginsuitesresume') {
    const expected = JSON.parse(readFileSync(join(dir, 'suite-resume.json'), 'utf8'))
    await until(async () => !await pending() && (await snapshot()).presetApplication === expected.id, '重启接续')
    assert.equal((await snapshot()).panels.inspector, false)
    assert.equal((await catalog()).filter((p: any) => p.editable).length, 2)
    assert.equal((await js('window.bridge.packages.suites()')).length, 0, '移除套件应保留用户副本与包')
    assert.equal(localPackages().list().length, 1)
    await shot('suite-restart.png')
    writeFileSync(join(dir, flow + '-result.json'), JSON.stringify({ ok: true })); return
  }
  const layout: WorkbenchLayout = { version: 1, root: { type: 'split', id: 'split', direction: 'columns', ratio: 0.6, first: { type: 'group', id: 'main' }, second: { type: 'group', id: 'side' } }, primary: 'main', panels: { sidebar: true, inspector: true }, contents: {
    main: { items: [{ kind: 'page', type: 'collection', target: { presetId: 'all' } }], active: 0 },
    side: { items: [{ kind: 'page', type: 'file-spaces', target: {} }], active: 0 }
  } }
  const pack = encodePackage(packageManifestSchema.parse({ formatVersion: 1, apiVersion: 1, id: 'suite-probe', title: '套件验证插件', author: '临时回归', description: '仅验证公共服务', version: '1.0.0', uiFeatures: ['window-surfaces-v1'], entries: { ui: 'ui.mjs' } }), new Map([['ui.mjs', Buffer.from(`export const plugin={id:'suite-probe',windowProviders:[{id:'suite-probe.provider',order:100,Component:({host,children})=>{globalThis.__suiteHost=host;return children}}]}`)]]))
  const manifest = suiteManifestSchema.parse({ formatVersion: 1, id: 'study-suite', title: '学习套件', version: '1.0.0', description: '临时集成验证', packages: [{ file: 'suite-probe.rmplugin', id: 'suite-probe', hash: digest(pack), version: '1.0.0' }], presets: [{ id: 'study', title: '学习与对照', plugins: [{ id: 'suite-probe', title: '套件验证插件', version: '1.0.0', hash: digest(pack) }], layout }] })
  const file = join(dir, 'study.rmsuite'); writeFileSync(file, encodeSuite(manifest, new Map([['suite-probe.rmplugin', pack]])))
  win.webContents.send('menu:command', 'settings')
  await until(() => ui(`!!document.querySelector('.settings-modal')`), '设置')
  await settingsScope(ui, 'application')
  selectCapturePackage(file); await click('.application-settings .ui-section-actions', '安装套件或插件包…')
  await until(() => ui(`!!document.querySelector('[data-suite-status="ready"]')`), '套件预览')
  assert.equal((await catalog()).length, 0)
  await shot('suite-install-preview.png')
  await ui(`document.querySelector('[data-action="install-packages"]').click()`)
  await until(() => ui(`!!document.querySelector('[data-suite-status="installed"]')`), '套件安装')
  assert.equal((await callCore(lib().core, 'externalPlugins')).length, 0, '安装不应启用插件')
  assert.equal((await catalog())[0].editable, false)
  await shot('suite-install-result.png')
  await ui(`document.querySelector('.package-dialog [data-preview-preset="${originalId}"]').click()`)
  await until(() => ui(`!!document.querySelector('[data-preset-id="${originalId}"][aria-pressed="true"]') && !document.querySelector('.package-dialog') && !document.querySelector('[data-settings-section="plugin-presets"]').hidden`), '直达方案')
  await click('.settings-subnav', '启停功能')
  await ui(`document.querySelector('[data-plugin-id="suite-probe"] input[type="checkbox"]').click()`); await pause()
  await click('.settings-subnav', '方案组合')
  await until(() => ui(`!!document.querySelector('.plugin-presets .plugin-presets-preview')`), '草稿预演')
  assert(await ui(`document.querySelector('.plugin-presets .plugin-presets-preview').textContent.includes('没有启停变化')`), '相对草稿无变化仍需提交实际选择')
  await until(() => ui(`!!document.querySelector('.plugin-presets .plugin-presets-preview button:not(:disabled)')`), '预演')
  await click('.plugin-presets', '确认替换待应用选择')
  const previousCore = lib().core
  await click('.settings-foot', '应用并重新加载')
  await until(async () => lib().core !== previousCore && !lib().reloading && await js('!!globalThis.__suiteHost') && !await pending() && (await snapshot())?.editors?.root?.type === 'split', '启用与布局接续')
  const before = await snapshot()
  assert(before.tabs.some((t: any) => t.type === 'file-spaces'))
  assert.equal((await callCore(lib().core, 'plugins')).find(p => p.id === 'suite-probe')?.enabled, true)
  await until(() => ui(`!!document.querySelector('.plugin-presets')`), '重开设置')
  await shot('suite-enabled.png')
  // 直接再次应用，插件已满足；不能销毁当前渲染进程或核心。
  await select(originalId); await click('.plugin-presets', '采用此方案')
  const sameCore = lib().core; await js('globalThis.suiteSentinel=123')
  await click('.settings-foot', '应用工作台安排')
  await until(async () => !await pending() && (await snapshot()).presetApplication !== before.presetApplication, '免重载布局')
  assert.equal(lib().core, sameCore); assert.equal(await js('globalThis.suiteSentinel'), 123)
  const after = await snapshot(); assert.deepEqual(after.tabs.map((t: any) => t.id).sort(), before.tabs.map((t: any) => t.id).sort())
  assert(await js(`window.bridge.pluginPresets.rename('${originalId}',${JSON.stringify(digest(readFileSync(file)))},'不可修改').then(()=>false,e=>String(e).includes('只读'))`))
  await click('.plugin-presets', '另存副本…'); await text('[aria-label="组合名称"]', '我的学习'); await click('.plugin-presets', '保存组合')
  await until(async () => (await catalog()).length === 2, '另存副本')
  assert.deepEqual((await catalog()).find((p: any) => p.title === '我的学习').layout, layout)
  await click('.plugin-presets', '保存当前选择…'); await text('[aria-label="组合名称"]', '我的工作台')
  await ui(`document.querySelector('.plugin-presets-editor input[type="checkbox"]').click()`); await pause()
  await click('.plugin-presets', '保存组合')
  await until(async () => (await catalog()).length === 3, '保存当前安排')
  assert((await catalog()).find((p: any) => p.title === '我的工作台').layout.contents)
  // 布局解析失败留待处理，不误报完成或丢掉原工作台。
  const state = await js('window.bridge.pluginPresets.current()')
  const badLayout = { ...layout, contents: { main: { items: [{ kind: 'page', type: 'not-installed.page', target: {} }] } } }
  await js(`window.bridge.pluginPresets.apply(${JSON.stringify(state.selection)},${JSON.stringify(state.revision)},${JSON.stringify({ title: '失败验证', layout: badLayout })})`)
  await until(async () => !!await pending(), '失败保留')
  assert.equal((await snapshot()).presetApplication, after.presetApplication)
  const failed = await pending(); await js(`window.bridge.pluginPresets.cancelPending(${JSON.stringify(failed.id)})`)
  assert(!await pending())
  // 实际编排才发现的单实例冲突也必须整份保留，不提交一半布局。
  const conflict = { ...layout, contents: { main: { items: [{ kind: 'page', type: 'history', target: {} }] }, side: { items: [{ kind: 'page', type: 'history', target: {} }] } } }
  await js(`window.bridge.pluginPresets.apply(${JSON.stringify(state.selection)},${JSON.stringify(state.revision)},${JSON.stringify({ title: '实例冲突验证', layout: conflict })})`)
  await until(async () => !!await pending(), '冲突保留'); await pause()
  assert.equal((await snapshot()).presetApplication, after.presetApplication)
  const conflictJob = await pending(); await js(`window.bridge.pluginPresets.cancelPending(${JSON.stringify(conflictJob.id)})`)
  // 移除套件目录不移除包、已应用选择、用户副本。
  await js(`window.bridge.packages.removeSuite('study-suite',${JSON.stringify(digest(readFileSync(file)))})`)
  assert.equal((await catalog()).length, 2)
  assert.equal(localPackages().list().length, 1)
  assert((await callCore(lib().core, 'plugins')).find(p => p.id === 'suite-probe')?.enabled)
  await shot('suite-user-copy.png')
  // 模拟提交配置后、渲染器接续之前退出；下一轮必须自动完成一次。
  const job = new PresetApplications(join(app.getPath('userData'), 'preset-applications')).start(lib().root, lib().id, state.selection, { title: '重启接续验证', layout: { ...layout, panels: { sidebar: true, inspector: false } } })
  writeFileSync(join(dir, 'suite-resume.json'), JSON.stringify({ id: job.id }))
  writeFileSync(join(dir, flow + '-result.json'), JSON.stringify({ ok: true, checks: ['套件预览安装', '结果直达方案', '启用并重载接续', '免重载保留实例', '只读原版和布局副本', '用户组合捕获布局', '解析失败保留和取消', '移除目录保留包和副本'] }))
}
