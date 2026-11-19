import { routeAuxiliaryCommand } from '../../src/main/auxiliary-windows'
import { localPackages, selectCapturePackage } from '../../src/main/plugin-packages'
import { encodePackage } from '../../src/plugin-packages/archive'
import { packageManifestSchema } from '../../src/shared/external-plugins'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { screen, type BrowserWindow } from 'electron'
import { findSettingsSurface } from './settings-surface'
import { openLibraries } from '../../src/main/libraries'
import { prepareWindow, resumeWindow, reloadRenderer } from '../../src/main/page-lifecycle'

export async function settingsWindowFlow(win: BrowserWindow, dir: string) {
  const js = async (code: string) => { try { return await win.webContents.executeJavaScript(code) } catch(e) { throw new Error('主窗口脚本：'+code, {cause:e}) } }
  const until = async (check: () => Promise<unknown> | unknown, label: string) => {
    for (let i = 0; i < 150; i++) { if (await check()) return; await new Promise(r => setTimeout(r, 100)) }
    throw new Error(label)
  }
  const child = () => findSettingsSurface(win)!
  await until(() => js(`!!document.querySelector('.app')`), '仓库尚未就绪')
  const core = openLibraries().find(l => l.win === win)!.core
  localPackages().install(encodePackage(packageManifestSchema.parse({ formatVersion: 1, apiVersion: 1, id: 'settings-probe', title: '窗口验证', version: '1.0.0', author: 'test', description: '', uiFeatures: ['settings-navigation-v1'], entries: { ui: 'ui.mjs' } }), new Map([['ui.mjs', Buffer.from(`export const plugin={id:'settings-probe',settingsSections:[{id:'settings-probe.preferences',title:'窗口验证设置',scope:'library',order:100,Component:({host})=>{globalThis.__settingsHost=host;return '插件设置画面'}}]}`)]])))
  win.webContents.send('menu:command', 'settings')
  await until(() => child(), '没有建立设置窗口')
  await until(() => child().webContents.executeJavaScript(`!!document.querySelector('.settings-window-content')`), '设置正文未挂载')
  const assertCentered = () => {
    const parent = win.getBounds(), current = child().getBounds(), area = screen.getDisplayMatching(parent).workArea
    assert.equal(current.x, Math.max(area.x, Math.min(area.x + area.width - current.width, Math.round(parent.x + (parent.width - current.width) / 2))))
    assert.equal(current.y, Math.max(area.y, Math.min(area.y + area.height - current.height, Math.round(parent.y + (parent.height - current.height) / 2))))
  }
  assertCentered()
  assert.equal(child().getParentWindow(), null, '设置仍受原生父窗口位置约束')
  const independentBounds = child().getBounds(), ownerBounds = win.getBounds()
  win.setPosition(ownerBounds.x + 40, ownerBounds.y + 30)
  await new Promise(r => setTimeout(r, 250))
  assert.deepEqual(child().getBounds(), independentBounds, '设置跟随主窗口移动')
  assert.equal(await js(`!!document.querySelector('.settings-modal')`), false)
  assert.equal(openLibraries().find(l => l.win === win)!.core, core)
  const s = async (code: string) => { try { return await child().webContents.executeJavaScript(code) } catch(e) { throw new Error('设置脚本：'+code, {cause:e}) } }
  await s(`[...document.querySelectorAll('.settings-nav-scroll button')].find(b=>b.textContent.includes('功能与方案')).click()`)
  await until(() => s(`!!document.querySelector('.plugin-choice input:not(:disabled)')`), '插件选择未加载')
  assert.equal(await s(`document.querySelector('.settings-advanced-tab').open`), false)
  const search = async (value: string) => {
    await s(`(() => {
      const input = document.querySelector('[aria-label="搜索设置"]')
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)})
      input.dispatchEvent(new Event('input', {bubbles: true}))
    })()`)
  }
  await search('插件开发')
  await s(`document.querySelector('.settings-library-nav button').click()`)
  await until(() => s(`!!document.querySelector('[data-settings-section="development"]')?.checkVisibility()`), '搜索旧名称直达源码页')
  const source = join(dir, '用于验证长路径换行与按钮对齐的本地插件开发目录')
  mkdirSync(source)
  selectCapturePackage(source)
  await s(`document.querySelector('.development-directory .ui-section-actions button').click()`)
  await until(() => s(`document.querySelector('.development-folder')?.textContent.includes(${JSON.stringify(source)})`), '开发目录未显示')
  for (const width of [1040, 720]) {
    child().setSize(width, independentBounds.height)
    await until(() => s(`innerWidth === ${width}`), '设置窗口未完成缩放')
    const geometry = await s(`(() => {
      const [add, remove] = [...document.querySelectorAll('.development-directory .ui-section-actions button')].map(b => b.getBoundingClientRect())
      const row = document.querySelector('.development-folder')
      const label = document.createRange()
      label.selectNodeContents(row.querySelector('button'))
      return { top: Math.abs(add.top - remove.top), bottom: Math.abs(add.bottom - remove.bottom),
        lines: label.getClientRects().length, overlap: row.querySelector('.ui-setting-info').getBoundingClientRect().right - row.querySelector('button').getBoundingClientRect().left }
    })()`)
    assert(geometry.top <= 1 && geometry.bottom <= 1, `${width}px 窗口的开发操作按钮错位`)
    assert(geometry.lines === 1 && geometry.overlap <= 0, `${width}px 窗口的路径挤占移除按钮`)
  }
  child().setBounds(independentBounds)
  await search('外部编辑器')
  await s(`document.querySelector('.application-settings-nav button').click()`)
  await until(() => s(`!!document.querySelector('.local-editor-settings')?.checkVisibility()`), '搜索直达外部编辑器')
  await search('')
  await s(`[...document.querySelectorAll('.settings-subnav button')].find(b=>b.checkVisibility() && b.textContent==='文件空间').click()`)
  await until(() => s(`!!document.querySelector('[data-settings-section="spaces"]')?.checkVisibility()`), '仓库内的全局空间')
  await s(`[...document.querySelectorAll('.settings-library-nav button')].find(b=>b.textContent==='功能与方案').click()`)
  const existing = child()
  win.webContents.send('menu:command', 'settings')
  await new Promise(r => setTimeout(r, 120))
  assert.equal(child(), existing)
  assert.deepEqual(child().getBounds(), independentBounds, '激活已有设置不应强制重新居中')
  assert.equal(await s(`typeof window.bridge`), 'undefined', '附属画面不能继承业务 preload')
  // 真实原生关闭必须经过原会话的表单守卫。
  await s(`document.querySelector('.plugin-choice input:not(:disabled)').click()`)
  child().close()
  await until(() => s(`document.body.textContent.includes('请先应用或还原插件选择')`), '未保存设置没有拦截关闭')
  await assert.rejects(prepareWindow(win, 'shutdown'), /未保存|插件选择/)
  resumeWindow(win)
  await s(`document.querySelector('.plugin-choice input:not(:disabled)').click()`)
  await s(`document.querySelector('[data-plugin-id="settings-probe"] input').click()`)
  await s(`[...document.querySelectorAll('.settings-foot button')].find(b=>b.textContent==='应用并重新加载').click()`)
  await until(() => openLibraries().find(l=>l.win===win)!.core !== core && !openLibraries().find(l=>l.win===win)!.reloading, '插件选择未重载')
  await until(() => child() && s(`!!document.querySelector('.settings-window-content')`), '应用后设置未恢复')
  await s(`[...document.querySelectorAll('.settings-nav-scroll button')].find(b=>b.textContent.includes('窗口验证设置')).click()`)
  await until(() => js(`!!globalThis.__settingsHost`), '插件设置未挂载')
  await js(`globalThis.__settingsHost.showDialog(()=> '设置中的插件弹窗')`)
  await until(() => s(`!!document.querySelector('.quick-attach')`), '插件弹窗未在设置窗口呈现')
  assert.equal(await js(`!!document.querySelector('.quick-attach')`), false)
  await s(`document.querySelector('.quick-attach').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`)
  await js(`globalThis.__settingsHost.openSettings({section:'appearance',scope:'application'})`)
  await until(() => s(`!!document.querySelector('.theme-settings')`), '未定点导航到外观')
  const previousTheme = await js(`document.documentElement.dataset.theme`)
  await s(`[...document.querySelectorAll('.theme-preset-card')].find(b=>!b.classList.contains('active'))?.click()`)
  await until(async () => (await s(`document.documentElement.dataset.theme`)) === (await js(`document.documentElement.dataset.theme`)), '主题没有跟随')
  // 原生输入验证：文字输入、全选和撤销仅作用于小窗。
  child().show(); child().focus()
  await s(`document.querySelector('input[type="search"]').focus()`)
  await child().webContents.insertText('独立设置')
  assert.equal(await s(`document.querySelector('input[type="search"]').value`), '独立设置')
  routeAuxiliaryCommand(child(), 'selectAll')
  await child().webContents.insertText('替换')
  assert.equal(await s(`document.querySelector('input[type="search"]').value`), '替换')
  routeAuxiliaryCommand(child(), 'undo')
  await until(() => s(`document.querySelector('input[type="search"]').value==='独立设置'`), '小窗文本撤销失败')
  assert.notEqual(await js(`document.documentElement.dataset.theme`), previousTheme)
  child().close()
  await until(() => !child(), '干净设置不能关闭')
  win.webContents.send('menu:command', 'settings')
  await until(() => child(), '设置未重开')
  await until(() => s(`!!document.querySelector('.settings-window-content')`), '重开设置未挂载')
  assertCentered()
  await reloadRenderer(win)
  await until(() => js(`!!document.querySelector('.app')`), '主窗口未恢复')
  await until(() => child(), '重载后未接续设置窗口')
  await until(() => s(`!!document.querySelector('.settings-window-content')`), '重载后设置未恢复')
  writeFileSync(join(dir, 'settings-window.png'), (await child().webContents.capturePage()).toPNG())
  writeFileSync(join(dir, 'settingswindow-result.json'), JSON.stringify({ok:true}))
}
