// 回归流程共用的真实界面操作；应用包管理与仓库选择分两步完成。
import type { BrowserWindow } from 'electron'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { ApplicationMcpSettings } from '../../src/plugins/mcp/settings'
import type { LibraryDescription } from '../../src/shared/automation'
import { libraryOf, reloadLibrary } from '../../src/main/libraries'
import { callCore } from '../../src/main/core-client'

type Js = (code: string) => Promise<any>
const wait = (ms: number) => new Promise(r => setTimeout(r, ms))
/** 旧的综合功能场景明确准备测试组合；默认值与迁移场景不能调用此函数。 */
export async function prepareFullFeatureCapture(win: BrowserWindow) {
  const ids = ['fields', 'table', 'annotate', 'status', 'kanban']
  const lib = libraryOf(win.webContents)!
  const plugins = await callCore(lib.core, 'plugins')
  const bindings = await callCore(lib.core, 'externalPlugins')
  const disabled = plugins.filter(p => !p.external && p.chosen && !ids.includes(p.id)).map(p => p.id)
  const changes = bindings.filter(b => ids.includes(b.manifest.id) && !b.enabled).map(b => ({ hash: b.hash, enabled: true }))
  if (!changes.length && !plugins.some(p => !p.external && p.chosen && ids.includes(p.id))) return
  await win.webContents.executeJavaScript(`window.bridge.packages.apply(${JSON.stringify({ disabled, changes })})`)
  await reloadLibrary(lib)
  for (let i = 0; i < 100; i++) {
    try { if (await win.webContents.executeJavaScript(`!!document.querySelector('.app-titlebar')`)) return } catch { /* 重载中 */ }
    await wait(100)
  }
  throw new Error('综合测试组合未就绪')
}
export async function settingsScope(js: Js, scope: 'application' | 'library') {
  const label = scope === 'application' ? '套件与插件包' : '功能与方案'
  const nav = scope === 'application' ? '.application-settings-nav' : '.settings-library-nav'
  for (let i = 0; i < 100; i++) {
    if (await js(`(() => {const b=[...document.querySelectorAll(${JSON.stringify(nav + ' button')})].find(b=>b.textContent.includes(${JSON.stringify(label)}));if(!b)return false;if(b.getAttribute('aria-pressed')!=='true')b.click();return true})()`)) {
      await wait(200); return
    }
    await wait(100)
  }
  throw new Error('设置作用域切换失败')
}
export async function packageActionScope(js: Js, selector: string, label?: string, version?: string) {
  if (label === '安装套件或插件包…' || label === '卸载…') await settingsScope(js, 'application')
  if (label !== '卸载…') return selector
  await js(`document.querySelector(${JSON.stringify('.application-settings ' + selector.replace(/ button$/, ' [data-action=plugin-details]'))}).click()`)
  return version ? '.plugin-drawer [data-version="' + version + '"] button' : '.plugin-drawer [data-version] button'
}
export async function afterPackageAction(js: Js, selector: string, label?: string) {
  if (selector.includes('package-dialog') && (label === '取消' || label === '卸载插件')) await settingsScope(js, 'library')
}
export async function finishPackageInstall(js: Js, choose: boolean) {
  const ref = await js(`(() => {const d=document.querySelector('.package-dialog');return {id:d.dataset.packageId,version:d.dataset.packageVersion}})()`)
  await js(`(() => {const b=document.querySelector('.package-dialog [data-action="install-packages"]');if(b){if(b.disabled)throw new Error('安装不可用');b.click()}})()`)
  for (let i = 0; i < 100 && await js(`!!document.querySelector('.package-dialog [data-install-status="ready"]') || !!document.querySelector('.package-dialog button:disabled')`); i++) await wait(100)
  if (await js(`!!document.querySelector('.package-dialog [data-install-status="failed"], .package-dialog [data-install-status="invalid"], .package-dialog [data-install-status="ready"]')`)) throw new Error('安装失败或超时')
  if (choose && await js(`!!document.querySelector('[data-action=stage-installed]:enabled')`)) {
    await js(`document.querySelector('[data-action=stage-installed]').click()`)
    for (let i = 0; i < 100 && await js(`!!document.querySelector('.package-dialog')`); i++) await wait(100)
    if (await js(`!!document.querySelector('.package-dialog')`)) throw new Error('本库未接受安装草稿')
    return
  }
  await js(`(()=>{const b=[...document.querySelectorAll('.package-dialog-actions button')].find(b=>['完成','关闭'].includes(b.textContent));if(!b||b.disabled)throw new Error('安装结果未就绪');b.click()})()`)
  for (let i = 0; i < 100 && await js(`!!document.querySelector('.package-dialog')`); i++) await wait(100)
  if (await js(`!!document.querySelector('.package-dialog')`)) throw new Error('安装结果没有关闭')
  await settingsScope(js, 'library')
  if (choose) {
    const selector = `.settings-library .package-row[data-package-id="${ref.id}"][data-package-version="${ref.version}"] input`
    if (!await js(`(() => {const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)return false;if(!e.checked)e.click();return true})()`)) throw new Error('安装后无法勾选版本')
    await wait(180)
  }
}
export async function captureMcpSettings(win: BrowserWindow, mode?: 'off' | 'read' | 'organize') {
  const js: Js = code => win.webContents.executeJavaScript(code)
  const id = libraryOf(win.webContents)!.id
  let settings = await js(`window.bridge.application.service('mcp','settings')`) as ApplicationMcpSettings
  const grant = settings.libraries.find(g => g.libraryId === id)!
  if (mode) settings = await js(`window.bridge.application.service('mcp','settings',${JSON.stringify({ enabled: true, grant: { key: grant.key, mode } })})`)
  return { ...settings, libraryId: id, mode: settings.libraries.find(g => g.libraryId === id)!.mode }
}
/** 测试业务操作的简写；统一携带 libraryId，写操作经 execute_operation。 */
export function scopedMcpCall(client: Client, libraryId: string, input: { name: string; arguments?: Record<string, unknown> }) {
  if (['describe_library', 'search_items', 'read_item', 'read_content'].includes(input.name)) return client.callTool({ name: input.name, arguments: { ...input.arguments, libraryId } })
  const { requestId, ...args } = input.arguments ?? {}
  return client.callTool({ name: 'execute_operation', arguments: { libraryId, operation: input.name, requestId, args } })
}
export async function availableMcpOperations(client: Client, libraryId: string) {
  const result = await scopedMcpCall(client, libraryId, { name: 'describe_library' })
  if (result.isError) throw new Error(JSON.stringify(result.content))
  return (result.structuredContent as LibraryDescription).operations
}
