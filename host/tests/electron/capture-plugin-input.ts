import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BrowserWindow } from 'electron'
import { libraryOf, reloadLibrary } from '../../src/main/libraries'
import { localPackages } from '../../src/main/plugin-packages'
import { packageManifestSchema } from '../../src/shared/external-plugins'
import { encodePackage } from '../../src/plugin-packages/archive'
import { callCore } from '../../src/main/core-client'
import type { CoreApi } from '../../src/shared/rpc'

/** 公共契约集成：真实包＋工具绑定＋跨窗 DOM；业务边界使用临时仓库。 */
export async function pluginInputFlow(win: BrowserWindow, dir: string, choose: (label: string) => void) {
  const js = async (code: string) => { try { return await win.webContents.executeJavaScript(code) } catch (error) { throw new Error(`界面脚本失败：${code}`, { cause: error }) } }
  const wait = (ms = 120) => new Promise(r => setTimeout(r, ms))
  const until = async (test: () => Promise<unknown>, message: string) => {
    for (let i = 0; i < 100; i++) { if (await test()) return; await wait() }
    writeFileSync(join(dir, 'input-failure.json'), JSON.stringify({message, body: await js('document.body.innerText'), facets: await js(`Array.from(document.querySelectorAll('.collection-filters')).map(e=>({page:e.getAttribute('data-filter-page'),visible:!!e.getClientRects().length,text:e.innerText}))`), workspace: await js(`window.bridge.loadWorkspace(${JSON.stringify(libraryOf(win.webContents)!.id)})`)}, null, 2))
    throw Error(message)
  }
  const call = <K extends keyof CoreApi>(method: K, ...args: Parameters<CoreApi[K]>) => callCore(libraryOf(win.webContents)!.core, method, ...args)
  const snapshot = async () => { await wait(400); return js(`window.bridge.loadWorkspace(${JSON.stringify(libraryOf(win.webContents)!.id)})`) }
  const manifest = packageManifestSchema.parse({ formatVersion: 1, apiVersion: 1, id: 'input-probe', title: '输入接口验证', version: '1.0.0', author: 'test', description: '',
    uiFeatures: ['content-drop-v1', 'tool-placement-v1', 'context-tools-v1', 'bound-context-tools-v1'], entries: { ui: 'ui.mjs' } })
  const source = `const R=globalThis.__rmPluginSdk.react;
const Zone=()=>R.createElement('div',{'data-drop-zone':'txt','data-input-probe':true,style:{padding:20}},'拖入 TXT');
const query=(zone,context)=>{globalThis.__lastInputPage=context?.pageId;return zone==='txt'?{where:[{op:'eq',kind:'file',field:'ext',value:zone}]}:undefined};
export const plugin={id:'input-probe',windowProviders:[{id:'input-probe.host',order:1,Component:({host,children})=>{globalThis.__inputHost=host;return children}}],
navs:[{id:'input-probe.nav',order:99,dropQuery:query,Component:Zone}],toolViews:[
{id:'input-probe.ordinary',title:'接收工具',order:99,placement:{regions:['left','center','right']},dropQuery:query,Component:Zone},
{id:'input-probe.context',title:'上下文接收工具',order:-10,placement:{regions:['left','center','right']},context:{requires:['collection.filter'],detachable:{maxInstances:2}},dropQuery:query,Component:Zone}]};`
  localPackages().install(encodePackage(manifest, new Map([['ui.mjs', Buffer.from(source)]])))
  const pack = localPackages().list().find(p => p.manifest.id === manifest.id)!
  await js(`window.bridge.packages.apply({disabled:[],changes:[{hash:${JSON.stringify(pack.hash)},enabled:true}]})`)
  await reloadLibrary(libraryOf(win.webContents)!)
  await until(() => js(`!!globalThis.__inputHost && !!document.querySelector('[data-input-probe]')`), '探针未加载')
  const imported = async (name: string) => (await call('query', { where: [{ op: 'eq', kind: 'file', field: 'name', value: name }] })).ids
  const drop = async (selector: string, name: string, run = js) => {
    await run(`(()=>{const target=document.querySelector(${JSON.stringify(selector)});if(!target)throw Error('接收区域未显示');const dt=new DataTransfer();dt.items.add(new File(['temporary import '+${JSON.stringify(name)}],${JSON.stringify(name)},{type:'text/plain'}));for(const type of ['dragover','drop'])target.dispatchEvent(new DragEvent(type,{bubbles:true,cancelable:true,dataTransfer:dt}));})()`)
    await until(async () => (await imported(name)).length === 1, '没有完成收录：' + name)
    return (await imported(name))[0]
  }
  const menu = async (selector: string, title: string) => {
    choose(title); await js(`document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}))`)
  }
  await drop('[data-panel-content="host.navigation"] [data-input-probe]', 'nav.txt')
  await js(`globalThis.__inputHost.showView('input-probe.ordinary')`)
  await drop('[data-panel-content="input-probe.ordinary"] [data-input-probe]', 'ordinary.txt')
  await js(`globalThis.__inputHost.openTab('collection',{title:'来源 A',query:{}})`)
  const initial = await snapshot(), a = initial.active
  assert.equal(initial.tabs.find((t: any) => t.id === a).params.title, '来源 A')
  await until(() => js(`!!document.querySelector('[data-context-tool="input-probe.context"]')`), '智能工具缺失')
  await js(`document.querySelector('[data-context-tool="input-probe.context"]').click()`)
  await drop('.context-tool-content [data-input-probe]', 'context.txt')
  assert.equal(await js('globalThis.__lastInputPage'), a)
  await menu('[data-context-tool="input-probe.context"]', '在新窗口固定此工具')
  const children = () => BrowserWindow.getAllWindows().filter(w => w !== win && !w.isDestroyed() && w.webContents.getURL() === 'about:blank')
  await until(async () => children().length === 1, '固定工具没有移到小窗')
  const child = children()[0], cj = (code: string) => child.webContents.executeJavaScript(code)
  await until(() => cj(`!!document.querySelector('[data-input-probe]')`), '固定工具未呈现')
  await js(`document.querySelector('[data-tab="${a}"]').dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}))`)
  await js(`globalThis.__inputHost.openTab('collection',{title:'来源 B',query:{}})`)
  const next = await snapshot(), b = next.active
  assert.equal(next.tabs.find((t: any) => t.id === b).params.title, '来源 B')
  assert.notEqual(a, b)
  await drop('[data-input-probe]', 'fixed-window.txt', cj)
  assert.equal(await js('globalThis.__lastInputPage'), a, '固定工具误用了新焦点')
  // 来源关闭后固定工具明确不可用，不偷偷把新输入交给 B。
  await js(`document.querySelector('[data-tab="${a}"] [aria-label="关闭标签页"]').click()`)
  await until(() => cj(`!!document.querySelector('.context-tool-empty')`), '关闭来源未使固定工具失效')
  await cj(`(()=>{const dt=new DataTransfer();dt.items.add(new File(['blocked'],'closed-source.txt',{type:'text/plain'}));document.querySelector('.context-tool-empty').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt}))})()`)
  await wait(500); assert.equal((await imported('closed-source.txt')).length, 0)
  // 导航自身移入小窗；无需插件识别窗口或提供另一套接收逻辑。
  child.close(); await until(async () => !children().length, '固定工具未关闭')
  await menu('[id="tool-tab-host.navigation"]', '移到新窗口')
  await until(async () => children().length === 1, '导航未移窗')
  const nav = children()[0], nj = (code: string) => nav.webContents.executeJavaScript(code)
  await until(() => nj(`!!document.querySelector('[data-input-probe]')`), '小窗导航未显示')
  await drop('[data-input-probe]', 'nav-window.txt', nj)
  // 集合插件仍走同一导航收录协议，外部文件按目标组完成收录。
  const group = await call('run', 'collection', 'create', { title: '测试文件夹' }) as { id: string }
  await until(() => nj(`!!document.querySelector('[data-drop-zone="${group.id}"]')`), '文件夹入口未刷新')
  const member = await drop(`[data-drop-zone="${group.id}"]`, 'group.txt', nj)
  assert.equal((await call('get', [member]))[0].blocks.collectionMember.data.group, group.id)
  nav.close(); await until(async () => !children().length, '导航窗口未关闭')
  await until(async () => !(await snapshot()).editors.groups.some((g: any) => g.window), '工作区关闭流程未完成')
  // 模板块分面：默认单选替换，修饰键 AND 多选，其他标签条件保留。
  const one = await call('run', 'fields', 'createTemplate', { title: '模板一' }) as { kind: string }
  const two = await call('run', 'fields', 'createTemplate', { title: '模板二' }) as { kind: string }
  const ids = [(await imported('nav.txt'))[0], (await imported('ordinary.txt'))[0]]
  await call('put', ids[0], one.kind, {}); await call('put', ids[0], two.kind, {}); await call('put', ids[1], two.kind, {})
  await call('put', ids[0], 'tags', { values: ['测试'] }); await call('put', ids[1], 'tags', { values: ['测试'] })
  await js(`globalThis.__inputHost.openTab('collection',{title:'模板筛选',query:{where:[{op:'eq',kind:'tags',field:'values',value:'测试'}]}})`)
  await until(async () => (await snapshot()).tabs.some((t: any) => t.params.title === '模板筛选'), '模板筛选页未保存')
  const filterPage = (await snapshot()).tabs.find((t: any) => t.params.title === '模板筛选').id
  const filterRoot = `.collection-filters[data-filter-page="${filterPage}"]`
  await js(`globalThis.__inputHost.showView('host.filters')`)
  await until(() => js(`!!document.querySelector('${filterRoot} .fields-facet')`), '筛选工具未出现')
  const row = (kind: string) => `${filterRoot} [data-template-facet="${kind}"]`
  await until(() => js(`document.querySelector('${row(two.kind)} .nav-count')?.textContent==='2'`), '模板批量计数不正确')
  const pick = async (kind: string, multi = false) => { await js(`document.querySelector('${row(kind)} button').dispatchEvent(new MouseEvent('click',{bubbles:true,metaKey:${multi}}))`); await wait() }
  const has = async () => { const w = await snapshot(); return w.tabs.find((t: any) => t.id === w.active).state.criteria.has ?? [] }
  await pick(one.kind); assert.deepEqual(await has(), [one.kind])
  await pick(two.kind); assert.deepEqual(await has(), [two.kind])
  await pick(one.kind, true); assert.deepEqual(await has(), [two.kind, one.kind])
  assert.equal(await js(`document.querySelector('${row(two.kind)} .nav-count').textContent`), '2', '自身临时 has 污染兄弟计数')
  await pick(two.kind); assert.deepEqual(await has(), [two.kind])
  await pick(two.kind); assert.deepEqual(await has(), [])
  // 只拦截计数 RPC（React 调度也会发送空消息）；失败需给出错误与重试，不能保留旧数字。
  await js(`globalThis.__inputPost=MessagePort.prototype.postMessage;MessagePort.prototype.postMessage=function(m,...args){if(m?.method==='kindCounts'){queueMicrotask(()=>this.dispatchEvent(new MessageEvent('message',{data:{id:m.id,error:'测试计数失败'}})));return}return globalThis.__inputPost.call(this,m,...args)};void 0`)
  await js(`document.querySelector('${filterRoot} .fields-facet [aria-label="整理模板"]').click()`)

  try {
    await until(() => js(`!!document.querySelector('${filterRoot} .fields-facet [role="alert"]')`), '计数失败没有反馈')
    assert.equal(await js(`document.querySelector('${row(two.kind)} .nav-count').textContent`), '—', '错误仍显示旧计数')
  } finally { await js(`MessagePort.prototype.postMessage=globalThis.__inputPost;void 0`) }
  await js(`document.querySelector('${filterRoot} .fields-facet [role="alert"] button').click()`)
  await until(() => js(`!document.querySelector('${filterRoot} .fields-facet [role="alert"]') && document.querySelector('${row(two.kind)} .nav-count')?.textContent==='2'`), '计数重试没有恢复')
  writeFileSync(join(dir, 'plugininput-result.json'), JSON.stringify({ navigation: true, ordinary: true, context: true, fixedWindow: true, navigationWindow: true, collection: true, blockFacets: true }, null, 2))
}
