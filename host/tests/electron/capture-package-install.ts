import { settingsScript, settingsSurface } from './settings-surface'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { localPackages, selectCapturePackage } from '../../src/main/plugin-packages'
import { libraryOf, reloadLibrary } from '../../src/main/libraries'
import { callCore } from '../../src/main/core-client'
import { encodePackage, decodePackage } from '../../src/plugin-packages/archive'
import { packageManifestSchema, type PackagePreview } from '../../src/shared/external-plugins'
import { settingsScope } from './capture-settings'

export async function packageInstallFlow(win: BrowserWindow, dir: string, tools: { js(code: string): Promise<any>; shot(name: string): Promise<void> }) {
  const js = (code: string) => settingsScript(win, code)
  const shot = async (name: string) => writeFileSync(join(dir, name), (await settingsSurface(win).webContents.capturePage()).toPNG())
  const lib = () => libraryOf(win.webContents)!
  const wait = () => new Promise(resolve => setTimeout(resolve, 100))
  const until = async (test: () => Promise<unknown>) => {
    for (let n = 0; n < 120; n++) { if (await test().catch(() => false)) return; await wait() }
    throw new Error('批量安装界面未就绪')
  }
  const click = async (scope: string, label: string) => {
    assert(await js(`(()=>{const b=[...document.querySelectorAll(${JSON.stringify(scope + ' button')})].find(b=>b.textContent.trim()===${JSON.stringify(label)});if(!b||b.disabled)return false;b.click();return true})()`), label)
    await wait()
  }
  const statuses = () => js(`[...document.querySelectorAll('[data-install-status]')].map(e=>e.dataset.installStatus)`)
  const enabled = async (id: string) => (await callCore(lib().core, 'plugins')).find(p => p.id === id)?.enabled ?? false
  const installed = () => tools.js('window.bridge.packages.installed()')
  win.webContents.send('menu:command', 'settings')
  await until(() => js(`!!document.querySelector('.settings-window-content')`))
  if (process.env.CAPTURE_FLOW === 'packageinstallresume') {
    assert(await enabled('demo-install-base')); assert(await enabled('demo-install-reader'))
    assert.equal((await installed()).length, 4)
    assert.equal((await callCore(lib().core, 'externalPlugins')).filter(p => p.enabled).length, 3) // 失败包保留启用意图，运行装配会明确拒绝。
    assert(!(await enabled('demo-legacy-ui')))
    writeFileSync(join(dir, 'packageinstallresume-result.json'), JSON.stringify({ ok: true }))
    return
  }
  await settingsScope(js, 'application')
  const pack = (id: string, title: string, version = '1.0.0', requires: string[] = []) => encodePackage(packageManifestSchema.parse({
    formatVersion: 1, apiVersion: 1, id, title, author: '安装回归', description: '临时验证包，不接触日常数据', version, requires, entries: { ui: 'ui.mjs' }
  }), new Map([['ui.mjs', Buffer.from(`export const plugin={id:${JSON.stringify(id)}}`)]]))
  const base = pack('demo-install-base', '阅读支持'), reader = pack('demo-install-reader', '阅读工具', '1.0.0', ['demo-install-base'])
  const old = pack('demo-install-base', '阅读支持', '0.9.0')
  localPackages().install(old)
  const paths = [base, reader, old, base, Buffer.from('broken')].map((bytes, i) => {
    const file = join(dir, ['阅读支持.rmplugin', '阅读工具.rmplugin', '旧版已安装.rmplugin', '重复副本.rmplugin', '损坏包.rmplugin'][i])
    writeFileSync(file, bytes); return file
  })
  const choose = async () => {
    selectCapturePackage(paths)
    await click('.application-settings .package-settings .ui-section-actions', '安装套件或插件包…')
    await until(() => js(`document.querySelectorAll('[data-install-status]').length===5`))
  }
  await choose()
  assert.deepEqual(await statuses(), ['ready', 'ready', 'existing', 'duplicate', 'invalid'])
  assert.equal((await installed()).length, 1)
  await shot('package-install-preview.png')
  await js(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`)
  await until(() => js('!document.querySelector(".package-dialog")'))
  assert(await js('!!document.querySelector(".settings-window-content") && !!document.activeElement.closest(".settings-window-content")'))
  assert.equal((await installed()).length, 1)
  await choose()
  // 真实文件系统写入失败：不能误报成功，清除阻碍后只重试失败项。
  const obstruction = join(localPackages().root, 'registry.json.tmp')
  mkdirSync(obstruction)
  try {
    await click('.package-dialog-actions', '安装 2 个插件')
    await until(async () => (await statuses()).filter((s: string) => s === 'failed').length === 2)
    assert.equal((await installed()).length, 1)
    await shot('package-install-failure.png')
  } finally { rmSync(obstruction, { recursive: true, force: true }) }
  // 来源文件改动不能替换已经确认过的内容。
  writeFileSync(paths[0], 'changed after preview')
  await click('.package-dialog-actions', '重试失败的 2 项')
  await until(async () => (await statuses()).filter((s: string) => s === 'installed').length === 2)
  assert.deepEqual(await statuses(), ['installed', 'installed', 'existing', 'duplicate', 'invalid'])
  assert.equal((await installed()).length, 3)
  assert(!(await enabled('demo-install-base'))); assert(!(await enabled('demo-install-reader')))
  assert.deepEqual(await callCore(lib().core, 'externalPlugins'), [])
  await shot('package-install-result.png')
  await click('.package-dialog-actions', '完成')
  // 直接 IPC 调用也按窗口确认令牌隔离；取消后不能提交。
  selectCapturePackage(paths[1])
  const preview = await tools.js('window.bridge.packages.pick()') as PackagePreview
  assert.equal(preview.items[0].status, 'existing')
  await tools.js(`window.bridge.packages.cancelInstall(${JSON.stringify(preview.token)})`)
  assert(await tools.js(`window.bridge.packages.install(${JSON.stringify(preview.token)}).then(()=>false,()=>true)`))
  await settingsScope(js, 'library')
  for (const id of ['demo-install-base', 'demo-install-reader']) {
    const selector = `.settings-library [data-package-id="${id}"][data-package-version="1.0.0"] input`
    await until(() => js(`!!document.querySelector(${JSON.stringify(selector)})`))
    await js(`document.querySelector(${JSON.stringify(selector)}).click()`)
  }
  assert(!(await enabled('demo-install-base'))); assert(!(await enabled('demo-install-reader')))
  const previous = lib().core
  await click('.settings-foot', '应用并重新加载')
  await until(async () => lib().core !== previous && !lib().reloading && await enabled('demo-install-base') && await enabled('demo-install-reader'))
  assert.equal((await installed()).length, 3)
  const registry = JSON.parse(readFileSync(join(localPackages().root, 'registry.json'), 'utf8'))
  assert.equal(Object.values(registry.grants).flat().length, 2)
  // 应用重载后回到本窗口原设置分类；不把一次性意图写成工作区标签。
  await until(() => js('!!document.querySelector(".settings-window-content .settings-library-nav button[aria-pressed=true]")'))
  assert.equal(await js('document.querySelector(".settings-library-nav button[aria-pressed=true]").textContent'), '功能与方案')
  assert.equal(await tools.js('Object.keys(sessionStorage).filter(k=>k.startsWith("rm:reopen-settings:")).length'), 0)
  const legacy = decodePackage(pack('demo-legacy-ui', '旧侧栏验证'))
  legacy.files.set('ui.mjs', Buffer.from('export const plugin={id:"demo-legacy-ui",sidePanels:[]}'))
  const file = join(dir, 'legacy-ui.rmplugin')
  writeFileSync(file, encodePackage(legacy.manifest, legacy.files))
  selectCapturePackage(file)
  const previewLegacy = await tools.js('window.bridge.packages.pick()') as PackagePreview
  await tools.js(`window.bridge.packages.install(${JSON.stringify(previewLegacy.token)})`)
  await tools.js(`window.bridge.packages.apply(${JSON.stringify({ disabled: [], changes: [{ hash: previewLegacy.items[0].hash, enabled: true }] })})`)
  await reloadLibrary(lib())
  await until(async () => !lib().reloading && (await callCore(lib().core, 'info')).assembly.plugins.some(p => p.id === 'demo-legacy-ui' && !p.enabled && p.reason?.includes('sidePanels 已退役')))
  assert(await enabled('demo-install-base')); assert(await enabled('demo-install-reader'))
  await until(() => tools.js(`!!document.querySelector('[aria-label="打开设置"]')`))
  await tools.js(`document.querySelector('[aria-label="打开设置"]').click()`)
  await until(() => js(`!!document.querySelector('.settings-window-content')`))
  await settingsScope(js, 'library')
  await until(() => js(`document.querySelector('.settings-window-content')?.textContent.includes('sidePanels 已退役')`))
  await shot('package-install-enabled.png')
  writeFileSync(join(dir, 'packageinstall-result.json'), JSON.stringify({ ok: true, checks: ['多包确认与取消', '重复和坏包隔离', '写入失败与重试', '确认字节快照', '不自动启用', '仓库统一应用', '旧侧栏包明确拒绝且其他插件保持'] }))
}
