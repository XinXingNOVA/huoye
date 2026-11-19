import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import type { CoreApi } from '../../src/shared/rpc'
import Database from 'better-sqlite3'
import { callCore } from '../../src/main/core-client'
import { libraryOf, openLibrary } from '../../src/main/libraries'
import { selectCapturePackage } from '../../src/main/plugin-packages'
import { packageActionScope, afterPackageAction, finishPackageInstall } from './capture-settings'

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
interface Tools { js(code: string): Promise<any>; log(label: string, value: unknown): void; shot(name: string): Promise<void> }
/** 冻结旧库 + 真包 + 真实重启；单元格各类型编辑由 tableplugins 流程覆盖。 */
export async function fieldsPackageFlow(win: BrowserWindow, dir: string, { js, log, shot }: Tools) {
  const file = join(dir, '..', 'legacy.json'), fixture = JSON.parse(readFileSync(file, 'utf8'))
  const lib = () => libraryOf(win.webContents)!
  const call = <K extends keyof CoreApi>(method: K, ...args: Parameters<CoreApi[K]>) => callCore(lib().core, method, ...args)
  const check = (ok: unknown, message: string) => { if (!ok) throw new Error(message) }
  // 只读观察 utilityProcess 已提交的快照；测试不得从主进程改业务库。
  const hasSnapshot = () => {
    const db = new Database(join(lib().root, 'library.db'), { readonly: true })
    try { return !!db.prepare('SELECT 1 FROM kind_def WHERE id = ?').get(fixture.kind) } finally { db.close() }
  }
  const until = async (test: () => Promise<unknown>, message: string) => {
    for (let i = 0; i < 150; i++) { try { if (await test()) return } catch { /* 重载期间稍后重试 */ } await wait(100) }
    throw new Error(message)
  }
  const click = async (selector: string, text: string) => {
    await packageActionScope(js, text)
    check(await js(`(() => {const b=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>e.getClientRects().length && e.textContent.trim()===${JSON.stringify(text)});if(!b||b.disabled)return false;b.click();return true})()`), `按钮不可用 ${text}`)
    await wait(150); await afterPackageAction(js, selector, text)
  }
  const settings = async () => {
    win.webContents.send('menu:command', 'settings')
    await until(() => js(`!!document.querySelector('.tab-pane:not(.hidden) .package-settings')`), '未显示设置')
    await until(() => js(`!!document.querySelector('.settings-library .package-row[data-package-id="fields"] input')`), '未载入字段包设置')
  }
  const running = async (enabled: boolean) => {
    await until(async () => !lib().reloading && (await call('info')).assembly.plugins.find(p => p.id === 'fields')?.enabled === enabled && await js(`!!document.querySelector('.package-settings')`), '字段启停未完成')
  }
  const table = async () => {
    check(await js(`(() => {const t=document.querySelector('[data-tab-id="legacy-table"]') || [...document.querySelectorAll('.tab')].find(t=>t.querySelector('.tab-title')?.textContent==='旧表格');t?.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}));return !!t})()`), '旧标签页未恢复')
    await until(() => js(`!!document.querySelector('.tab-pane:not(.hidden) .table-row')`), '旧表格未恢复')
  }
  const unchanged = async () => {
    check(JSON.stringify(await call('get', fixture.ids)) === JSON.stringify(fixture.records), '模板、值或序号被改写')
    const ws = await js(`window.bridge.loadWorkspace(${JSON.stringify(fixture.libraryId)})`)
    const params = ws.tabs.find((t: any) => t.id === 'legacy-table')?.params
    check(params?.layout === 'table' && params.options?.custom === '保留旧选项', '工作区配置丢失')
  }

  if (process.env.CAPTURE_FLOW === 'fieldspackageresume') {
    await settings()
    const row = (await js('window.bridge.packages.list()')).find((p: any) => p.manifest.id === 'fields')
    check(row && !row.installed && !row.enabled, '重启重新安装或启用了字段插件')
    await table(); await unchanged(); await shot('fields-package-4-restart.png')
    await settings(); selectCapturePackage(join(__dirname, 'plugins/fields.rmplugin'))
    await click('.package-heading button', '安装套件或插件包…')
    await until(() => js(`!!document.querySelector('.package-dialog')`), '未显示安装预览')
    await finishPackageInstall(js, true)
    await click('.settings-foot button', '应用并重新加载'); await running(true)
    await settings(); await shot('fields-package-6-reinstalled-settings.png')
    await table(); await unchanged()
    check(await js(`!!document.querySelector('.tab-pane:not(.hidden) .th.add')`), '重装后模板编辑未恢复')
    await call('run', 'fields', 'renameTemplate', { template: fixture.template, title: '重装后的模板' }); await call('undo')
    check((await call('get', [fixture.template]))[0].blocks.template.data.title === '参考信息', '重装后命令或撤销失效')
    await shot('fields-package-5-reinstalled.png')
    log('字段包重启与重装通过', ['卸载不装回', '只读数据和旧视图', '安装勾选统一应用', '编辑与撤销恢复'])
    return
  }

  await table(); await unchanged()
  const plugin = (await call('plugins')).find(p => p.id === 'fields')
  check(plugin?.external && plugin.enabled, '字段未由外部包接续')
  check(await js(`!!document.querySelector('.tab-pane:not(.hidden) .th.add')`), '未加载表头贡献')
  await shot('fields-package-1-migrated.png')
  const other = await openLibrary(join(dir, '..', 'disabled-library'), { show: false })
  try { check((await callCore(other.core, 'plugins')).find(p => p.id === 'fields')?.enabled === false, '旧停用选择未保留') } finally { other.win.close() }
  const original = join(dir, '字段包导入.txt'); writeFileSync(original, '字段包新的真实文件')
  const [id] = await call('ingest', [{ type: 'file', path: original }])
  await until(async () => !!(await call('get', [id]))[0].blocks.body, '新文件正文未加工')
  check(readFileSync(await call('locateOriginalFile', { id, kind: 'file', field: 'path' })).equals(readFileSync(original)), '原文件字节改变')
  await call('put', id, fixture.kind, { fyear: '2025' }); await call('trash', [id])
  const args = { template: fixture.template, field: 'fyear', type: 'number' }
  await call('preview', 'fields', 'changeType', args)
  check((await call('get', [id]))[0].blocks[fixture.kind].data.fyear === '2025', '预演未回滚')
  await call('run', 'fields', 'changeType', args)
  check((await call('get', [id]))[0].blocks[fixture.kind].data.fyear === 2025, '回收站字段转换失败')
  await call('undo')
  await call('run', 'fields', 'deleteTemplate', { template: fixture.template, expectedAffected: 2 })
  check(!(await call('get', [id]))[0].blocks[fixture.kind], '删除模板未清理回收站字段')
  check(!hasSnapshot(), '删除模板后动态定义快照残留')
  await call('undo')
  check(hasSnapshot(), '撤销未重新生成动态定义快照')
  check((await call('get', [id]))[0].blocks[fixture.kind].data.fyear === '2025', '删除模板撤销失败')
  await call('redo'); check(!hasSnapshot(), '重做删除后动态定义快照残留')
  await call('undo')
  fixture.records = await call('get', fixture.ids); writeFileSync(file, JSON.stringify(fixture))
  await settings(); await shot('fields-package-2-settings.png')
  await js(`document.querySelector('.settings-library .package-row[data-package-id="fields"] input').click()`)
  await click('.settings-foot button', '应用并重新加载'); await running(false)
  await table(); await unchanged()
  check(await js(`!document.querySelector('.tab-pane:not(.hidden) .th.add') && document.querySelector('.tab-pane:not(.hidden) .table-row').textContent.includes('2026')`), '关闭后未正确只读降级')
  await settings()
  await click('.package-row[data-package-id="fields"] button', '卸载…')
  await click('.package-dialog button', '卸载插件')
  await until(async () => !(await js('window.bridge.packages.list()')).find((p: any) => p.manifest.id === 'fields')?.installed, '字段包未卸载')
  await table(); await unchanged(); await shot('fields-package-3-uninstalled.png')
  log('字段包迁移通过', ['旧模板和值', '旧启停和工作区', '新文件导入', '预演回滚', '回收站转换', '删除及撤销', '统一启停', '卸载只读保留'])
}
