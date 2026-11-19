import { pluginSource } from '../helpers/plugin-sources.mjs'
// 真实 Electron utilityProcess + MCP stdio；仅使用独立临时仓库。
// npm run build 后运行 node tests/electron/collection-check.mjs。
import { build } from 'esbuild'
import sharp from 'sharp'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, createWriteStream, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const project = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
process.chdir(project)
const dir = mkdtempSync(join(tmpdir(), 'rm-collection-')), helper = resolve('artifacts/checks/collection-prepare.cjs')
mkdirSync(dirname(helper), { recursive: true })
await build({ entryPoints: ['tests/electron/collection-prepare.ts'], outfile: helper, bundle: true, platform: 'node', format: 'cjs', target: 'node24', external: ['better-sqlite3'] })
const exampleSource=join(dir,'plugin-source'),examplePackage=join(dir,'collection.rmplugin')
cpSync(pluginSource("collection"),exampleSource,{recursive:true})
execFileSync(process.execPath,['scripts/plugins/pack.ts',exampleSource,examplePackage],{cwd:project,stdio:'inherit'})
execFileSync(process.execPath, [helper, dir, examplePackage], { cwd: project, stdio: 'inherit' })
const prepared = JSON.parse(readFileSync(join(dir, 'prepared.json'), 'utf8'))
await sharp({create:{width:640,height:420,channels:3,background:'#547c86'}}).png().toFile(join(dir,'封面.png'))
const delay = ms => new Promise(r => setTimeout(r, ms))
async function until(fn, label, timeout = 30000) { const start = Date.now(); let error; while (Date.now() - start < timeout) { try { const value = await fn(); if (value) return value } catch (e) { error = e } await delay(100) }; throw new Error(`${label}${error ? `: ${error.message}` : ''}`) }
let child, socket, serial = 0
const pending = new Map(), errors = []
function send(method, params = {}) {
  const id = ++serial
  return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })) })
}
async function js(expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
  return result.result?.value
}
const call = (method, ...args) => js(`window.transactionTestCore(${JSON.stringify(method)}, ${JSON.stringify(args)})`)
async function connectCore() {
  await js(`new Promise(resolve => { const handler = e => { if(e.source!==window||e.data!=='core:port')return; window.removeEventListener('message',handler); const port=e.ports[0],pending=new Map();let n=0;port.onmessage=e=>{const m=e.data,p=pending.get(m.id);if(!p)return;pending.delete(m.id);m.error?p.reject(Error(m.error)):p.resolve(m.result)};window.transactionTestCore=(method,args)=>new Promise((resolve,reject)=>{const id=++n;pending.set(id,{resolve,reject});port.postMessage({id,method,args})});resolve(true) };window.addEventListener('message',handler);window.bridge.connectCore() })`)
}
async function start(round) {
  const env = { ...process.env, RM_USER_DATA: prepared.userData, LIBRARY_PATH: prepared.root }
  delete env.CAPTURE_DIR; delete env.CAPTURE_FLOW; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
  const portFile = join(prepared.userData, 'DevToolsActivePort'), old = existsSync(portFile) ? readFileSync(portFile, 'utf8') : ''
  child = spawn(resolve('node_modules/.bin/electron'), ['.', '--remote-debugging-port=0'], { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] })
  const log = createWriteStream(join(dir, `electron-${round}.log`)); child.stdout.pipe(log); child.stderr.pipe(log)
  child.on('exit', () => log.end())
  const port = await until(() => { if (!existsSync(portFile)) return; const data = readFileSync(portFile, 'utf8'); return data !== old && data.split('\n')[0] }, '调试端口未就绪')
  const page = await until(async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(p => p.type === 'page' && !p.url.includes('launcher')), '测试仓库未打开')
  socket = new WebSocket(page.webSocketDebuggerUrl); await once(socket, 'open')
  socket.addEventListener('message', event => {
    const msg = JSON.parse(String(event.data))
    if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text)
    if (msg.id) { const p = pending.get(msg.id); if (!p) return; pending.delete(msg.id); msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result) }
  })
  await send('Runtime.enable')
  await until(() => js(`!!document.querySelector('.tabbar') && !!window.bridge`), '界面未启动')
  await connectCore()
}
async function stop() {
  if (!child || child.exitCode !== null) return
  const exited = once(child, 'exit')
  child.kill('SIGTERM')
  await Promise.race([exited, delay(5000).then(() => { if (child.exitCode === null) child.kill('SIGKILL') })])
  socket?.close(); pending.clear()
}
async function shot(name) { const image = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(dir, name), Buffer.from(image.data, 'base64')) }
let client, transport, libraryId
async function connectMcp() {
  // 身份以 MCP 登记表为准，用临时库路径定位。
  let settings=await js(`window.bridge.application.service('mcp','settings')`)
  const grant=settings.libraries.find(g=>g.root===prepared.root);assert(grant,'临时库没有登记')
  libraryId=grant.libraryId
  settings=await js(`window.bridge.application.service('mcp','settings',${JSON.stringify({enabled:true,grant:{key:grant.key,mode:'organize'}})})`)
  const params=Object.values(JSON.parse(settings.config).mcpServers)[0]
  client=new Client({name:'collection-check',version:'1.0.0'})
  transport=new StdioClientTransport({...params,stderr:'pipe'})
  await client.connect(transport)
}
async function mcp(name,args={}) {
  const result=await client.callTool({name,arguments:{libraryId,...args}})
  assert(!result.isError,JSON.stringify(result.content));return result.structuredContent
}
const checks=[]
const query=async(name,args)=> (await mcp('execute_query',{query:`collection.${name}`,args})).result
const op=(name,args,requestId=`collection-${name}-${++serial}`)=>mcp('execute_operation',{operation:`collection_${name}`,args,requestId})
const visible=`el=>!!el.getClientRects().length`
async function click(text,selector='button') {
  await until(()=>js(`(()=>{const el=[...document.querySelectorAll(${JSON.stringify(selector)})].find(el=>el.textContent.trim()===${JSON.stringify(text)}&&el.getClientRects().length);if(!el)return false;el.click();return true})()`),`找不到按钮 ${text}`)
}
async function fill(selector,value) {await js(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}))})()`)}
try {
  await start(1);await connectMcp()
  const description=await mcp('describe_library')
  assert(description.ingestMetadata.some(x=>x.id==='collection.join'))
  assert(description.operations.some(x=>x.name==='collection_delete'))
  const created=await op('create',{title:'旅行灵感',order:1},'create-collection-001'),id=created.result.id
  const req={operation:'import_files',requestId:'join-collection-001',args:{files:[
    {path:join(dir,'封面.png'),metadata:{'collection.join':{group:id,order:1},'tags.set':{values:['成员标签']}}},
    {path:join(dir,'自动化导入.txt'),metadata:{'collection.join':{group:id,order:2},'note.initial':{text:'成员笔记'}}},
    {path:join(dir,'第二项.txt')}
  ]}}
  const first=await mcp('execute_operation',req);assert.equal(first.result.errors.length,0)
  const [cover,member,outside]=first.result.items.map(x=>x.id)
  await until(async()=>{const views=await call('get',[cover,member]);return views[0].blocks.thumb&&views[1].blocks.body},'新图片和文字加工未完成')
  assert((await mcp('read_content',{id:member,kind:'body',field:'content'})).text.includes('真实 MCP'))
  await mcp('execute_operation',{operation:'update_tags',requestId:'group-tags-001',args:{ids:[id],add:['组标签']}})
  assert.deepEqual((await call('get',[cover]))[0].blocks.tags.data.values,['成员标签'])
  assert((await mcp('search_items',{query:{text:'旅行灵感'}})).items.some(x=>x.id===id))
  const sum=await query('summary',{id});assert.equal(sum.count,2);assert.equal(sum.coverId,cover);assert(sum.coverPath)
  assert.deepEqual((await query('members',{group:null})).items.map(x=>x.id),[outside])
  assert.deepEqual((await query('members',{group:null,ids:[cover,member]})).items,[])
  const named=await query('members',{group:id,ids:[member]})
  assert(named.titleCandidates[member].some(x=>x.kind==='file'&&x.text==='自动化导入.txt'))
  assert(named.titleCandidates[member].some(x=>x.kind==='note'&&x.text==='成员笔记'))
  const searched=await mcp('search_items',{query:{ids:[member]}})
  assert(searched.items[0].titleCandidates.some(x=>x.kind==='file'))
  const detail=await mcp('read_item',{id:member,kinds:['file']})
  assert(detail.titleCandidates.every(x=>x.kind==='file'))
  await click('组','.nav-item')
  await until(()=>js(`!!document.querySelector('[data-collection-page="home"] [data-collection-item="${id}"] img')`),'组卡封面未显示')
  await until(()=>js(`[...document.querySelectorAll('[data-collection-item="${id}"] img')].some(i=>i.complete&&i.naturalWidth>0)`),'组封面图片未解码')
  await shot('01-groups.png')
  await click('打开组')
  await until(()=>js(`!!document.querySelector('[data-collection-page="${id}"] [data-collection-item="${member}"]')`),'组成员未呈现')
  assert(await js(`document.querySelector('[data-collection-page="${id}"]').textContent.includes('组标签')`))
  await click('添加素材');await until(()=>js(`!!document.querySelector('.collection-choices input[type=checkbox]')`),'添加对话框为空')
  await js(`document.querySelector('.collection-choices input[type=checkbox]').click()`);await click('添加 1 项')
  await until(async()=> (await query('summary',{id})).count===3,'界面添加未生效')
  await click('重命名');await fill('.collection-form input[aria-label="组名"]','旅行资料');await click('保存')
  await until(()=>js(`document.querySelector('[data-collection-page="${id}"] h1')?.textContent==='旅行资料'`),'改名未同步')
  await js(`document.querySelector('[data-collection-item="${cover}"] .card').dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}))`)
  await click('设为封面');await until(async()=> (await call('get',[id]))[0].blocks.collection.data.cover===cover,'手选封面未写入')
  await click('自动封面');await until(async()=> !(await call('get',[id]))[0].blocks.collection.data.cover,'自动封面未恢复')
  await until(()=>js(`!!document.querySelector('[data-collection-item="${outside}"] button[aria-label^="前移"]')`),'添加后卡片未刷新')
  const before=(await query('members',{group:id})).items.map(x=>x.id)
  await js(`document.querySelector('[data-collection-item="${outside}"] button[aria-label^="前移"]').click()`)
  await until(async()=> (await query('members',{group:id})).items.map(x=>x.id).join()!==before.join(),'排序未生效')
  await shot('02-members.png')
  await send('Emulation.setDeviceMetricsOverride',{width:960,height:720,deviceScaleFactor:1,mobile:false})
  await shot('03-narrow.png');await send('Emulation.clearDeviceMetricsOverride')
  await click('删除组');await click('删除组','.collection-form button')
  await until(async()=> (await query('members',{group:null})).total===3,'删除后成员未视为未分组')
  assert(!(await call('get',[member]))[0].deletedAt);assert.equal((await call('get',[member]))[0].blocks.collectionMember.data.group,id)
  await call('undo');assert.equal((await query('members',{group:id})).total,3)
  const other=(await op('create',{title:'第二个组'})).result.id
  await op('move',{ids:[outside],group:other})
  const deletion=await op('delete',{id},'delete-collection-001')
  const bad=await client.callTool({name:'execute_operation',arguments:{libraryId,operation:'import_files',requestId:'invalid-target',args:{files:[{path:join(dir,'第二项.txt'),metadata:{'collection.join':{group:id}}}]}}})
  assert(bad.isError&&JSON.stringify(bad.content).includes('INGEST_METADATA_FAILED'))
  const recovery=await op('restore',{id},'restore-collection-001');assert.equal((await query('summary',{id})).count,2)
  assert.deepEqual(await op('restore',{id},'restore-collection-001'),{...recovery,replayed:true})
  await call('undo');assert((await call('get',[id]))[0].deletedAt);await call('redo')
  await click('未分组','.nav-item');await until(()=>js(`!!document.querySelector('[data-collection-page="ungrouped"]')`),'未分组入口错误')
  await click('＋ 新建组');await fill('.collection-form input[aria-label="组名"]','界面新建空组');await click('保存')
  await until(()=>js(`[...document.querySelectorAll('.collection-page h1')].some(e=>e.textContent==='界面新建空组'&&e.getClientRects().length)`),'界面新建失败')
  await click('组','.nav-item')
  await until(()=>js(`!!document.querySelector('[data-collection-page="home"] input[type=checkbox]')`),'空组筛选缺失')
  await until(()=>js(`document.querySelector('[data-collection-page="home"]').textContent.includes('界面新建空组')`),'空组未显示')
  await js(`document.querySelector('[data-collection-page="home"] input[type=checkbox]').click()`)
  await until(()=>js(`!document.querySelector('[data-collection-page="home"]').textContent.includes('界面新建空组')`),'隐藏空组未生效')
  assert.equal((await query('list',{})).total,3);assert.equal((await query('list',{hideEmpty:true})).total,2)
  await shot('04-hide-empty.png')
  checks.push('MCP 删除→恢复→成员归回与回执重放；按导入 ID 范围查询；名称候选与来源字段；空组可选隐藏且数据保留')
  checks.push('项目外打包安装；真实 MCP 建组、新 PNG/TXT 收录加工、附加标签笔记、搜索、只读查询与封面')
  checks.push('界面组卡封面解码、打开组、添加素材、改名、排序、手选/自动封面、删除撤销、未分组、界面新建及窄窗口截图')
  await client.close();await transport.close();await stop();await start(2);await connectMcp()
  assert.deepEqual(await mcp('execute_operation',req),{...first,replayed:true})
  assert.deepEqual(await op('delete',{id},'delete-collection-001'),{...deletion,replayed:true});assert(!(await call('get',[id]))[0].deletedAt)
  assert.equal((await query('summary',{id})).count,2)
  assert((await op('restore',{id},'restore-collection-001')).replayed)
  const settings=await js(`window.bridge.application.service('mcp','settings')`),grant=settings.libraries.find(g=>g.libraryId===libraryId)
  await js(`window.bridge.application.service('mcp','settings',${JSON.stringify({grant:{key:grant.key,mode:'read'}})})`)
  assert.equal((await query('summary',{id})).count,2)
  const readonly=await client.callTool({name:'execute_operation',arguments:{libraryId,operation:'collection_delete',requestId:'readonly-collection',args:{id}}})
  assert(readonly.isError&&JSON.stringify(readonly.content).includes('READ_ONLY'))
  const readRestore=await client.callTool({name:'execute_operation',arguments:{libraryId,operation:'collection_restore',requestId:'readonly-restore',args:{id}}});assert(readRestore.isError&&JSON.stringify(readRestore.content).includes('READ_ONLY'))
  checks.push('应用重启保留组关系、视图和幂等回执；只读 MCP 可查组但不可删除')
  assert.equal(errors.length,0,errors.join('\n'))
  writeFileSync(join(dir,'result.json'),JSON.stringify({ok:true,checks},null,2));console.log(JSON.stringify({ok:true,dir,checks},null,2))
} catch(error) {
  try {await shot('failure.png');writeFileSync(join(dir,'failure-dom.txt'),await js('document.body.innerText'))}catch{}
  console.error({dir,error:error.stack,errors});process.exitCode=1
} finally {await client?.close();await transport?.close();await stop()}
