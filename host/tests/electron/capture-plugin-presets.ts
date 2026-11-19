import { settingsScript, settingsSurface } from './settings-surface'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { libraryOf } from '../../src/main/libraries'
import { callCore } from '../../src/main/core-client'
import { localPackages } from '../../src/main/plugin-packages'
import { encodePackage } from '../../src/plugin-packages/archive'
import { packageManifestSchema } from '../../src/shared/external-plugins'

export async function pluginPresetsFlow(win: BrowserWindow, dir: string, tools: { js(code: string): Promise<any>; shot(name: string): Promise<void> }) {
  const { shot } = tools, lib = () => libraryOf(win.webContents)!
  const js = async (code: string) => { try { return await tools.js(code) } catch (error) { throw new Error(`组合界面脚本失败：${code}`, { cause: error }) } }
  const ui = (code: string) => settingsScript(win, code)
  const wait = () => new Promise(resolve => setTimeout(resolve, 100))
  const until = async (test: () => Promise<unknown>) => {
    for (let n = 0; n < 150; n++) { try { if (await test()) return } catch { /* 重载中 */ } await wait() }
    throw new Error('插件组合界面未就绪')
  }
  const click = async (scope: string, label: string) => {
    assert(await ui(`(()=>{const b=[...document.querySelectorAll(${JSON.stringify(scope + ' button')})].find(b=>b.textContent===${JSON.stringify(label)});if(!b||b.disabled)return false;b.click();return true})()`), label)
    await wait()
  }
  const pick = async (id: string) => {
    await ui(`document.querySelector('[data-preset-id="${id}"]').click()`)
    await until(() => ui(`!!document.querySelector('[data-preset-preview="${id}"]')`))
  }
  const check = async (id: string, value: boolean) => {
    await click('.settings-subnav', '启停功能')
    assert(await ui(`(()=>{const e=document.querySelector('[data-plugin-id="${id}"] input[type="checkbox"]');if(!e||e.disabled)return false;if(e.checked!==${value})e.click();return true})()`), id); await wait()
  }
  const catalog = () => js('window.bridge.pluginPresets.list()')
  const enabled = async (id: string) => (await callCore(lib().core, 'plugins')).find(p => p.id === id)?.enabled
  const apply = async () => {
    const old = lib().core
    await click('.settings-foot', '应用并重新加载')
    await until(async () => lib().core !== old && !lib().reloading && await ui(`!!document.querySelector('.plugin-presets')`))
  }
  const preview = async (id: string, mode: string) => {
    await click('.settings-subnav', '方案组合')
    await pick(id)
    await click('.preset-mode', mode === 'add' ? '补充到当前' : '整套切换')
    await until(() => ui(`!!document.querySelector('.plugin-presets-preview')`))
  }
  const install = (id: string, requires: string[] = [], version = '1.0.0') => localPackages().install(encodePackage(packageManifestSchema.parse({
    formatVersion: 1, apiVersion: 1, id, title: id, author: 'test', description: '', version, requires, entries: { ui: 'ui.mjs' }
  }), new Map([['ui.mjs', Buffer.from(`export const plugin={id:${JSON.stringify(id)}}`)]])))
  const flow = process.env.CAPTURE_FLOW!
  if (flow === 'pluginpresets') { install('demo-preset-base', ['text']); install('demo-preset-reader', ['demo-preset-base']) }
  win.webContents.send('menu:command', 'settings')
  await until(() => ui(`!!document.querySelector('.plugin-presets')`))
  await click('.settings-nav-scroll', '功能与方案')
  if (flow === 'pluginpresets') {
    const [item] = await callCore(lib().core, 'ingest', [{ type: 'text', text: '组合切换保留的内容' }])
    const original = await callCore(lib().core, 'get', [item])
    await check('audio', false); await check('demo-preset-reader', true)
    await click('.settings-subnav', '方案组合')
    await click('.plugin-presets', '保存当前选择…')
    await ui(`(()=>{const e=document.querySelector('[aria-label="组合名称"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'阅读组合');e.dispatchEvent(new Event('input',{bubbles:true}))})()`)
    await wait(); await click('.plugin-presets', '保存组合')
    await until(async () => (await catalog()).length === 1)
    const saved = (await catalog())[0]
    assert(saved.plugins.some((p: any) => p.id === 'demo-preset-reader'), '保存丢失尚不能运行的用户选择')
    assert(!await enabled('demo-preset-reader'))
    await click('.settings-foot', '还原更改')
    await preview(saved.id, 'add')
    assert(await ui(`document.querySelector('.plugin-presets-preview').textContent.includes('必需依赖')`))
    await shot('plugin-presets-add.png')
    await click('.plugin-presets', '采用此方案')
    const before = lib().core
    // 安装集在预览后变化：整批拒绝旧基线，原勾选草稿仍在。
    install('demo-preset-extra')
    await click('.settings-foot', '应用并重新加载')
    await until(() => ui(`document.querySelector('.settings-foot').textContent.includes('重新预演')`))
    assert.equal(lib().core, before); assert(!await enabled('demo-preset-reader'))
    assert(await ui(`document.querySelector('[data-plugin-id="demo-preset-reader"] input').checked`))
    await preview(saved.id, 'add'); await click('.plugin-presets', '确认替换待应用选择'); await apply()
    assert(await enabled('audio')); assert(await enabled('demo-preset-reader')); assert(await enabled('demo-preset-base'))
    await check('text', false)
    await preview(saved.id, 'replace')
    assert(await ui(`document.querySelector('.plugin-presets-preview').textContent.includes('停用')`))
    await click('.plugin-presets', '确认替换待应用选择'); await apply()
    assert(!await enabled('audio')); assert(await enabled('text'))
    assert.deepEqual(await callCore(lib().core, 'get', [item]), original)
    // 目录管理通过 UI；重命名不更改成员，删除不更改仓库选择。
    await click('.settings-subnav', '方案组合')
    await pick(saved.id); await click('.plugin-presets', '重命名')
    await ui(`(()=>{const e=document.querySelector('[aria-label="组合名称"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'精读组合');e.dispatchEvent(new Event('input',{bubbles:true}))})()`)
    await wait()
    // 编辑中点击方案卡片时保留输入；取消后卡片可直接预览。
    const probe = await js(`window.bridge.pluginPresets.save('切换保护验证')`)
    await until(() => ui(`!!document.querySelector('[data-preset-id="${probe.id}"]')`))
    await ui(`(()=>{const card=[...document.querySelectorAll('.plugin-preset-card')].find(e=>e.textContent.includes('切换保护验证'));card.scrollIntoView({block:'center',behavior:'instant'});window.__reviewCard=card})()`)
    await wait()
    const point = await ui(`(()=>{const r=window.__reviewCard.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`)
    await shot('plugin-presets-edit-protected.png')
    assert(await ui(`window.__reviewCard.contains(document.elementFromPoint(${point.x},${point.y}))`), '方案卡片必须可见且没有被其他元素遮挡')
    const inputWindow = settingsSurface(win)
    inputWindow.webContents.debugger.attach('1.3')
    try {
      await inputWindow.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true})
      inputWindow.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point})
      inputWindow.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...point})
      await wait()
    } finally { inputWindow.webContents.debugger.detach() }
    assert(await ui(`document.querySelector('.plugin-presets [role="status"]').textContent.includes('先保存或取消')`), '真实卡片点击必须经过编辑保护')
    assert.equal(await ui(`document.querySelector('[aria-label="组合名称"]').value`),'精读组合')
    await click('.plugin-presets','取消')
    await ui(`window.__reviewCard.click()`)
    await until(() => ui(`!!document.querySelector('.plugin-presets-preview')`))
    assert.equal(await ui(`document.querySelector('.plugin-preset-card[aria-pressed=true]').dataset.presetId`),probe.id)
    await js(`window.bridge.pluginPresets.remove(${JSON.stringify(probe.id)},${JSON.stringify(probe.revision)})`)
    await pick(saved.id);await click('.plugin-presets','重命名')
    await ui(`(()=>{const e=document.querySelector('[aria-label="组合名称"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'精读组合');e.dispatchEvent(new Event('input',{bubbles:true}))})()`)
    await wait(); await click('.plugin-presets', '保存组合')
    await until(async () => (await catalog())[0].title === '精读组合')
    await click('.plugin-presets', '更新为当前选择…'); await click('.plugin-presets', '确认更新')
    await until(async () => (await catalog())[0].plugins.some((p: any) => p.id === 'demo-preset-base'))
    const saved2 = (await catalog())[0]
    const temporary = await js(`window.bridge.pluginPresets.save('临时组合')`)
    await until(() => ui(`!!document.querySelector('[data-preset-id="${temporary.id}"]')`))
    await pick(temporary.id); await click('.plugin-presets', '删除组合…'); await click('.plugin-presets', '确认删除')
    await until(async () => (await catalog()).length === 1)
    const state = await js(`window.bridge.pluginPresets.current()`)
    const alternate = install('demo-preset-reader', ['demo-preset-base'], '2.0.0')
    await preview(saved.id, 'add')
    const reader = 'select[data-plugin-version="demo-preset-reader"]'
    assert.equal(await ui(`document.querySelector('${reader}').checkVisibility()`), false)
    await ui(`document.querySelector('.plugin-presets-versions summary').click()`)
    await ui(`(() => { const e=document.querySelector('${reader}'); e.value=${JSON.stringify(alternate.hash)}; e.dispatchEvent(new Event('change',{bubbles:true})) })()`)
    await until(() => ui(`document.querySelector('${reader}')?.checkVisibility() && document.querySelector('.plugin-presets-changes summary')?.innerText.includes('切换版本 1 项')`))
    assert.deepEqual((await js('window.bridge.pluginPresets.current()')).selection, state.selection, '预演换版不能保存到仓库')
    localPackages().uninstall(alternate.hash)
    const missing = await js(`window.bridge.pluginPresets.save('缺包验证', ${JSON.stringify({ ...state.selection, external: [...state.selection.external, { id: 'demo-preset-extra', hash: localPackages().list().find(p => p.manifest.id === 'demo-preset-extra')!.hash, enabled: true }] })})`)
    localPackages().uninstall(localPackages().list().find(p => p.manifest.id === 'demo-preset-extra')!.hash)
    await until(() => ui(`!!document.querySelector('[data-preset-id="${missing.id}"]')`))
    await preview(missing.id, 'add')
    assert(await ui(`document.querySelector('.plugin-presets-preview [role="alert"]').textContent.includes('缺少插件')`))
    assert(await ui(`document.querySelector('.plugin-presets-preview button').disabled`))
    win.setSize(960, 720); await wait()
    assert(await ui(`document.querySelector('.plugin-presets').scrollWidth<=document.querySelector('.plugin-presets').clientWidth+1`))
    await ui(`document.querySelector('.plugin-presets').scrollIntoView()`); await shot('plugin-presets-missing-narrow.png')
    await js(`window.bridge.pluginPresets.remove(${JSON.stringify(missing.id)},${JSON.stringify(missing.revision)})`)
    writeFileSync(join(dir, 'preset.json'), JSON.stringify(saved2))
  } else if (flow === 'pluginpresetsother') {
    const saved = (await catalog())[0]
    assert.equal(saved.title, '精读组合'); assert(!await enabled('demo-preset-reader'))
    await preview(saved.id, 'replace'); await click('.plugin-presets', '采用此方案'); await apply()
    assert(await enabled('demo-preset-reader')); assert(!await enabled('audio'))
  } else {
    assert.equal((await catalog()).length, 1); assert(await enabled('demo-preset-reader')); assert(!await enabled('audio'))
    await shot('plugin-presets-restored.png')
  }
  writeFileSync(join(dir, `${flow}-result.json`), JSON.stringify({ ok: true }))
}
