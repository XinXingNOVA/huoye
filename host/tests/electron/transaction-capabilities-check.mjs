// 真实 Electron utilityProcess + MCP stdio；仅使用独立临时仓库。
// npm run build 后运行 node tests/electron/transaction-capabilities-check.mjs。
import { build } from 'esbuild'
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
const dir = mkdtempSync(join(tmpdir(), 'rm-transaction-capabilities-')), helper = resolve('artifacts/checks/transaction-capabilities-prepare.cjs')
mkdirSync(dirname(helper), { recursive: true })
await build({ entryPoints: ['tests/electron/transaction-capabilities-prepare.ts'], outfile: helper, bundle: true, platform: 'node', format: 'cjs', target: 'node24', external: ['better-sqlite3'] })
const exampleSource=join(dir,'plugin-source'),examplePackage=join(dir,'container.rmplugin')
cpSync(resolve('examples/transaction-plugin'),exampleSource,{recursive:true})
execFileSync(process.execPath,['scripts/plugins/pack.ts',exampleSource,examplePackage],{cwd:project,stdio:'inherit'})
execFileSync(process.execPath, [helper, dir, examplePackage], { cwd: project, stdio: 'inherit' })
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
  client=new Client({name:'transaction-capabilities-check',version:'1.0.0'})
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
  assert(description.ingestMetadata.some(x=>x.id==='demo-container.join'))
  const create=await mcp('execute_operation',{operation:'demo_container_create',requestId:'create-container-001',args:{title:'引用检查示例'}})
  const id=create.result.id,path=join(dir,'自动化导入.txt')
  const req={operation:'import_files',requestId:'join-container-001',args:{files:[{path,metadata:{'demo-container.join':{group:id},'note.initial':{text:'容器中的成员'}}}]}}
  const first=await mcp('execute_operation',req),member=first.result.items[0].id
  await until(async()=>{const [v]=await call('get',[member]);return v.blocks.body&&v.blocks['demo-container.member']},'新文件加工未完成')
  assert((await mcp('read_content',{id:member,kind:'body',field:'content'})).text.includes('真实 MCP'))
  assert((await mcp('search_items',{query:{where:[{op:'eq',kind:'demo-container.member',field:'group',value:id}]}})).items.some(x=>x.id===member))
  const deletion={operation:'demo_container_trash',requestId:'delete-container-001',args:{id}}
  const preview=await call('preview','demo-container','trash',{id})
  assert(preview);assert(!(await call('get',[id]))[0].deletedAt)
  const deleted=await mcp('execute_operation',deletion)
  assert((await call('get',[id]))[0].deletedAt);assert(!(await call('get',[member]))[0].deletedAt)
  assert.equal((await call('get',[member]))[0].blocks['demo-container.member'].data.group,id)
  const bad={operation:'import_files',requestId:'deleted-target-001',args:{files:[{path:join(dir,'第二项.txt'),metadata:{'demo-container.join':{group:id}}}]}}
  const denied=await client.callTool({name:'execute_operation',arguments:{libraryId,...bad}})
  assert(denied.isError&&JSON.stringify(denied.content).includes('INGEST_METADATA_FAILED'))
  assert.equal((await mcp('search_items',{query:{has:['file']}})).items.length,1)
  await call('undo');assert(!(await call('get',[id]))[0].deletedAt)
  assert((await mcp('execute_operation',deletion)).replayed);assert(!(await call('get',[id]))[0].deletedAt)
  await call('redo');assert((await call('get',[id]))[0].deletedAt)
  await call('undo')
  const retried=await mcp('execute_operation',bad)
  assert(!retried.replayed);assert.equal(retried.result.items.length,1)
  await until(()=>js(`!!document.querySelector('[data-entity-id="${member}"]')`),'成员卡片未出现')
  await js(`document.querySelector('[data-entity-id="${member}"]').dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}))`)
  await until(()=>js(`[...document.querySelectorAll('.inspector textarea')].some(el=>el.value==='容器中的成员')`),'成员详情未显示')
  await shot('01-container-member.png')
  checks.push('项目外打包并安装示例；真实 MCP 建容器、导入新 TXT、utilityProcess 正文加工、关系搜索与详情显示')
  checks.push('命令预演、MCP 回收、link 成员保留、失效引用拒绝、撤销重做、同请求失败后重试及成功回执重放')
  await client.close();await transport.close();await stop();await start(2);await connectMcp()
  assert.deepEqual(await mcp('execute_operation',req),{...first,replayed:true})
  assert.deepEqual(await mcp('execute_operation',deletion),{...deleted,replayed:true})
  assert(!(await call('get',[id]))[0].deletedAt)
  const settings=await js(`window.bridge.application.service('mcp','settings')`),grant=settings.libraries.find(g=>g.libraryId===libraryId)
  await js(`window.bridge.application.service('mcp','settings',${JSON.stringify({grant:{key:grant.key,mode:'read'}})})`)
  const readonly=await client.callTool({name:'execute_operation',arguments:{libraryId,...deletion,requestId:'readonly-container-001'}})
  assert(readonly.isError&&JSON.stringify(readonly.content).includes('READ_ONLY'))
  checks.push('重启保留关系和回执，回执不重做已撤销删除，只读 MCP 拒绝删除')
  assert.equal(errors.length,0,errors.join('\n'))
  writeFileSync(join(dir,'result.json'),JSON.stringify({ok:true,checks},null,2));console.log(JSON.stringify({ok:true,dir,checks},null,2))
} catch(error) {
  try {await shot('failure.png');writeFileSync(join(dir,'failure-dom.txt'),await js('document.body.innerText'))}catch{}
  console.error({dir,error:error.stack,errors});process.exitCode=1
} finally {await client?.close();await transport?.close();await stop()}
