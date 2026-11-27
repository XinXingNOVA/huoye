import { captureMcpSettings, scopedMcpCall, availableMcpOperations } from './capture-settings'
import { packageActionScope, afterPackageAction, finishPackageInstall } from './capture-settings'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport, type StdioServerParameters } from '@modelcontextprotocol/sdk/client/stdio.js'
import { libraryOf, openLibrary } from '../../src/main/libraries'
import { callCore } from '../../src/main/core-client'
import { selectCapturePackage } from '../../src/main/plugin-packages'
import { decodePackage, encodePackage } from '../../src/plugin-packages/archive'
import type { CoreApi } from '../../src/shared/rpc'

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
interface Tools { js(code: string): Promise<any>; log(label: string, value: unknown): void; shot(name: string): Promise<void> }
export async function packagesFlow(win: BrowserWindow, dir: string, { js, log, shot }: Tools) {
  const lib = () => libraryOf(win.webContents)!
  const call = <K extends keyof CoreApi>(method: K, ...args: Parameters<CoreApi[K]>) => callCore(lib().core, method, ...args)
  const check = (ok: unknown, message: string) => { if (!ok) throw new Error(message) }
  const until = async (fn: () => Promise<unknown>, message: string) => {
    for (let i = 0; i < 160; i++) { try { if (await fn()) return } catch { /* 页面正在重载 */ } await wait(100) }
    throw new Error(message)
  }
  const click = async (selector: string, label: string) => {
    selector = await packageActionScope(js, selector, label)
    check(await js(`(() => {const b=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>e.getClientRects().length && e.textContent.trim()===${JSON.stringify(label)});if(!b||b.disabled)return false;b.click();return true})()`), `按钮不可用：${label}`)
    await wait(150)
    await afterPackageAction(js, selector, label)
  }
  const settings = async () => {
    win.webContents.send('menu:command', 'settings')
    await until(() => js(`!!document.querySelector('.package-settings')`), '插件管理页没有显示')
  }
  const running = async (enabled: boolean) => {
    await until(async () => !lib().reloading && !!(await call('info')).assembly.plugins.find(p => p.id === 'demo-reviewmemo')?.enabled === enabled && await js(`!!document.querySelector('.package-settings')`), `插件状态没有变为 ${enabled}`)
    await wait(350)
  }
  await settings()
  if (process.env.CAPTURE_FLOW === 'packagesresume') {
    const saved = JSON.parse(readFileSync(join(dir, 'package-result.json'), 'utf8'))
    await running(true)
    check((await call('readContent', { id: saved.id, kind: 'demo-reviewmemo', field: 'text' })).text === '构图确认稿', '重启后数据没有恢复')
    check(await js(`!!document.querySelector('.demo-reviewmemo')`), '重启后专用界面没有恢复')
    log('本地插件应用重启验证通过', { id: saved.id, preserved: true })
    return
  }
  const packFile = process.env.PLUGIN_PACKAGE
  check(packFile, '需要 PLUGIN_PACKAGE 指向独立打包结果')
  const bytes = readFileSync(packFile!), archive = decodePackage(bytes)
  const row = () => '.package-row[data-package-id="demo-reviewmemo"]'
  const rowClick = async (version: string, label: string) => {
    const selector = await packageActionScope(js, row() + ' button', label, version)
    check(await js(`(() => {const b=[...document.querySelectorAll(${JSON.stringify(selector)})].find(b=>b.textContent===${JSON.stringify(label)});if(!b||b.disabled)return false;b.click();return true})()`), `${version} 缺少按钮 ${label}`)
    await wait(200)
  }
  const rowToggle = async (version: string, enabled: boolean) => {
    check(await js(`(() => {const row=[...document.querySelectorAll('.package-row')].find(r=>r.getClientRects().length && r.dataset.packageId==='demo-reviewmemo'&&r.dataset.packageVersion===${JSON.stringify(version)});const input=row?.querySelector('input');if(!input||input.disabled)return false;if(input.checked!==${enabled})input.click();return true})()`), `${version} 缺少启停勾选`)
    await wait(150); await click('.settings-foot button', '应用并重新加载')
  }
  const choose = async (path = packFile!) => {
    selectCapturePackage(path)
    await click('.package-heading button', '安装套件或插件包…')
    await until(() => js(`!!document.querySelector('.package-dialog')`), '包预览没有显示')
  }
  const original = join(dir, '插件回归原文.txt')
  writeFileSync(original, '真实导入的原文，插件卸载不应改变。')
  const [fileId] = await call('ingest', [{ type: 'file', path: original }])
  await until(async () => !!(await call('get', [fileId]))[0]?.blocks.body, '新文件正文没有加工完成')
  await choose()
  await shot('packages-1-install.png')
  await click('.package-dialog button', '取消')
  check(!(await js('window.bridge.packages.list()')).some((p: any) => p.manifest.id === 'demo-reviewmemo'), '取消后仍安装了包')
  await choose()
  await finishPackageInstall(js, false)
  await until(() => js(`!!document.querySelector(${JSON.stringify(row())})`), '已安装包没有显示')
  check(!(await call('info')).assembly.plugins.some(p => p.id === 'demo-reviewmemo'), '仅安装执行了插件')
  const other = await openLibrary(join(dir, 'other-library'), { show: false })
  try {
    await rowToggle('1.0.0', true)
    await running(true)
    await until(() => js(`document.querySelector('.demo-reviewmemo')?.textContent.includes('已连接宿主')`), '公共 UI 上下文没有连接')
    check(await js(`document.querySelector('.demo-reviewmemo img').complete && document.querySelector('.demo-reviewmemo img').naturalWidth > 0`), '插件资源没有加载')
    check(await js(`getComputedStyle(document.querySelector('.demo-reviewmemo')).borderTopStyle==='solid'`), '插件样式没有加载')
    await click('.demo-reviewmemo button', '创建验证记录')
    await until(() => js(`!!document.querySelector('.demo-result')?.dataset.recordId`), '插件 UI 未创建记录')
    const id = await js(`document.querySelector('.demo-result').dataset.recordId`)
    await until(() => js(`document.querySelector('.demo-result').textContent.includes('构图')`), '公共订阅没有收到新增记录')
    check(!(await callCore(other.core, 'info')).assembly.plugins.some(p => p.id === 'demo-reviewmemo' && p.enabled), '安装影响了另一仓库')
    const settings = await captureMcpSettings(win, 'organize')
    const params = Object.values(JSON.parse(settings.config).mcpServers)[0] as StdioServerParameters
    const client = new Client({ name: 'local-plugin-test', version: '1.0.0' }), transport = new StdioClientTransport({ ...params, stderr: 'pipe' })
    try {
      await client.connect(transport)
      check((await availableMcpOperations(client, lib().id)).some(t => t.name === 'demo_update_reviewmemo'), '插件业务操作没有进入 MCP')
      const search = await scopedMcpCall(client, lib().id, { name: 'search_items', arguments: { query: { search: [{ kind: 'demo-reviewmemo', field: 'text', text: '构图' }] } } })
      check(!search.isError && JSON.stringify(search.structuredContent).includes(id), 'MCP 搜索插件字段失败')
      const read = await scopedMcpCall(client, lib().id, { name: 'read_content', arguments: { id, kind: 'demo-reviewmemo', field: 'text' } })
      check(!read.isError && JSON.stringify(read.structuredContent).includes('构图'), 'MCP 读取插件内容失败')
      const args = { id, text: '构图确认稿', requestId: 'installed-plugin-operation-1' }
      const changed = await scopedMcpCall(client, lib().id, { name: 'demo_update_reviewmemo', arguments: args })
      check(!changed.isError, 'MCP 插件写入失败')
      await until(() => js(`document.querySelector('.demo-result').textContent.includes('构图确认稿')`), '外部修改没有通知插件 UI')
      await call('undo')
      const replay = await scopedMcpCall(client, lib().id, { name: 'demo_update_reviewmemo', arguments: args })
      check(!replay.isError && (await call('readContent', { id, kind: 'demo-reviewmemo', field: 'text' })).text !== '构图确认稿', '重试重新执行了已撤销操作')
      await scopedMcpCall(client, lib().id, { name: 'demo_update_reviewmemo', arguments: { ...args, requestId: 'installed-plugin-operation-2' } })
    } finally { await client.close(); await transport.close() }
    await shot('packages-2-enabled.png')
    const binding = (await call('externalPlugins')).find(p => p.hash === archive.hash)!
    await call('setExternalPlugin', { ...binding, hash: 'f'.repeat(64), enabled: false })
    try {
      check((await js(`window.bridge.packages.removal(${JSON.stringify(archive.hash)})`)).length > 0, '只检查了待应用配置，漏掉仍在运行的旧版本')
    } finally { await call('setExternalPlugin', binding) }
    await rowClick('1.0.0', '卸载…')
    await until(() => js(`document.querySelector('.package-dialog')?.textContent.includes('受以下绑定或任务保护')`), '未阻止卸载使用中的包')
    await click('.package-dialog button', '取消')
    await rowToggle('1.0.0', false)
    await running(false)
    check(!(await call('describeLibrary')).operations.some(o => o.name === 'demo_update_reviewmemo'), '停用后操作未撤下')
    check((await call('kinds')).find(k => k.id === 'demo-reviewmemo')?.dormant, '停用后定义没有只读保留')
    await rowClick('1.0.0', '卸载…')
    await click('.package-dialog button', '卸载插件')
    await until(async () => !(await js('window.bridge.packages.list()')).some((p: any) => p.manifest.id === 'demo-reviewmemo' && p.installed), '卸载后还在安装列表')
    check((await call('readContent', { id, kind: 'demo-reviewmemo', field: 'text' })).text === '构图确认稿', '卸载丢失数据')
    await shot('packages-3-removed.png')
    await choose(); await finishPackageInstall(js, true); await click('.settings-foot button', '应用并重新加载'); await running(true)
    check((await call('query', { search: [{ kind: 'demo-reviewmemo', text: '确认稿' }] })).ids.includes(id), '重新安装后没有原数据')
    // UI 坏包使用相同数据定义，单独验证界面失败会撤下整个插件且能恢复旧版本。
    archive.files.set('ui.mjs', Buffer.from('throw new Error("故意损坏的 UI 验证入口")'))
    const broken = join(dir, 'broken.rmplugin')
    writeFileSync(broken, encodePackage({ ...archive.manifest, version: '1.0.1' }, archive.files))
    await choose(broken); await finishPackageInstall(js, true); await click('.settings-foot button', '应用并重新加载')
    await until(async () => !lib().reloading && (await call('info')).assembly.plugins.some(p => p.id === 'demo-reviewmemo' && !p.enabled && p.reason?.includes('故意损坏')), '坏 UI 包没有被隔离恢复')
    await until(() => js(`!!document.querySelector('.package-settings')`), '坏插件阻止设置打开')
    await shot('packages-4-recovery.png')
    await rowToggle('1.0.0', true); await running(true)
    // 进程级退出与普通 import 错误不同：必须先释放旧进程的锁，才可安全恢复仓库。
    const crashing = decodePackage(bytes), crashFile = join(dir, 'crashing.rmplugin')
    crashing.files.set('core.mjs', Buffer.from('process.exit(17)'))
    writeFileSync(crashFile, encodePackage({ ...crashing.manifest, version: '1.0.2' }, crashing.files))
    await choose(crashFile); await finishPackageInstall(js, true); await click('.settings-foot button', '应用并重新加载')
    await until(async () => !lib().reloading && (await call('info')).assembly.plugins.some(p => p.id === 'demo-reviewmemo' && !p.enabled && p.reason?.includes('启动失败')), '核心退出后未能跳过插件恢复仓库')
    await until(() => js(`!!document.querySelector('.package-settings')`), '核心退出后设置没有恢复')
    check((await call('readContent', { id, kind: 'demo-reviewmemo', field: 'text' })).text === '构图确认稿', '核心恢复丢失原始数据')
    await rowToggle('1.0.0', true); await running(true)
    const storedPath = await call('locateOriginalFile', { id: fileId, kind: 'file', field: 'path' })
    check(readFileSync(storedPath).equals(readFileSync(original)), '原文件字节发生变化')
    win.setSize(960, 700)
    await js(`document.querySelector('.package-settings').scrollIntoView({block:'end'})`)
    await shot('packages-5-narrow.png')
    writeFileSync(join(dir, 'package-result.json'), JSON.stringify({ id, hash: decodePackage(bytes).hash }))
    log('本地插件全流程通过', { id, checks: ['独立打包', '预览取消与仅安装', '公共 UI 上下文、样式、资源', '新文件真实导入', 'MCP 搜索/读写/回执/撤销', '两库隔离', '启停', '使用中卸载保护', '卸载保留数据', '重装恢复', 'UI 坏包恢复旧版', '核心进程退出恢复', '原文件保持', '窄窗口'] })
  } finally { other.win.close() }
}
