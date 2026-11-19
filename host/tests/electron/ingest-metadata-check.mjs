// 真实 Electron utilityProcess + MCP stdio；仅使用独立临时仓库。
// npm run build 后运行 node tests/electron/ingest-metadata-check.mjs。
import { build } from 'esbuild'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, createWriteStream } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const project = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
process.chdir(project)
const dir = mkdtempSync(join(tmpdir(), 'rm-ingest-metadata-')), helper = resolve('artifacts/checks/ingest-metadata-prepare.cjs')
mkdirSync(dirname(helper), { recursive: true })
await build({ entryPoints: ['tests/electron/ingest-metadata-prepare.ts'], outfile: helper, bundle: true, platform: 'node', format: 'cjs', target: 'node24', external: ['better-sqlite3'] })
execFileSync(process.execPath, [helper, dir], { cwd: project, stdio: 'inherit' })
const prepared = JSON.parse(readFileSync(join(dir, 'prepared.json'), 'utf8'))
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
const call = (method, ...args) => js(`window.ingestTestCore(${JSON.stringify(method)}, ${JSON.stringify(args)})`)
async function connectCore() {
  await js(`new Promise(resolve => { const handler = e => { if(e.source!==window||e.data!=='core:port')return; window.removeEventListener('message',handler); const port=e.ports[0],pending=new Map();let n=0;port.onmessage=e=>{const m=e.data,p=pending.get(m.id);if(!p)return;pending.delete(m.id);m.error?p.reject(Error(m.error)):p.resolve(m.result)};window.ingestTestCore=(method,args)=>new Promise((resolve,reject)=>{const id=++n;pending.set(id,{resolve,reject});port.postMessage({id,method,args})});resolve(true) };window.addEventListener('message',handler);window.bridge.connectCore() })`)
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
  client=new Client({name:'ingest-metadata-check',version:'1.0.0'})
  transport=new StdioClientTransport({...params,stderr:'pipe'})
  await client.connect(transport)
}
async function mcp(name,args={}) {
  const result=await client.callTool({name,arguments:{libraryId,...args}})
  assert(!result.isError,JSON.stringify(result.content));return result.structuredContent
}
const checks=[]
try {
  await start(1);await connectMcp()
  const description=await mcp('describe_library')
  assert.deepEqual(description.ingestMetadata.map(x=>x.id).sort(),['note.initial','source.initial','tags.add'])
  const path=join(dir,'自动化导入.txt')
  const request={operation:'import_files',requestId:'electron-ingest-metadata',args:{files:[{path,metadata:{
    'tags.add':{add:['自动化','阅读']},'note.initial':{text:'AI 写入的说明'},'source.initial':{url:'https://example.com/reference',title:'参考来源'}
  }}]}}
  const first=await mcp('execute_operation',request),id=first.result.items[0].id
  assert.equal(first.result.items[0].metadata['tags.add'].status,'applied')
  await until(async()=>{const [v]=await call('get',[id]);return v.blocks.body&&v.blocks.tags&&v.blocks.note&&v.blocks.source},'真实新文件加工或附加内容缺失')
  assert((await mcp('read_content',{id,kind:'body',field:'content'})).text.includes('真实 MCP'))
  assert.equal((await mcp('read_content',{id,kind:'note',field:'text'})).text,'AI 写入的说明')
  assert((await mcp('search_items',{query:{has:['file'],where:[{op:'eq',kind:'tags',field:'values',value:'自动化'}]}})).items.some(x=>x.id===id))
  await until(()=>js(`!!document.querySelector('[data-entity-id="${id}"]')`),'导入结果没有在界面显示')
  await js(`document.querySelector('[data-entity-id="${id}"]').dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}))`)
  await until(()=>js(`[...document.querySelectorAll('.inspector textarea')].some(el=>el.value==='AI 写入的说明')`),'详情未显示附加内容')
  await shot('01-import-with-metadata.png')
  assert.deepEqual(await mcp('execute_operation',request),{...first,replayed:true})
  await call('undo');assert((await call('get',[id]))[0].deletedAt)
  assert((await mcp('execute_operation',request)).replayed);assert((await call('get',[id]))[0].deletedAt)
  await call('redo')
  const merge={...request,requestId:'electron-existing-metadata',args:{files:[{path,metadata:{'tags.add':{add:['补充']},'note.initial':{text:'不覆盖用户说明'}}}]}}
  const existing=await mcp('execute_operation',merge)
  assert.equal(existing.result.items[0].outcome,'existing');assert.equal(existing.result.items[0].metadata['note.initial'].status,'preserved')
  assert.equal((await mcp('read_content',{id,kind:'note',field:'text'})).text,'AI 写入的说明')
  await call('undo');assert.deepEqual((await call('get',[id]))[0].blocks.tags.data.values,['自动化','阅读'])
  const partial=await mcp('execute_operation',{operation:'import_files',requestId:'electron-partial-metadata',args:{files:[
    {path:join(dir,'第二项.txt'),metadata:{'tags.add':{add:['第二项']}}},{path:join(dir,'missing'),metadata:{'tags.add':{add:['缺失']}}}
  ]}})
  assert.equal(partial.result.items.length,1);assert.equal(partial.result.errors.length,1)
  const denied=await client.callTool({name:'execute_operation',arguments:{libraryId,operation:'import_files',requestId:'electron-invalid-metadata',args:{files:[{path,metadata:{'unknown.initial':{}}}]}}})
  assert(denied.isError&&JSON.stringify(denied.content).includes('UNAVAILABLE_INGEST_METADATA'))
  checks.push('真实 MCP 发现协议，新 TXT 在 utilityProcess 收录与加工，标签/笔记/来源同次写入，搜索与界面可见')
  checks.push('回执重试、一次撤销重做、已有素材合并且保护笔记、逐项文件错误、未知能力拒绝')
  await client.close();await transport.close();await stop();await start(2);await connectMcp()
  assert.deepEqual(await mcp('execute_operation',request),{...first,replayed:true})
  assert.equal((await mcp('read_content',{id,kind:'note',field:'text'})).text,'AI 写入的说明')
  const settings=await js(`window.bridge.application.service('mcp','settings')`),grant=settings.libraries.find(g=>g.libraryId===libraryId)
  await js(`window.bridge.application.service('mcp','settings',${JSON.stringify({grant:{key:grant.key,mode:'read'}})})`)
  const readonly=await client.callTool({name:'execute_operation',arguments:{libraryId,...request,requestId:'readonly-metadata'}})
  assert(readonly.isError&&JSON.stringify(readonly.content).includes('READ_ONLY'))
  checks.push('重启保留数据与回执；只读权限仍拒绝附加写入')
  assert.equal(errors.length,0,errors.join('\n'))
  writeFileSync(join(dir,'result.json'),JSON.stringify({ok:true,checks},null,2));console.log(JSON.stringify({ok:true,dir,checks},null,2))
} catch(error) {
  try {await shot('failure.png');writeFileSync(join(dir,'failure-dom.txt'),await js('document.body.innerText'))}catch{}
  console.error({dir,error:error.stack,errors});process.exitCode=1
} finally {await client?.close();await transport?.close();await stop()}
