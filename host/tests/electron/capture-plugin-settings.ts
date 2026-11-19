import { packageActionScope, afterPackageAction, finishPackageInstall, settingsScope } from './capture-settings'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { callCore } from '../../src/main/core-client'
import { libraryOf } from '../../src/main/libraries'
import { selectCapturePackage } from '../../src/main/plugin-packages'
import { encodePackage } from '../../src/plugin-packages/archive'
import { packageManifestSchema } from '../../src/shared/external-plugins'
import type { CoreApi } from '../../src/shared/rpc'

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
interface Tools { js(code: string): Promise<any>; log(label: string, value: unknown): void; shot(name: string): Promise<void> }
export async function pluginSettingsFlow(win: BrowserWindow, dir: string, { js, log, shot }: Tools) {
  const lib = () => libraryOf(win.webContents)!
  const call = <K extends keyof CoreApi>(method: K, ...args: Parameters<CoreApi[K]>) => callCore(lib().core, method, ...args)
  const check = (ok: unknown, message: string) => { if (!ok) throw new Error(message) }
  const until = async (test: () => Promise<unknown>, message: string) => {
    for (let i = 0; i < 160; i++) { try { if (await test()) return } catch { /* 页面重载中 */ } await wait(100) }
    throw new Error(message)
  }
  const click = async (selector: string, label: string) => {
    await packageActionScope(js, label)
    check(await js(`(() => {const b=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>e.getClientRects().length && e.textContent.trim()===${JSON.stringify(label)});if(!b||b.disabled)return false;b.click();return true})()`), `按钮不可用：${label}`)
    await wait(150)
    await afterPackageAction(js, selector, label)
  }
  const checkbox = async (id: string, checked: boolean, version?: string) => {
    check(await js(`(() => {const c=document.querySelector('.package-row[data-package-id="${id}"]${version ? `[data-package-version="${version}"]` : ''} input');if(!c||c.disabled)return false;if(c.checked!==${checked})c.click();return true})()`), `无法勾选 ${id}`)
    await wait(100)
  }
  const builtin = async (title: string, checked: boolean) => {
    check(await js(`(() => {const c=[...document.querySelectorAll('.plugin-row')].find(r=>r.querySelector('.plugin-title').textContent.trim()===${JSON.stringify(title)})?.querySelector('input');if(!c||c.disabled)return false;if(c.checked!==${checked})c.click();return true})()`), `无法勾选 ${title}`)
    await wait(100)
  }
  const enabled = async (id: string) => !!(await call('plugins')).find(p => p.id === id)?.enabled
  const apply = async (test: () => Promise<unknown>) => {
    const previous = lib().core
    let loads = 0
    // 一次仓库重载先进入 about:blank 收尾，再打开应用页；只数应用页导航。
    const count = (_event: Electron.Event, url: string) => { if (url !== 'about:blank') loads++ }
    win.webContents.on('did-navigate', count)
    try {
      await click('.settings-foot button', '应用并重新加载')
      await until(async () => lib().core !== previous && !lib().reloading && await js(`!!document.querySelector('.tab-pane:not(.hidden) .package-settings')`) && await test(), '统一应用未完成')
      await wait(400)
      check(loads === 1, `本批重载了 ${loads} 次`)
    } finally { win.webContents.off('did-navigate', count) }
  }
  const pack = (version: string, code = 'export const plugin={id:"demo-batch"}') => {
    const file = join(dir, `batch-${version}.rmplugin`)
    writeFileSync(file, encodePackage(packageManifestSchema.parse({ id: 'demo-batch', title: '批量验证', description: '需要笔记的验证包', author: '测试', version, apiVersion: 1, formatVersion: 1, entries: { ui: 'ui.mjs' }, requires: ['note'] }), new Map([['ui.mjs', Buffer.from(code)]])))
    return file
  }
  const install = async (file: string, choose: boolean) => {
    selectCapturePackage(file)
    await click('.package-heading button', '安装套件或插件包…')
    await until(() => js(`!!document.querySelector('.package-dialog')`), '未显示安装预览')
    await finishPackageInstall(js, choose)
    await until(() => js(`!document.querySelector('.package-dialog')`), '安装确认没有关闭')
  }

  const [id] = await call('ingest', [{ type: 'text', text: '批量切换插件时保留的数据' }])
  await call('put', id, 'status', { value: '进行中' })
  const before = (await call('get', [id]))[0].blocks.status
  win.webContents.send('menu:command', 'settings')
  await until(() => js(`!!document.querySelector('.package-choice input')`), '设置未载入')
  const search = async (text: string) => {
    await js(`(() => {const e=document.querySelector('input[aria-label="搜索插件"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(text)});e.dispatchEvent(new Event('input',{bubbles:true}))})()`)
    await wait(150)
  }
  check(await js(`document.querySelector('[data-plugin-id="note"]').closest('[data-plugin-group]').dataset.pluginGroup==='information' && !document.querySelector('[data-plugin-group="support"]').open && !document.querySelector('[data-plugin-group="core"]').open`), '用途分组或支持组件折叠错误')
  await shot('catalog-1-overview.png')
  await search('摘录')
  check(await js(`!!document.querySelector('[data-plugin-id="annotate"]') && !document.querySelector('[data-plugin-id="image"]')`), '关键词检索未找到批注摘录')
  await js(`document.querySelector('[data-plugin-id="annotate"] .plugin-details summary').click()`)
  check(await js(`document.querySelector('[data-plugin-id="annotate"] .plugin-details').open && document.querySelector('[data-plugin-id="annotate"]').textContent.includes('使用入口')`), '详情未展开')
  await shot('catalog-2-excerpts-details.png'); await search('')
  await builtin('笔记', false); await builtin('预览', false)
  const beforeDependency = lib().core
  await click('[data-plugin-id="annotate"] button', '一并启用依赖')
  check(await js(`document.querySelector('[data-plugin-id="note"] input').checked && document.querySelector('[data-plugin-id="preview"] input').checked && !document.querySelector('[data-plugin-id="annotate"] .plugin-warn')`), '依赖未一并恢复')
  check(lib().core === beforeDependency, '补齐依赖提前重载')
  await search('不存在的插件')
  check(await js(`document.querySelector('.plugin-empty').textContent.includes('没有符合条件')`), '空结果无反馈')
  await click('.plugin-empty button', '清除筛选')
  await settingsScope(js, 'application')
  check(await js(`document.querySelector('.application-settings-nav').textContent.includes('MCP')`), 'MCP 入口被移动')
  await shot('catalog-3-installed.png'); await settingsScope(js, 'library')
  const first = lib().core
  const draftOff = async () => { await checkbox('status', false); await checkbox('kanban', false); await builtin('笔记', false) }
  await draftOff()
  check(lib().core === first && await enabled('status') && await enabled('kanban') && await enabled('note'), '勾选时就改变了装配')
  check((await call('externalPlugins')).every(b => b.enabled), '草稿提前写入仓库')
  await click('.package-row[data-package-id="status"] button', '卸载…')
  check(await js(`document.querySelector('.package-dialog').textContent.includes('先取消勾选并应用更改') && document.querySelector('.package-danger').disabled`), '未应用停用就允许删除正在运行的包')
  await click('.package-dialog button', '取消')
  await shot('batch-1-pending.png')
  await click('.settings-foot button', '还原更改')
  check(await js(`[...document.querySelectorAll('.package-choice input')].every(c=>c.checked) && !document.querySelector('.settings-foot .primary:not(:disabled)')`), '还原没有同时撤下内外草稿')
  await draftOff(); await apply(async () => !await enabled('status') && !await enabled('kanban') && !await enabled('note'))
  check(JSON.stringify((await call('get', [id]))[0].blocks.status) === JSON.stringify(before), '批量停用改写数据')
  await checkbox('status', true); await checkbox('kanban', true); await builtin('笔记', true)
  await apply(async () => await enabled('status') && await enabled('kanban') && await enabled('note'))

  const file = pack('1.0.0')
  await checkbox('status', false)
  await install(file, true)
  check(await js(`!document.querySelector('.package-row[data-package-id="status"] input').checked && document.querySelector('.package-row[data-package-id="demo-batch"] input').checked`), '安装新包丢失其他待应用选择')
  check(await enabled('status') && !await enabled('demo-batch'), '安装并勾选立即生效')
  await builtin('笔记', false)
  check(await js(`document.querySelector('.package-row[data-package-id="demo-batch"]').textContent.includes('需要「笔记」')`), '内置依赖的草稿没有参与预演')
  await builtin('笔记', true)
  const hash = (await js('window.bridge.packages.list()')).find((r: any) => r.manifest.id === 'demo-batch').hash
  // 模拟另一入口卸载了尚未启用的包，应用时必须重新核对整批。
  await js(`window.bridge.packages.uninstall(${JSON.stringify(hash)})`)
  const unchangedCore = lib().core
  await click('.settings-foot button', '应用并重新加载')
  await until(() => js(`document.querySelector('.settings-foot [role="alert"]')?.textContent.includes('未安装')`), '失败没有显示可恢复错误')
  check(lib().core === unchangedCore && await enabled('status') && (await call('externalPlugins')).find(b => b.manifest.id === 'status')?.enabled, '失败提交了部分更改或重载')
  check(await js(`!document.querySelector('.package-row[data-package-id="status"] input').checked && document.querySelector('.package-row[data-package-id="demo-batch"] input').checked && !document.querySelector('.settings-foot .primary').disabled`), '失败没有保留可重试的草稿')
  await shot('batch-2-failure-preserved.png')
  await install(file, false)
  await apply(async () => !await enabled('status') && await enabled('demo-batch'))
  await install(pack('2.0.0'), true)
  check(await js(`[...document.querySelectorAll('.package-row[data-package-id="demo-batch"] input')].filter(c=>c.checked).length===1 && document.querySelector('.package-row[data-package-version="2.0.0"] input').checked`), '同一插件多个版本同时被勾选')
  check((await call('externalPlugins')).find(b => b.manifest.id === 'demo-batch')?.manifest.version === '1.0.0', '选版本时提前改写绑定')
  await checkbox('status', true)
  await apply(async () => await enabled('status') && (await call('plugins')).find(p => p.id === 'demo-batch')?.external?.version === '2.0.0')
  check(await js(`document.querySelector('[data-plugin-id="demo-batch"]').closest('[data-plugin-group]').dataset.pluginGroup==='other'`), '旧包没有回退到其他分类')
  win.setSize(960, 720); await wait(250)
  check(await js(`document.querySelector('.settings').scrollWidth<=document.querySelector('.settings').clientWidth+1`), '窄窗口设置溢出')
  await shot('batch-3-applied-narrow.png')
  await js(`(() => {const e=document.querySelector('select[aria-label="插件分类"]');e.value='support';e.dispatchEvent(new Event('change',{bubbles:true}))})()`)
  await wait(150)
  check(await js(`document.querySelector('[data-plugin-group="support"]').open && !document.querySelector('[data-plugin-id="note"]')`), '支持组件分类筛选不正确')
  await shot('catalog-4-support-narrow.png')
  await js(`(() => {const e=document.querySelector('select[aria-label="插件分类"]');e.value='all';e.dispatchEvent(new Event('change',{bubbles:true}))})()`)
  await wait(150); await builtin('笔记', false)
  await js(`(() => {const e=document.querySelector('select[aria-label="插件状态"]');e.value='pending';e.dispatchEvent(new Event('change',{bubbles:true}))})()`)
  await wait(150)
  check(await js(`document.querySelectorAll('[data-plugin-id]').length===1 && document.querySelector('[data-plugin-id="note"]')`), '待应用筛选错误')
  await click('.settings-foot button', '还原更改')
  await js(`(() => {const e=document.querySelector('select[aria-label="插件状态"]');e.value='all';e.dispatchEvent(new Event('change',{bubbles:true}))})()`)
  await settingsScope(js, 'application')
  await js(`document.querySelector('.application-settings [data-package-id="annotate"] .plugin-details summary').click()`)
  check(await js(`document.querySelector('.application-settings .settings-content').scrollWidth<=document.querySelector('.application-settings .settings-content').clientWidth+1`), '窄窗口安装包详情溢出')
  await shot('catalog-5-installed-narrow.png')
  log('内外插件统一勾选通过', { checks: ['功能分类与旧包回退', '关键词搜索与详情', '支持组件折叠', '分类与状态筛选', '依赖补齐只改草稿', 'MCP 入口保持', '草稿不写入或重载', '在用包仍禁止卸载', '还原更改', '内外插件一起应用且仅重载一次', '原数据保留', '安装不打断其他草稿', '依赖预演', '缺包整批失败及保留勾选', '重试提交', '版本互斥与切换', '窄窗口列表与详情'] })
}
