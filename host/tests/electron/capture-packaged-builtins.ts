import { packageActionScope, afterPackageAction, finishPackageInstall } from './capture-settings'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import type { CoreApi } from '../../src/shared/rpc'
import { callCore } from '../../src/main/core-client'
import { libraryOf, openLibrary } from '../../src/main/libraries'
import { selectCapturePackage } from '../../src/main/plugin-packages'

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
interface Tools { js(code: string): Promise<any>; log(label: string, value: unknown): void; shot(name: string): Promise<void> }
/** 样本由 tests/integration/packaged-builtins.test.ts 在应用打开前按旧装配生成。 */
export async function packagedBuiltinsFlow(win: BrowserWindow, dir: string, { js, log, shot }: Tools) {
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
  const click = async (selector: string, text: string) => {
    selector = await packageActionScope(js, selector, text)
    check(await js(`(() => {const b=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>e.getClientRects().length && e.textContent.trim()===${JSON.stringify(text)});if(!b||b.disabled)return false;b.click();return true})()`), `按钮不可用 ${text}`)
    await wait(150)
    await afterPackageAction(js, selector, text)
  }
  const settings = async () => {
    win.webContents.send('menu:command', 'settings')
    await until(() => js(`!!${pane}.querySelector('.package-settings')`), '未显示插件管理')
    await wait(200)
  }
  const running = async (id: string, enabled: boolean) => {
    await until(async () => !lib().reloading && (await call('info')).assembly.plugins.find(p => p.id === id)?.enabled === enabled && await js(`!!${pane}.querySelector('.package-settings')`), `${id} 未变为 ${enabled}`)
    await wait(300)
  }
  const row = (id: string) => `.package-row[data-package-id="${id}"] button`
  const board = async (enabled = true) => {
    check(await js(`(() => {const t=[...document.querySelectorAll('.tab')].find(t=>t.querySelector('.tab-title')?.textContent==='旧看板');t?.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}));return !!t})()`), '旧工作区标签页丢失')
    await until(() => js(`!!${card} && !!${pane}.querySelector('.kanban')===${enabled}`), '旧看板未恢复或未降级')
  }
  const unchanged = async () => {
    const records = await call('get', [fixture.id, fixture.viewId])
    for (const [index, kind] of ['status', 'view'].entries()) {
      check(JSON.stringify(records[index].blocks[kind]) === JSON.stringify(fixture.records[index].blocks[kind]), `${kind} 原数据或版本被重写`)
    }
    await until(async () => {
      const ws = await js(`window.bridge.loadWorkspace(${JSON.stringify(fixture.libraryId)})`)
      const params = ws.tabs.find((t: any) => t.id === 'legacy-board')?.params
      return params?.layout === 'kanban' && params.options?.groupBy === 'status.value' && params.options?.custom === '保留旧选项'
    }, '工作区看板选项没有保留')
  }
  const select = async () => {
    await js(`${card}.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}))`)
    await wait(250)
  }

  if (process.env.CAPTURE_FLOW === 'packagedbuiltinsresume') {
    await settings()
    const rows = await js('window.bridge.packages.list()')
    check(rows.filter((r: any) => ['status', 'kanban'].includes(r.manifest.id)).every((r: any) => !r.installed && !r.enabled), '重启自动装回或启用了卸载插件')
    await board(false); await unchanged()
    await shot('migration-5-restart-missing.png')
    for (const id of ['status', 'kanban']) {
      await settings(); selectCapturePackage(join(__dirname, 'plugins', `${id}.rmplugin`))
      await click('.package-heading button', '安装套件或插件包…')
      await until(() => js(`!!document.querySelector('.package-dialog')`), '未显示安装预览')
      await finishPackageInstall(js, true)
      await click('.settings-foot button', '应用并重新加载')
      await running(id, true)
    }
    await board(); await unchanged(); await select()
    check(await js(`!!document.querySelector('.status-options')`), '重装后状态编辑没有恢复')
    await shot('migration-6-reinstalled.png')
    log('迁移包重启与重装通过', { checks: ['卸载不自动装回', '工作区降级仍保留看板选项', '经界面安装并启用', '原状态和视图恢复'] })
    return
  }

  await board(); await unchanged()
  check((await call('plugins')).filter(p => ['status', 'kanban'].includes(p.id)).every(p => p.external && p.enabled), '仍在通过内置清单提供状态或看板')
  check(await js(`getComputedStyle(${pane}.querySelector('.kanban')).display==='flex'`), '看板包样式没有加载')
  check(await js(`${card}.closest('.kanban-col').querySelector('.kanban-title').textContent==='进行中'`), '原状态没有放回正确列')
  await select()
  check(await js(`getComputedStyle(document.querySelector('.status-options')).display==='flex'`), '状态包样式没有加载')
  await shot('migration-1-restored.png')

  const original = join(dir, '迁移后新收录.txt')
  writeFileSync(original, '在迁移后的 Electron 核心进程中接入的新正文。')
  const [file] = await call('ingest', [{ type: 'file', path: original }])
  await until(async () => !!(await call('get', [file]))[0].blocks.body, '新文件正文未加工')
  check(readFileSync(await call('locateOriginalFile', { id: file, kind: 'file', field: 'path' }), 'utf8') === readFileSync(original, 'utf8'), '导入改变了原文字节')
  await click('.status-options button', '已完成')
  await until(async () => (await call('get', [fixture.id]))[0].blocks.status.data.value === '已完成', '安装包状态按钮没有写入')
  await call('undo'); await wait(350)
  const dbg = win.webContents.debugger
  dbg.attach('1.3')
  try {
    const point = await js(`(() => {const c=[...${pane}.querySelectorAll('.kanban-col')].find(c=>c.querySelector('.kanban-title').textContent==='待处理');c.scrollIntoView({inline:'nearest'});const r=c.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+130)}})()`)
    const data = { items: [{ mimeType: 'application/x-rm-entities', data: JSON.stringify([fixture.id]) }], dragOperationsMask: 1 }
    for (const type of ['dragEnter', 'dragOver', 'drop']) await dbg.sendCommand('Input.dispatchDragEvent', { type, ...point, data })
    await until(async () => (await call('get', [fixture.id]))[0].blocks.status.data.value === '待处理', '安装包看板拖入未写入')
  } finally { dbg.detach() }
  await call('undo'); await wait(400)
  check((await call('get', [fixture.id]))[0].blocks.status.data.value === '进行中', '撤销没有恢复旧状态')
  // 本轮正常编辑/撤销会提高 seq；后续只检查停用及重装没有再改动。
  fixture.records = await call('get', [fixture.id, fixture.viewId])
  writeFileSync(join(dir, '..', 'legacy.json'), JSON.stringify(fixture))

  const other = await openLibrary(join(dir, '..', 'disabled-library'), { show: false })
  try {
    check((await callCore(other.core, 'plugins')).filter(p => ['status', 'kanban'].includes(p.id)).every(p => !p.enabled && p.external), '另一旧库原停用选择没有延续')
    check((await callCore(other.core, 'get', [fixture.disabled.id]))[0].blocks.status.data.value === '进行中', '停用库旧值丢失')
  } finally { other.win.close() }
  await settings(); await shot('migration-2-package-settings.png')
  await js(`document.querySelector('.package-row[data-package-id="status"] input').click()`); await click('.settings-foot button', '应用并重新加载'); await running('status', false)
  await board(); await select()
  check(await js(`!document.querySelector('.status-options') && document.querySelector('.inspector').textContent.includes('进行中')`), '停用后通用只读状态未显示')
  await unchanged(); await shot('migration-3-status-disabled.png')
  await settings(); await js(`document.querySelector('.package-row[data-package-id="kanban"] input').click()`); await click('.settings-foot button', '应用并重新加载'); await running('kanban', false)
  await board(false); await unchanged()
  await settings()
  for (const id of ['status', 'kanban']) {
    await click(row(id), '卸载…')
    await click('.package-dialog button', '卸载插件')
    await until(async () => !(await js('window.bridge.packages.list()')).find((r: any) => r.manifest.id === id)?.installed, `${id} 未卸载`)
  }
  await board(false); await unchanged(); await shot('migration-4-uninstalled.png')
  log('状态和看板安装包迁移通过', { checks: ['旧库自动接续', '旧停用库保持关闭', '旧工作区和保存视图', '样式随包', '新文件导入加工', '状态编辑与撤销', '看板拖入与撤销', '停用后只读和布局降级', '卸载后数据不变'] })
}
