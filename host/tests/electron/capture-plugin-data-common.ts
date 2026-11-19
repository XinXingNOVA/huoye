import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import type { BrowserWindow } from 'electron'
import type { CoreApi } from '../../src/shared/rpc'
import { libraryOf, reloadLibrary } from '../../src/main/libraries'
import { localPackages } from '../../src/main/plugin-packages'
import { callCore } from '../../src/main/core-client'

/** 可选跨插件集成：由独立工程提供已打包产物，不复制业务源码到宿主测试。 */
export async function commonPluginDataFlow(win: BrowserWindow) {
  const packagesFile = process.env.RM_LIFECYCLE_PACKAGES_FILE
  if (!packagesFile) return { skipped: true }
  const paths = JSON.parse(readFileSync(packagesFile, 'utf8')) as string[]
  const lib = libraryOf(win.webContents)!, manager = localPackages()
  const call = <K extends keyof CoreApi>(method: K, ...args: Parameters<CoreApi[K]>) => callCore(lib.core, method, ...args)
  const refs = paths.map(path => manager.install(readFileSync(path)))
  const enable = async (id: string, enabled: boolean) => {
    const ref = refs.find(ref => ref.manifest.id === id)!
    assert(ref, id + ' 缺少测试包')
    await call('setExternalPlugin', { ...ref, enabled })
  }
  const reload = async () => {
    await reloadLibrary(lib)
    for (let n = 0; n < 150; n++) {
      try { if (await win.webContents.executeJavaScript("!!document.querySelector('.app')")) return } catch { /* 重载 */ }
      await new Promise(r => setTimeout(r, 100))
    }
    throw Error('公共插件测试仓库未就绪')
  }
  const clean = async (id: string) => {
    const plan = await call('previewPluginDataCleanup', { pluginId: id, mode: 'all' })
    assert.deepEqual(plan.blocked, [], id)
    const result = await call('cleanupPluginData', { pluginId: id, mode: 'all', token: plan.token })
    assert(result.resetSchema, JSON.stringify(result))
    return result
  }
  for (const ref of refs) { manager.grant(lib.root, ref.hash); await enable(ref.manifest.id, true) }
  await win.webContents.executeJavaScript(`localStorage.setItem(${JSON.stringify('tag-groups:collapsed:'+lib.root)},'["legacy-group-id"]');localStorage.setItem(${JSON.stringify('tag-tree:collapsed:'+lib.root)},'["Math"]')`)
  await reload()
  const loaded = await call('plugins')
  for (const id of ['tags', 'tag-groups', 'tag-tree', 'fields', 'table']) assert(loaded.find(p => p.id === id)?.enabled, id)
  const [file] = await call('ingest', [{ type: 'bytes', name: 'common-original.txt', bytes: Buffer.from('new original for plugin integration') }])
  await call('run', 'tags', 'update', { ids: [file], add: ['Logic'] })
  const legacy = await call('create', { tagGroups: { groups: [{ id: 'old', title: '旧分组', tags: ['Logic'] }] } })
  const groupCount = async () => (await call('executeQuery', { query: 'tag-groups.list_groups' })).result.total
  assert.equal(await groupCount(), 0, '旧分组不能自动复活')
  await call('run', 'tag-groups', 'importLegacy', {})
  assert.equal(await groupCount(), 1)
  await assert.rejects(call('run', 'tag-groups', 'importLegacy', {}), /不能覆盖/)
  await call('run', 'tag-tree', 'setParent', { tag: 'Logic', parent: 'Math' })
  const template = await call('create', { template: { title: '集成模板', fields: [{ id: 'f01', title: '备注', type: 'text' }] } })
  await call('put', file, 'tpl:' + template, { f01: 'keep until explicit cleanup' })
  const state = (plugin: string, action = 'get') => win.webContents.executeJavaScript(`window.bridge.pluginLocal.state(${JSON.stringify(plugin)},'library',${JSON.stringify(action)},'collapsed')`)
  const until = async (code: string) => {
    for (let n=0;n<150;n++) { if(await win.webContents.executeJavaScript(code)) return; await new Promise(r=>setTimeout(r,100)) }
    throw Error('标签状态未就绪：'+code)
  }
  await until(`!!document.querySelector('.tag-group-toggle:not(:disabled)') && !!document.querySelector('.tree-toggle:not(:disabled)')`)
  assert.deepEqual(await state('tag-groups'), ['legacy-group-id'])
  assert.deepEqual(await state('tag-tree'), ['Math'])
  assert.equal(await win.webContents.executeJavaScript(`localStorage.getItem(${JSON.stringify('tag-tree:collapsed:'+lib.root)})`), null)
  assert.equal(await win.webContents.executeJavaScript(`document.querySelector('.tree-toggle').getAttribute('aria-expanded')`), 'false')
  await win.webContents.executeJavaScript(`document.querySelector('.tag-group-toggle').click();document.querySelector('.tree-toggle').click()`)
  await until(`!document.querySelector('.tag-group-toggle').disabled && !document.querySelector('.tree-toggle').disabled && document.querySelector('.tag-group-toggle').getAttribute('aria-expanded')==='false' && document.querySelector('.tree-toggle').getAttribute('aria-expanded')==='true'`)
  assert.equal((await state('tag-groups')).length, 2)
  assert.deepEqual(await state('tag-tree'), [])
  const treeIds = (await call('query', { scope: 'all', has: ['tag-tree.node'] })).ids
  assert(treeIds.length > 0)
  for (const id of ['tag-groups', 'tag-tree', 'fields']) await enable(id, false)
  await reload()
  assert((await call('get', [file]))[0].blocks['tpl:' + template], '停用删除了字段')
  // 本机重置不影响关系块；重新加载仍拒绝旧 localStorage 回流。
  for (const pluginId of ['tag-groups','tag-tree']) {
    const request = {pluginId,scope:'library',categories:['state']}
    await win.webContents.executeJavaScript(`(async()=>{const request=${JSON.stringify(request)},plan=await window.bridge.pluginLocal.preview(request);if(plan.blocked.length)throw Error(plan.blocked.join(';'));await window.bridge.pluginLocal.clean({...request,token:plan.token})})()`)
  }
  assert.equal((await call('query', { scope: 'all', has: ['tag-groups.groups'] })).ids.length, 1)
  await win.webContents.executeJavaScript(`localStorage.setItem(${JSON.stringify('tag-groups:collapsed:'+lib.root)},'["legacy-group-id"]');localStorage.setItem(${JSON.stringify('tag-tree:collapsed:'+lib.root)},'["Math"]')`)
  await enable('tag-groups',true); await enable('tag-tree',true); await reload()
  await until(`document.querySelector('.tree-toggle:not(:disabled)')?.getAttribute('aria-expanded')==='true' && document.querySelector('.tag-group-toggle:not(:disabled)')?.getAttribute('aria-expanded')==='true'`)
  assert.equal(await state('tag-groups'),undefined); assert.equal(await state('tag-tree'),undefined)
  await enable('tag-groups',false); await enable('tag-tree',false); await reload()
  const groups = await clean('tag-groups')
  assert((await call('get', [legacy]))[0].blocks.tagGroups, '分组插件删了基础插件的旧备份')
  assert.equal((await call('get', treeIds)).length, treeIds.length, '分组清理影响层级目录')
  await enable('tag-groups', true); await reload()
  assert.equal(await groupCount(), 0, '清理后重新启用又读回旧分组')
  const tree = await clean('tag-tree')
  assert.deepEqual(await call('get', treeIds), [])
  const fields = await clean('fields')
  assert.deepEqual(await call('get', [template]), [])
  const material = (await call('get', [file]))[0]
  assert(!material.blocks['tpl:' + template] && material.blocks.file)
  assert.deepEqual(material.blocks.tags.data.values, ['Logic'])
  assert((await call('plugins')).find(p => p.id === 'table')?.enabled, '纯界面表格不应被连带关闭')
  await enable('tag-groups', false); await enable('tags', false); await reload()
  const tags = await clean('tags')
  assert.deepEqual(await call('get', [legacy]), [])
  assert(!(await call('get', [file]))[0].blocks.tags)
  assert.equal((await call('fileStorageInfo', file)).state, 'available')
  return { groups, tree, fields, tags }
}
