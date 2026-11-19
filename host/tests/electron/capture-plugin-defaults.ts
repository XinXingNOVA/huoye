import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import type { CoreApi } from '../../src/shared/rpc'
import { callCore } from '../../src/main/core-client'
import { libraryOf, openLibrary } from '../../src/main/libraries'
import { selectCapturePackage } from '../../src/main/plugin-packages'
import { settingsScope, finishPackageInstall } from './capture-settings'

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
interface Tools { js(code: string): Promise<any>; log(label: string, value: unknown): void; shot(name: string): Promise<void> }
/** 与 DEFAULTS_LEGACY_DIR 测试生成的旧库一起使用；全程独立用户目录。 */
export async function pluginDefaultsFlow(win: BrowserWindow, dir: string, { js, log, shot }: Tools) {
  const fixture = JSON.parse(readFileSync(join(dir, '..', 'legacy.json'), 'utf8'))
  const lib = () => libraryOf(win.webContents)!
  const call = <K extends keyof CoreApi>(method: K, ...args: Parameters<CoreApi[K]>) => callCore(lib().core, method, ...args)
  const check = (ok: unknown, message: string) => { if (!ok) throw new Error(message) }
  const until = async (test: () => Promise<unknown>, message: string) => {
    for (let i = 0; i < 160; i++) { try { if (await test()) return } catch { /* 重载中 */ } await wait(100) }
    throw new Error(message)
  }
  const click = async (selector: string, label: string) => {
    check(await js(`(() => {const b=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>e.getClientRects().length&&e.textContent.trim()===${JSON.stringify(label)});if(!b||b.disabled)return false;b.click();return true})()`), `按钮不可用：${label}`)
    await wait(180)
  }
  const settings = async () => {
    win.webContents.send('menu:command', 'settings')
    await until(() => js(`!!document.querySelector('.plugin-catalog')`), '设置未出现')
    await settingsScope(js, 'library')
  }
  const select = async (id: string, checked: boolean) => {
    check(await js(`(() => {const c=document.querySelector('.plugin-catalog [data-plugin-id="${id}"] input');if(!c||c.disabled)return false;if(c.checked!==${checked})c.click();return true})()`), `无法选择 ${id}`)
    await wait(100)
  }
  const apply = async () => {
    const core = lib().core
    await click('.settings-foot button', '应用并重新加载')
    await until(async () => lib().core !== core && !lib().reloading && await js(`!!document.querySelector('.plugin-catalog')`), '统一应用未完成')
  }
  const unchanged = async () => {
    const record = (await call('get', [fixture.enabled.id]))[0]
    for (const kind of ['note','source']) check(JSON.stringify(record.blocks[kind]) === JSON.stringify(fixture.enabled.record.blocks[kind]), `${kind} 记录被迁移或停用改写`)
  }
  const inspect = async (id: string) => {
    check(await js(`(() => {const t=[...document.querySelectorAll('.tab')].find(t=>t.querySelector('.tab-title')?.textContent==='全部');t?.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}));return !!t})()`), '全部标签页缺失')
    await until(() => js(`!!document.querySelector('.tab-pane:not(.hidden) [data-entity-id="${id}"]')`), '素材卡片未出现')
    await js(`document.querySelector('.tab-pane:not(.hidden) [data-entity-id="${id}"]').dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}))`)
    await wait(250)
  }

  if (process.env.CAPTURE_FLOW === 'plugindefaultsresume') {
    await settings()
    const rows = await js('window.bridge.packages.list()')
    check(rows.filter((r: any) => ['note','source'].includes(r.manifest.id)).every((r: any) => !r.installed && !r.enabled), '重启自动装回或启用插件')
    check((await call('plugins')).filter(p => p.enabled).every(p => p.required), '零可选组合重启改变选择')
    await unchanged()
    for (const id of ['note','source']) {
      await settingsScope(js, 'application'); selectCapturePackage(join(__dirname, 'plugins', `${id}.rmplugin`))
      await click('.package-heading button', '安装套件或插件包…')
      await until(() => js(`!!document.querySelector('.package-dialog')`), '安装预览缺失')
      await finishPackageInstall(js, true)
    }
    await apply(); await unchanged(); await inspect(fixture.enabled.id)
    check(await js(`!!document.querySelector('.inspector textarea') && !!document.querySelector('.source-url')`), '重装未恢复专用编辑和来源链接')
    await shot('defaults-5-reinstalled.png')
    log('插件分发重启验证通过', { checks: ['卸载不自动恢复', '零可选组合保持', '两包界面安装并统一启用', '原数据原版本接续', '笔记和来源界面恢复'] })
    return
  }

  await unchanged()
  const initial = await call('plugins')
  check(initial.filter(p => ['note','source'].includes(p.id)).every(p => p.enabled && p.external), '旧库未接管为外部包')
  check(initial.find(p => p.id === 'fields')?.enabled, '旧库被套用新默认值')
  const disabled = await openLibrary(join(dir, '..', 'disabled-library'), { show: false })
  try {
    check((await callCore(disabled.core, 'plugins')).filter(p => ['note','source'].includes(p.id)).every(p => !p.enabled && p.external), '旧停用库被启用')
    check(JSON.stringify((await callCore(disabled.core, 'get', [fixture.disabled.id]))[0].blocks.note) === JSON.stringify(fixture.disabled.record.blocks.note), '旧停用库数据变化')
  } finally { disabled.win.close() }
  const fresh = await openLibrary(join(dir, '..', 'fresh-library'), { show: false })
  try {
    const enabled = new Set((await callCore(fresh.core, 'plugins')).filter(p => p.enabled).map(p => p.id))
    for (const id of ['file','view','note','source','text','tags','image','audio','video','pdf','preview']) check(enabled.has(id), `新库未默认启用 ${id}`)
    for (const id of ['fields','table','annotate','status','kanban']) check(!enabled.has(id), `新库意外启用 ${id}`)
  } finally { fresh.win.close() }
  const original = join(dir, '新文件.txt'); writeFileSync(original, '真实 Electron 外部包收录正文')
  const [id] = await call('ingest', [{ type: 'file', path: original, source: { url: 'https://www.example.com/new', title: '外部来源' } }])
  await until(async () => !!(await call('get', [id]))[0].blocks.body, '新正文未加工')
  check((await call('get', [id]))[0].blocks.source.data.site === 'example.com', '来源后处理未运行')
  check(readFileSync(await call('locateOriginalFile', { id, kind: 'file', field: 'path' })).equals(readFileSync(original)), '原字节变化')
  await inspect(id)
  check(await js(`!!document.querySelector('.source-url')`), '包内来源界面未加载')
  await js(`(() => {const t=document.querySelector('.inspector textarea');if(!t)throw new Error('缺少笔记');t.focus();Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(t,'外部笔记 needle');t.dispatchEvent(new Event('input',{bubbles:true}));t.blur()})()`)
  await until(async () => (await call('get', [id]))[0].blocks.note?.data.text === '外部笔记 needle', '包内编辑未保存')
  check((await call('searchPage', { query: { search: [{ kind: 'note', field: 'text', text: 'needle' }] } })).items.some(r => r.id === id), '新笔记无法搜索')
  await shot('defaults-1-pack-ui.png')
  await settings(); await shot('defaults-2-groups.png')
  await select('note', false); await select('source', false)
  check(await js(`document.querySelector('[data-plugin-id="annotate"]').textContent.includes('需要「笔记」')`), '跨内外依赖没有预演')
  check((await call('externalPlugins')).filter(p => ['note','source'].includes(p.manifest.id)).every(p => p.enabled), '草稿提前写入')
  for (const p of initial.filter(p => !p.required && !['note','source'].includes(p.id))) await select(p.id, false)
  await apply(); await unchanged()
  check((await call('plugins')).filter(p => p.enabled).every(p => p.required), '无法只保留基础模块')
  await inspect(fixture.enabled.id)
  check(await js(`!document.querySelector('.inspector textarea') && document.querySelector('.inspector').textContent.includes('迁移保留的想法')`), '停用后未降级为只读')
  const bare = join(dir, '无可选插件.bin'); writeFileSync(bare, '原文件仍可保管')
  const [bareId] = await call('ingest', [{ type: 'file', path: bare }])
  check(readFileSync(await call('locateOriginalFile', { id: bareId, kind: 'file', field: 'path' })).equals(readFileSync(bare)), '基础文件接入或取回失败')
  await settings(); win.setSize(960, 720); await wait(250)
  check(await js(`document.querySelector('.settings').scrollWidth<=document.querySelector('.settings').clientWidth+1`), '窄窗口溢出')
  await shot('defaults-3-narrow.png')
  for (const id of ['note','source']) {
    await settingsScope(js, 'application')
    await click(`.package-row[data-package-id="${id}"] button`, '卸载…')
    await click('.package-dialog button', '卸载插件')
    await until(async () => !(await js('window.bridge.packages.list()')).find((r: any) => r.manifest.id === id)?.installed, '卸载未完成')
  }
  await settingsScope(js, 'library'); await unchanged(); await shot('defaults-4-uninstalled.png')
  log('插件分发首轮验证通过', { checks: ['旧库数据版本不变', '旧启停保持', '新库默认组合', '真实新文件加工和原字节', '包内来源与笔记编辑', '按字段搜索', '统一设置分组', '依赖预演及草稿隔离', '零可选组合收录取回', '只读保留', '卸载', '窄窗口'] })
}
