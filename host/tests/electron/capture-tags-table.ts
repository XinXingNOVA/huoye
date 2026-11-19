import { packageActionScope, afterPackageAction, finishPackageInstall, captureMcpSettings, scopedMcpCall, availableMcpOperations } from './capture-settings'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport, type StdioServerParameters } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { OperationResult } from '../../src/shared/automation'
import type { CoreApi } from '../../src/shared/rpc'
import { callCore } from '../../src/main/core-client'
import { libraryOf, openLibrary } from '../../src/main/libraries'
import { selectCapturePackage } from '../../src/main/plugin-packages'

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
interface Tools { js(code: string): Promise<any>; log(label: string, value: unknown): void; shot(name: string): Promise<void> }
/** 旧定义、视图和工作区由 tests/integration/packaged-tags-table.test.ts 在打开应用前准备。 */
export async function tagsTableFlow(win: BrowserWindow, dir: string, { js, log, shot }: Tools) {
  const fixture = JSON.parse(readFileSync(join(dir, '..', 'legacy.json'), 'utf8'))
  const lib = () => libraryOf(win.webContents)!
  const call = <K extends keyof CoreApi>(method: K, ...args: Parameters<CoreApi[K]>) => callCore(lib().core, method, ...args)
  const check = (ok: unknown, message: string) => { if (!ok) throw new Error(message) }
  const until = async (test: () => Promise<unknown>, message: string) => {
    for (let i = 0; i < 150; i++) { try { if (await test()) return } catch { /* 重载期间稍后重试 */ } await wait(100) }
    throw new Error(message)
  }
  const pane = `document.querySelector('.tab-pane:not(.hidden)')`
  const card = `${pane}.querySelector('[data-entity-id="${fixture.id}"]')`
  const group = `[data-tag-group="${fixture.group}"]`
  const click = async (selector: string, text: string) => {
    await packageActionScope(js, text)
    check(await js(`(() => {const b=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>e.getClientRects().length && e.textContent.trim()===${JSON.stringify(text)});if(!b||b.disabled)return false;b.click();return true})()`), `按钮不可用 ${text}`)
    await wait(150); await afterPackageAction(js, selector, text)
  }
  const settings = async () => {
    win.webContents.send('menu:command', 'settings')
    await until(() => js(`!!${pane}.querySelector('.package-settings')`), '未显示插件管理')
    await wait(200)
  }
  const running = async (enabled: boolean) => {
    await until(async () => !lib().reloading &&
      (await call('info')).assembly.plugins.filter(p => ['tags','table'].includes(p.id)).every(p => p.enabled === enabled) &&
      await js(`!!${pane}.querySelector('.package-settings')`), `标签表格未变为 ${enabled}`)
    await wait(300)
  }
  const table = async (enabled = true) => {
    check(await js(`(() => {const t=[...document.querySelectorAll('.tab')].find(t=>t.querySelector('.tab-title')?.textContent==='旧表格');t?.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}));return !!t})()`), '旧工作区标签页丢失')
    await until(() => js(`!!${card} && !!${pane}.querySelector('.table-scroller')===${enabled}`), '旧表格未恢复或未降级')
  }
  const unchanged = async () => {
    check(JSON.stringify(await call('get', fixture.ids)) === JSON.stringify(fixture.records), '原记录或序号被重写')
    await until(async () => {
      const ws = await js(`window.bridge.loadWorkspace(${JSON.stringify(fixture.libraryId)})`)
      const params = ws.tabs.find((t: any) => t.id === 'legacy-table')?.params
      return params?.layout === 'table' && params.options?.custom === '保留旧选项' && params.query?.where?.[0]?.value === '光影'
    }, '工作区表格与筛选选项没有保留')
  }
  const select = async () => { await js(`${card}.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}))`); await wait(250) }

  if (process.env.CAPTURE_FLOW === 'tagstableresume') {
    await settings()
    const rows = await js('window.bridge.packages.list()')
    check(rows.filter((r: any) => ['tags','table'].includes(r.manifest.id)).every((r: any) => !r.installed && !r.enabled), '重启自动装回或启用了卸载插件')
    await table(false); await unchanged(); await shot('tags-table-4-restart-missing.png')
    for (const id of ['tags','table']) {
      await settings(); selectCapturePackage(join(__dirname, 'plugins', `${id}.rmplugin`))
      await click('.package-heading button', '安装套件或插件包…')
      await until(() => js(`!!document.querySelector('.package-dialog')`), '未显示安装预览')
      await finishPackageInstall(js, true)
    }
    await click('.settings-foot button', '应用并重新加载'); await running(true)
    await table(); await unchanged(); await select()
    check(await js(`!!document.querySelector('.tag-input') && !!${pane}.querySelector('.th.add')`), '重装后标签或表头编辑没有恢复')
    check(await js(`document.querySelector('${group} .tag-group-toggle')?.getAttribute('aria-expanded')==='false'`), '重启和重装丢失旧分组折叠状态')
    await shot('tags-table-5-reinstalled.png')
    log('标签表格重启与重装通过', { checks: ['卸载不装回', '缺包布局降级', '统一安装勾选并应用', '旧数据和分组折叠恢复', '模板表头协作恢复'] })
    return
  }

  await table(); await unchanged(); await select()
  check((await call('plugins')).filter(p => ['tags','table'].includes(p.id)).every(p => p.external && p.enabled), '仍以内置插件提供标签表格')
  check(await js(`getComputedStyle(${pane}.querySelector('.table-row')).display==='flex' && getComputedStyle(document.querySelector('.tags')).display==='flex'`), '专用包样式未加载')
  check(await js(`!!document.querySelector('${group} [data-tag="光影"]') && !!${pane}.querySelector('.th.add') && ${card}.textContent.includes('2026')`), '旧分组、字段值或表头贡献未接续')
  await shot('tags-table-1-restored.png')
  await js(`document.querySelector('${group} .tag-group-toggle').click()`)
  const original = join(dir, '迁包后新收录.txt')
  writeFileSync(original, '在迁包后的 Electron 核心进程中收录。')
  const [file] = await call('ingest', [{ type: 'file', path: original }])
  await until(async () => !!(await call('get', [file]))[0].blocks.body, '新文件正文未加工')
  check(readFileSync(await call('locateOriginalFile', { id: file, kind: 'file', field: 'path' })).equals(readFileSync(original)), '导入改变原文件字节')
  await js(`(() => {const e=document.querySelector('.tag-input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'界面新增');e.dispatchEvent(new Event('input',{bubbles:true}))})()`)
  await wait(100)
  await js(`document.querySelector('.tag-input').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))`)
  await until(async () => ((await call('get', [fixture.id]))[0].blocks.tags.data.values as string[]).includes('界面新增'), '包内标签 UI 未写入')
  await call('undo')
  // 真实 stdio 操作发现、写入、读回、重复回执与停用撤回。
  const { config } = await captureMcpSettings(win, 'organize')
  const params = Object.values(JSON.parse(config).mcpServers)[0] as StdioServerParameters
  const client = new Client({ name: 'tags-package-integration', version: '1.0.0' })
  const transport = new StdioClientTransport({ ...params, stderr: 'pipe' })
  try {
    await client.connect(transport)
    check((await availableMcpOperations(client, lib().id)).some(o => o.name === 'update_tags'), 'MCP 未发现外部标签操作')
    const request = { name: 'update_tags', arguments: { requestId: 'external-tags-smoke', ids: [fixture.id], add: ['MCP 新增'] } }
    const result = await scopedMcpCall(client, lib().id, request)
    check(!result.isError, JSON.stringify(result.content))
    const read = await scopedMcpCall(client, lib().id, { name: 'read_content', arguments: { id: fixture.id, kind: 'tags', field: 'values' } })
    check(!read.isError && JSON.stringify(read.structuredContent).includes('MCP 新增'), 'MCP 读回标签失败')
    check(((await scopedMcpCall(client, lib().id, request)).structuredContent as OperationResult)?.replayed, 'MCP 重复请求没有回执')
    await call('undo')
    fixture.records = await call('get', fixture.ids)
    writeFileSync(join(dir, '..', 'legacy.json'), JSON.stringify(fixture))
    const other = await openLibrary(join(dir, '..', 'disabled-library'), { show: false })
    try {
      check((await callCore(other.core, 'plugins')).filter(p => ['tags','table'].includes(p.id)).every(p => !p.enabled && p.external), '旧停用选择未延续')
      check(JSON.stringify(await callCore(other.core, 'get', fixture.disabled.ids)) === JSON.stringify(fixture.disabled.records), '停用库数据被改写')
    } finally { other.win.close() }
    await settings(); await shot('tags-table-2-package-settings.png')
    await js(`for(const id of ['tags','table'])document.querySelector('.settings-library .package-row[data-package-id="'+id+'"] input').click()`)
    await click('.settings-foot button', '应用并重新加载'); await running(false)
    check(!(await availableMcpOperations(client, lib().id)).some(o => o.name === 'update_tags'), '停用标签后 MCP 操作未撤下')
    await table(false); await unchanged(); await select()
    check(await js(`!document.querySelector('.tag-input,.tag-groups') && document.querySelector('.inspector').textContent.includes('光影') && !!document.querySelector('.inspector .template-block')`), '停用后的只读标签或字段检查器失效')
    await settings()
    for (const id of ['tags','table']) {
      await click(`.package-row[data-package-id="${id}"] button`, '卸载…')
      await click('.package-dialog button', '卸载插件')
      await until(async () => !(await js('window.bridge.packages.list()')).find((r: any) => r.manifest.id === id)?.installed, `${id} 未卸载`)
    }
    await table(false); await unchanged(); await shot('tags-table-3-uninstalled.png')
    log('标签表格迁包通过', { checks: ['旧记录和工作区', '旧启停选择', '独立样式', '新文件导入', '标签编辑与撤销', 'MCP 写入读回与回执', '批量停用及操作撤回', '只读降级', '卸载数据保留'] })
  } finally { await client.close(); await transport.close() }
}
