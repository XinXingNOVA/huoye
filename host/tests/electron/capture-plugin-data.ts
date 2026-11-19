import { findSettingsSurface, settingsScript } from './settings-surface'
import { pluginLocalDataFlow } from './capture-plugin-local'
import { commonPluginDataFlow } from './capture-plugin-data-common'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { libraryOf, reloadLibrary } from '../../src/main/libraries'
import { callCore } from '../../src/main/core-client'
import { localPackages } from '../../src/main/plugin-packages'
import { encodePackage } from '../../src/plugin-packages/archive'
import { packageManifestSchema } from '../../src/shared/external-plugins'

/** 真实包加载、utilityProcess 加工、停用重载及缺包清理；只使用测试声明。 */
export async function pluginDataFlow(win: BrowserWindow, dir: string) {
  const lib = libraryOf(win.webContents)!
  const ready = async () => {
    for (let n = 0; n < 200; n++) {
      try { if (await win.webContents.executeJavaScript("!!document.querySelector('.app')")) return } catch { /* 重载过渡 */ }
      await new Promise(r => setTimeout(r, 100))
    }
    throw new Error('仓库界面未就绪')
  }
  await ready()
  const until = async (fn: () => Promise<unknown> | unknown, label: string) => {
    for (let n = 0; n < 150; n++) { try { if (await fn()) return } catch { /* 窗口重建过渡。 */ } await new Promise(r => setTimeout(r, 100)) }
    throw new Error(label)
  }
  const ui = (code: string) => settingsScript(win, code)
  const click = async (label: string) => {
    await ui(`(()=>{const b=[...document.querySelectorAll('.plugin-data-maintenance button')].find(b=>b.checkVisibility()&&b.textContent.trim()===${JSON.stringify(label)});if(!b||b.disabled)throw Error('按钮不可用');b.click()})()`)
  }
  const openMaintenance = async () => {
    win.webContents.send('menu:command', 'settings')
    await until(() => findSettingsSurface(win), '设置窗口未打开')
    await until(() => ui("!![...document.querySelectorAll('.settings-nav-scroll button')].find(b=>b.textContent.includes('数据与维护'))"), '设置导航未就绪')
    await ui("[...document.querySelectorAll('.settings-nav-scroll button')].find(b=>b.textContent.includes('数据与维护')).click()")
    await ui("[...document.querySelectorAll('[aria-label=数据与维护] button')].find(b => b.textContent === '插件数据与偏好重置').click()")
    await until(() => ui(`!!document.querySelector('[data-plugin-data-row="lifecycle-probe"] button')`), '插件数据列表未显示')
    await ui(`document.querySelector('[data-plugin-data-row="lifecycle-probe"] button').click()`)
    await until(() => ui(`!!document.querySelector('[data-plugin-data-preview]')`), '预览未显示')
  }
  const manager = localPackages()
  const ref = manager.install(encodePackage(packageManifestSchema.parse({ formatVersion: 1, apiVersion: 1,
    id: 'lifecycle-probe', title: '生命周期验证', description: '', author: 'test', version: '1.0.0', requires: ['file'],
    coreFeatures: ['data-lifecycle-v1'], entries: { core: 'core.mjs' } }), new Map([['core.mjs', Buffer.from(`
import {writeFileSync} from 'node:fs';
export const blocks=[
{id:'lifecycle-probe-mark',plugin:'lifecycle-probe',title:'标记',version:1,rebuildable:false,fields:{text:{type:'text',title:'内容'}}},
{id:'lifecycle-probe-record',plugin:'lifecycle-probe',title:'记录',version:1,rebuildable:false,content:true,standalone:true,fields:{text:{type:'text',title:'内容'}}},
{id:'lifecycle-probe-cache',plugin:'lifecycle-probe',title:'缓存',version:1,rebuildable:true,fields:{path:{type:'text',title:'缓存',file:true}}}];
export const plugin={id:'lifecycle-probe',version:1,blocks,dataLifecycle:{version:1,disposableRecords:['lifecycle-probe-record']},
systems:[{id:'lifecycle-probe.cache',priority:1,has:['file'],outputs:['lifecycle-probe-cache'],async run(ctx,id){const path=ctx.cacheDir('lifecycle-probe')+'/'+id+'.txt';writeFileSync(ctx.abs(path),'derived');return {'lifecycle-probe-cache':{path}}}}]};
`)]])))
  manager.grant(lib.root, ref.hash)
  await callCore(lib.core, 'setExternalPlugin', { ...ref, enabled: true })
  await reloadLibrary(lib); await ready()
  const state = (await callCore(lib.core, 'plugins')).find(p => p.id === ref.manifest.id)
  assert(state?.enabled, JSON.stringify(state))
  const [id] = await callCore(lib.core, 'ingest', [{ type: 'bytes', name: 'new-original.txt', bytes: Buffer.from('new file') }])
  let cache = ''
  for (let n = 0; n < 100; n++) {
    cache = String((await callCore(lib.core, 'get', [id]))[0]?.blocks['lifecycle-probe-cache']?.data.path ?? '')
    if (cache) break
    await new Promise(r => setTimeout(r, 100))
  }
  assert(cache && existsSync(join(lib.root, cache)), '新文件未在 utilityProcess 加工出缓存')
  await callCore(lib.core, 'put', id, 'lifecycle-probe-mark', { text: 'remove this' })
  const record = await callCore(lib.core, 'create', { 'lifecycle-probe-record': { text: 'remove record' } })
  assert((await callCore(lib.core, 'previewPluginDataCleanup', { pluginId: ref.manifest.id, mode: 'all' })).blocked.length)
  await openMaintenance()
  assert(await ui("document.querySelector('.plugin-data-blocked').textContent.includes('停用')"))
  assert(!(await ui("!!document.querySelector('[data-plugin-data-execute]')")), '运行中的插件出现清理确认按钮')
  await click('前往功能与方案')
  await until(() => ui(`document.querySelector('[data-settings-section="plugins"]')?.checkVisibility()`), '没有跳到现有启停页面')
  findSettingsSurface(win)!.close()
  await until(() => !findSettingsSurface(win), '设置未关闭')
  await callCore(lib.core, 'setExternalPlugin', { ...ref, enabled: false })
  await reloadLibrary(lib); await ready()
  assert((await callCore(lib.core, 'get', [id]))[0].blocks['lifecycle-probe-mark'], '停用意外删除数据')
  manager.uninstall(ref.hash)
  await reloadLibrary(lib); await ready()
  const info = (await callCore(lib.core, 'listPluginData')).find(p => p.pluginId === ref.manifest.id)!
  assert(info.declared && !info.enabled && info.persistentBlocks === 2)
  await openMaintenance()
  assert(await ui("document.querySelector('[data-plugin-data-preview]').textContent.includes('标记')"))
  assert(await ui("document.querySelector('[data-plugin-data-execute]').disabled"), '未经确认可执行清理')
  // 先制造过期预览；界面必须要求重读，不能静默用新计划执行。
  await callCore(lib.core, 'patch', id, 'file', { name: 'changed.txt' })
  await ui("document.querySelector('.plugin-data-confirm input').click()")
  await click('确认清理')
  await until(() => ui("document.querySelector('.plugin-data-maintenance [role=alert]')?.textContent.includes('PLUGIN_DATA_CHANGED')"), '未反馈过期预览')
  assert((await callCore(lib.core, 'get', [id]))[0].blocks['lifecycle-probe-mark'])
  await click('重新预览')
  await until(() => ui("!!document.querySelector('.plugin-data-confirm input')"), '重新预览未完成')
  await ui("document.querySelector('[data-plugin-data-detail]').scrollIntoView({block:'start'})")
  writeFileSync(join(dir, 'plugin-data-preview.png'), (await findSettingsSurface(win)!.webContents.capturePage()).toPNG())
  // 真实 unlink 失败：记录成功提交，缓存待重试。测试仅修改临时库目录权限。
  const cacheDirectory = dirname(join(lib.root, cache))
  chmodSync(cacheDirectory, 0o500)
  try {
    await ui("document.querySelector('.plugin-data-confirm input').click()")
    await click('确认清理')
    await until(() => ui("document.querySelector('[data-plugin-data-result]')?.textContent.includes('缓存待重试')"), '未反馈缓存部分失败')
    assert.deepEqual(await callCore(lib.core, 'get', [record]), [])
    assert(existsSync(join(lib.root, cache)))
    // 关闭再打开，仍从宿主回执发现待重试项目。
    findSettingsSurface(win)!.close(); await until(() => !findSettingsSurface(win), '结果窗口未关闭')
    await openMaintenance()
    assert(await ui("!!document.querySelector('[data-plugin-data-retry]')"))
  } finally { chmodSync(cacheDirectory, 0o700) }
  await click('重试缓存清理')
  await until(() => ui("document.querySelector('[data-plugin-data-result]')?.textContent.includes('本次清理完成')"), '缓存重试结果未显示')
  writeFileSync(join(dir, 'plugin-data-result.png'), (await findSettingsSurface(win)!.webContents.capturePage()).toPNG())
  const result = await callCore(lib.core, 'retryPluginDataCleanup', { pluginId: ref.manifest.id })
  assert(result.resetSchema && result.entities === 1 && result.removedCaches === 1)
  assert.deepEqual(await callCore(lib.core, 'get', [record]), [])
  const view = (await callCore(lib.core, 'get', [id]))[0]
  assert(view.blocks.file && !view.blocks['lifecycle-probe-mark'])
  assert.equal((await callCore(lib.core, 'fileStorageInfo', id)).state, 'available')
  assert(!existsSync(join(lib.root, cache)))
  await reloadLibrary(lib); await ready()
  assert.deepEqual(await callCore(lib.core, 'retryPluginDataCleanup', { pluginId: ref.manifest.id }), result)
  const local = await pluginLocalDataFlow(win, dir)
  const common = await commonPluginDataFlow(win)
  writeFileSync(join(dir, 'plugindata-result.json'), JSON.stringify({ ok: true, result, local, common }, null, 2))
}
