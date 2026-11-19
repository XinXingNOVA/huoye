import assert from 'node:assert/strict'
import { app, safeStorage, type BrowserWindow } from 'electron'
import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { libraryOf, openLibrary, reloadLibrary } from '../../src/main/libraries'
import { callCore } from '../../src/main/core-client'
import { localPackages } from '../../src/main/plugin-packages'
import { encodePackage } from '../../src/plugin-packages/archive'
import { packageManifestSchema } from '../../src/shared/external-plugins'
import { pluginLocalStore } from '../../src/main/plugin-local-store'
import { PluginLocalFiles, localNamespace } from '../../src/main/plugin-local-files'
import { findSettingsSurface, settingsScript } from './settings-surface'

/** 临时双库、真实 IPC / 设置窗口；不读取用户日常配置或密钥。 */
export async function pluginLocalDataFlow(win: BrowserWindow, dir: string) {
  const lib = libraryOf(win.webContents)!, manager = localPackages(), pluginId = 'local-probe'
  const until = async (fn: () => unknown | Promise<unknown>, label: string) => {
    for (let n = 0; n < 150; n++) { try { if (await fn()) return } catch {} await new Promise(r => setTimeout(r, 100)) }
    throw Error(label)
  }
  const ready = (w: BrowserWindow) => until(() => w.webContents.executeJavaScript("!!document.querySelector('.app')"), '仓库未就绪')
  const js = (code: string) => win.webContents.executeJavaScript(code)
  const ui = (code: string) => settingsScript(win, code)
  const ref = manager.install(encodePackage(packageManifestSchema.parse({ formatVersion: 1, apiVersion: 1, id: pluginId,
    title: '本机数据验证', description: '', author: 'test', version: '1.0.0', entries: { core: 'core.mjs' } }),
  new Map([['core.mjs', Buffer.from("export const blocks=[];export const plugin={id:'local-probe',version:1,blocks};")]])))
  manager.grant(lib.root, ref.hash)
  await callCore(lib.core, 'setExternalPlugin', { ...ref, enabled: true })
  await reloadLibrary(lib); await ready(win)
  const other = await openLibrary(join(dir, 'local-other.library'), { show: false })
  await ready(other.win)
  manager.grant(other.root, ref.hash)
  await callCore(other.core, 'setExternalPlugin', { ...ref, enabled: true })
  await reloadLibrary(other); await ready(other.win)
  for (const current of [lib, other]) {
    const state = (await callCore(current.core, 'plugins')).find(p => p.id === pluginId)
    assert(state?.enabled && current.localPlugins?.has(pluginId), current.name+': '+JSON.stringify(state))
  }
  const files = new PluginLocalFiles(join(app.getPath('userData'), 'plugin-local'))
  const store = (root: string, plugin = pluginId) => pluginLocalStore({ directory: files.directory, plugin, root, active: () => true,
    protection: { available: () => safeStorage.isEncryptionAvailable(), encrypt: value => safeStorage.encryptString(value), decrypt: value => safeStorage.decryptString(value) } })
  const mainStore = store(lib.root), otherStore = store(other.root)
  store(lib.root, 'local-only').settings.set('library', 'density', 'compact')
  mainStore.settings.set('application', 'endpoint', 'https://example.invalid')
  mainStore.settings.set('library', 'mode', 'local'); otherStore.settings.set('library', 'mode', 'other')
  assert(mainStore.secrets.available(), '测试环境没有系统凭据保护')
  mainStore.secrets.set('application', 'apiKey', 'local-test-secret')
  assert(!readFileSync(files.file(pluginId, 'application', 'secrets'), 'utf8').includes('local-test-secret'))
  await js(`window.bridge.pluginLocal.state('${pluginId}','library','set','collapsed',['main'])`)
  await js(`window.bridge.pluginLocal.state('${pluginId}','application','set','shared',true)`)
  assert.equal(await other.win.webContents.executeJavaScript(`window.bridge.pluginLocal.state('${pluginId}','application','get','shared')`), true)
  assert.equal(await other.win.webContents.executeJavaScript(`window.bridge.pluginLocal.state('${pluginId}','library','get','collapsed')`), undefined)
  await other.win.webContents.executeJavaScript(`window.__localEvents=[];window.bridge.pluginLocal.onChanged(e=>window.__localEvents.push(e));true`)
  await js(`window.bridge.pluginLocal.state('${pluginId}','library','set','collapsed',[])`)
  await js(`window.bridge.pluginLocal.state('${pluginId}','application','set','shared',false)`)
  await until(() => other.win.webContents.executeJavaScript('window.__localEvents.length===1'), '跨库事件作用域错误')
  await callCore(lib.core, 'setExternalPlugin', { ...ref, enabled: false })
  // 配置已取消勾选，但旧运行环境尚未退出，仍应阻止。
  const request = { pluginId, scope: 'library', categories: ['settings', 'state'] }
  assert((await js(`window.bridge.pluginLocal.preview(${JSON.stringify(request)})`)).blocked.length)
  await reloadLibrary(lib); await ready(win)
  await assert.rejects(js(`window.bridge.pluginLocal.state('${pluginId}','library','set','late',true)`), /PLUGIN_UNAVAILABLE/)
  assert.equal(mainStore.settings.get('library', 'mode'), 'local')
  const globalRequest = { ...request, scope: 'application', categories: ['settings', 'secrets', 'state'] }
  assert((await js(`window.bridge.pluginLocal.preview(${JSON.stringify(globalRequest)})`)).blocked.some((s: string) => s.includes('local-other.library')))
  const open = async (scope: 'application' | 'library') => {
    win.webContents.send('menu:command', 'settings')
    await until(() => findSettingsSurface(win), '设置未打开')
    const label = scope === 'library' ? '数据与维护' : '套件与插件包'
    await until(() => ui(`!![...document.querySelectorAll('.settings-nav-scroll button')].find(b=>b.textContent.includes('${label}'))`), '设置导航未就绪')
    await ui(`[...document.querySelectorAll('.settings-nav-scroll button')].find(b=>b.textContent.includes('${label}')).click()`)
    if (scope === 'library') {
      await ui("[...document.querySelectorAll('[aria-label=数据与维护] button')].find(b => b.textContent === '插件数据与偏好重置').click()")
    } else {
      await until(() => ui("document.querySelector('.global-data-maintenance > summary')?.checkVisibility()"), '高级维护入口不可见')
      assert.equal(await ui("document.querySelector('.global-data-maintenance').open"), false)
      await ui("document.querySelector('.global-data-maintenance > summary').click()")
    }
    await until(() => ui(`document.querySelector('[data-local-maintenance="${scope}"]')?.checkVisibility()`), '清理页面不可见')
    await until(() => ui(`!!document.querySelector('[data-local-maintenance="${scope}"] [data-local-plugin="${pluginId}"]')`), '本机列表未显示')
    if (scope === 'library') {
      const panel = findSettingsSurface(win)!
      const [width, height] = panel.getSize()
      panel.setSize(760, height)
      await until(() => ui("window.innerWidth <= 760"), '未切换到窄窗口')
      assert(await ui("(()=>{const e=document.querySelector('[data-local-maintenance=library]');return e.scrollWidth <= e.clientWidth})()"), '插件清单出现横向溢出')
      writeFileSync(join(dir, 'maintenance-plugins-narrow.png'), (await panel.webContents.capturePage()).toPNG())
      panel.setSize(width, height)
      assert.deepEqual(await ui("[...document.querySelectorAll('[data-plugin-data-row=local-only] button')].map(b => b.textContent)"), ['本机偏好…'])
      assert.equal(await ui(`document.querySelectorAll('[data-plugin-data-row="${pluginId}"]').length`), 1)
      assert.equal(await ui(`document.querySelectorAll('[data-plugin-data-row="${pluginId}"] button').length`), 2)
      assert.equal(await ui("document.querySelector('.plugin-data-others').open"), false)
      await ui("document.querySelector('.plugin-data-others > summary').click()")
      assert(await ui("document.querySelector('.plugin-data-others [data-plugin-data-row] button')?.checkVisibility()"))
    }
    await ui(`document.querySelector('[data-local-maintenance="${scope}"] [data-local-plugin="${pluginId}"]').click()`)
  }
  let scope = 'library'
  const within = () => `[data-local-maintenance="${scope}"]`
  const click = async (label: string) => ui(`(()=>{const b=[...document.querySelectorAll('${within()} button')].find(b=>b.textContent==='${label}');if(!b||b.disabled)throw Error('按钮不可用：${label}');b.click()})()`)
  const preview = async () => { await click('预览影响'); await until(() => ui(`!!document.querySelector('${within()} [data-local-preview]')`), '预览未就绪') }
  const confirm = async () => { await ui(`document.querySelector('${within()} [data-local-confirm]').click()`); await click('确认清理本机数据') }
  await open('library'); await preview()
  assert(await ui(`document.querySelector('${within()} [data-local-execute]').disabled`))
  assert(!(await ui(`document.querySelector('${within()} [data-local-category="secrets"]').checked`)))
  await confirm(); await until(() => ui(`document.querySelector('${within()} [data-local-result]')?.textContent.includes('清理完成')`), '本库清理未完成')
  assert.equal(mainStore.settings.get('library', 'mode'), undefined)
  assert.equal(otherStore.settings.get('library', 'mode'), 'other')
  assert.equal(mainStore.settings.get('application', 'endpoint'), 'https://example.invalid')
  assert.equal(mainStore.secrets.has('application', 'apiKey'), true)
  scope = 'application'; await open('application'); await preview()
  assert(await ui(`document.querySelector('${within()} [data-local-preview]').textContent.includes('local-other.library')`))
  findSettingsSurface(win)!.close(); await until(() => !findSettingsSurface(win), '设置未关闭')
  await callCore(other.core, 'setExternalPlugin', { ...ref, enabled: false }); await reloadLibrary(other); await ready(other.win)
  manager.uninstall(ref.hash)
  assert.equal(mainStore.secrets.has('application', 'apiKey'), true, '卸载意外删除密钥')
  await open('application')
  await ui(`document.querySelector('${within()} [data-local-category="secrets"]').click()`); await preview()
  assert(!(await ui(`document.querySelector('${within()} [data-local-preview]').textContent.includes('local-test-secret')`)))
  await ui(`document.querySelector('${within()}').scrollIntoView({block:'start'})`)
  findSettingsSurface(win)!.focus()
  await ui('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(resolve,100))))')
  writeFileSync(join(dir, 'plugin-local-preview.png'), (await findSettingsSurface(win)!.webContents.capturePage()).toPNG())
  const directory = dirname(files.file(pluginId, localNamespace('application'), 'settings'))
  chmodSync(directory, 0o500)
  try {
    await confirm(); await until(() => ui(`!!document.querySelector('${within()} [data-local-retry]')`), '未反馈删除失败')
    findSettingsSurface(win)!.close(); await until(() => !findSettingsSurface(win), '结果窗口未关闭')
    await open('application'); assert(await ui(`!!document.querySelector('${within()} [data-local-retry]')`))
  } finally { chmodSync(directory, 0o700) }
  await click('接续上次清理'); await until(() => ui(`document.querySelector('${within()} [data-local-result]')?.textContent.includes('清理完成')`), '重试未完成')
  assert.equal(mainStore.secrets.has('application', 'apiKey'), false)
  assert.equal(otherStore.settings.get('library', 'mode'), 'other')
  await ui(`document.querySelector('${within()}').scrollIntoView({block:'start'})`)
  await ui('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(resolve,100))))')
  writeFileSync(join(dir, 'plugin-local-result.png'), (await findSettingsSurface(win)!.webContents.capturePage()).toPNG())
  findSettingsSurface(win)!.close(); await until(() => !findSettingsSurface(win), '设置未关闭')
  other.win.close(); await until(() => other.win.isDestroyed(), '其他仓库未关闭')
  return { scopes: true, runningGuard: true, secretsProtected: true, retry: true }
}
