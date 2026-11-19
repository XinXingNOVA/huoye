// 真实 Electron utilityProcess + MCP stdio；仅使用独立临时仓库。
// npm run build 后运行 node tests/electron/local-service-check.mjs。
import { executeUiCommand } from './capture-command.ts'
import { build } from 'esbuild'
import { createServer } from 'node:http'
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
const dir = mkdtempSync(join(tmpdir(), 'rm-local-service-')), helper = resolve('artifacts/checks/local-service-prepare.cjs')
mkdirSync(dirname(helper), { recursive: true })
await build({ entryPoints: ['tests/electron/local-service-prepare.ts'], outfile: helper, bundle: true, platform: 'node', format: 'cjs', target: 'node24', external: ['better-sqlite3'] })
const exampleSource=join(dir,'plugin-source'),examplePackage=join(dir,'demo-service.rmplugin')
cpSync(resolve('examples/local-service'),exampleSource,{recursive:true})
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
  client=new Client({name:'local-service-check',version:'1.0.0'})
  transport=new StdioClientTransport({...params,stderr:'pipe'})
  await client.connect(transport)
}
async function mcp(name,args={}) {
  const result=await client.callTool({name,arguments:{libraryId,...args}})
  assert(!result.isError,JSON.stringify(result.content));return result.structuredContent
}
const checks=[]
async function click(text,selector='button') {
  await until(()=>js(`(()=>{const el=[...document.querySelectorAll(${JSON.stringify(selector)})].find(el=>el.textContent.trim()===${JSON.stringify(text)}&&el.checkVisibility());if(!el)return false;el.click();return true})()`),`找不到按钮 ${text}`)
}
const service=(method,input)=>js(`window.bridge.services.invoke('demo-service',${JSON.stringify(method)},${JSON.stringify(input)})`)
const fill=async(selector,value)=>js(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}))})()`)
const output=()=>js(`document.querySelector('[data-service-output]')?.textContent`)
let aborted=0, requests=0
const network=createServer((req,res)=>{
  let text=''; req.on('data',data=>text+=data)
  req.on('end',()=>{
    requests++; res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8'})
    const chunks=req.url==='/slow'?Array(200).fill('慢速'):['网络',text,'完成']; let i=0
    const timer=setInterval(()=>{if(i===chunks.length){clearInterval(timer);res.end()}else res.write(chunks[i++])},30)
    res.on('close',()=>{clearInterval(timer);if(!res.writableEnded)aborted++})
  })
})
network.listen(0,'127.0.0.1');await once(network,'listening')
const endpoint=`http://127.0.0.1:${network.address().port}`
async function stream(input) {
  // 直接走实际原生端口，网络验证与界面示例共用同一个服务入口。
  await js(`(()=>{const id=crypto.randomUUID();window.serviceTest={events:[],status:'starting'};
    const listener=e=>{if(e.source!==window||e.data?.type!=='service:port'||e.data.id!==id)return;window.removeEventListener('message',listener);
      const port=e.ports[0];window.cancelServiceTest=()=>port.postMessage({type:'cancel'});
      port.onmessage=({data})=>{if(data.type==='data'){window.serviceTest.events.push(data.value);port.postMessage({type:'ack',sequence:data.sequence})}else {window.serviceTest.status=data.type;window.serviceTest.error=data.error;port.close()}};
      port.start();port.postMessage({type:'ready'})};
    window.addEventListener('message',listener);window.bridge.services.stream(id,'demo-service','echo',${JSON.stringify(input)}).catch(e=>{window.serviceTest.status='error';window.serviceTest.error=String(e)})})()`)
}
async function reload() {
  await js(`void window.bridge.vaults.reload().catch(()=>{})`)
  await until(()=>js(`location.href==='about:blank'`).catch(()=>false),'未进入重载',5000).catch(()=>{})
  await until(()=>js(`!!document.querySelector('.tabbar')&&!!window.bridge`).catch(()=>false),'重载未完成')
  await connectCore()
}
try {
  await start(1);await connectMcp()
  const imported=await mcp('execute_operation',{operation:'import_files',requestId:'service-new-file',args:{files:[{path:join(dir,'新服务验证.txt')}]}})
  const asset=imported.result.items[0].id
  await until(async()=>!!(await call('get',[asset]))[0]?.blocks.body,'新文件正文加工未完成')
  assert((await mcp('read_content',{id:asset,kind:'body',field:'content'})).text.includes('新文件收录'))
  await executeUiCommand(js, 'host.tool.demo-service.panel')
  await until(()=>js(`!!document.querySelector('[data-service-example]')`),'服务面板未挂载')
  await fill('[aria-label="回显前缀"]','已保存：');await click('保存配置')
  await until(async()=>(await service('settings')).prefix==='已保存：','配置未保存')
  const first=await service('settings')
  if(first.protectedStorage){await fill('[aria-label="示例凭据"]','only-a-disposable-test-key');await click('保存示例凭据');await until(async()=>(await service('settings')).hasKey,'凭据未保存')}
  const text='隐藏侧栏时继续逐字输出，直到完整返回。'
  await fill('[aria-label="测试内容"]',text);await click('开始输出')
  await until(async()=>(await output()).includes('隐藏'),'输出未启动')
  await js(`document.querySelector('[aria-label="收起右侧栏"]').click()`)
  await until(async()=>(await service('settings')).running===0,'隐藏面板停止了生成')
  await executeUiCommand(js, 'host.tool.demo-service.panel');assert.equal(await output(),'已保存：'+text)
  await shot('01-stream-complete.png')
  await fill('[aria-label="测试内容"]','测试停止'.repeat(30));await click('开始输出')
  await until(async()=>(await service('settings')).running===1,'取消测试未启动');await click('停止')
  await until(async()=>(await service('settings')).running===0,'停止未传到服务')
  assert.equal(await js(`document.querySelector('[data-service-status]').textContent`),'已停止')
  await stream({text:'回显文本',endpoint})
  await until(()=>js(`window.serviceTest.status==='done'`),'真实网络流未完成')
  assert.equal(await js(`window.serviceTest.events.map(x=>x.delta??'').join('')`),'已保存：网络回显文本完成')
  if(first.protectedStorage)assert.equal(await js(`window.serviceTest.events[0].credentialReady`),true)
  await stream({text:'cancel',endpoint:endpoint+'/slow'})
  await until(()=>requests>=2,'慢请求未发出');await js(`window.cancelServiceTest()`)
  await until(()=>aborted>=1,'取消未断开网络请求')
  await until(()=>js(`window.serviceTest.status==='error'`),'取消无终态')
  await stream({text:'reload',endpoint:endpoint+'/slow'})
  await until(()=>requests>=3,'重载请求未发出');await reload();await until(()=>aborted>=2,'重载未中断网络')
  assert.equal((await service('settings')).prefix,'已保存：');assert.equal((await service('settings')).running,0)
  // 另一仓库共用本机配置，实例与仓库配置独立。
  const port=readFileSync(join(prepared.userData,'DevToolsActivePort'),'utf8').split('\n')[0]
  const known=new Set((await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).map(p=>p.id))
  const opened=await js(`window.bridge.vaults.open(${JSON.stringify(prepared.other)})`);assert(opened.ok)
  const other=await until(async()=> (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(p=>p.type==='page'&&!known.has(p.id)&&!p.url.includes('launcher')),'另一仓库未打开')
  const primary=socket
  socket=new WebSocket(other.webSocketDebuggerUrl);await once(socket,'open')
  socket.addEventListener('message',event=>{const msg=JSON.parse(String(event.data));if(msg.id){const p=pending.get(msg.id);if(p){pending.delete(msg.id);msg.error?p.reject(Error(msg.error.message)):p.resolve(msg.result)}}})
  await until(()=>js(`!!window.bridge`),'第二库界面未就绪')
  assert.equal((await service('settings')).prefix,'已保存：');assert.equal((await service('settings')).runs,0)
  await service('configure',{prefix:'跨库配置：'});socket.close();socket=primary
  assert.equal((await service('settings')).prefix,'跨库配置：');assert((await service('settings')).runs>=4)
  await send('Target.closeTarget',{targetId:other.id})
  await client.close();await transport.close();client=undefined;transport=undefined
  await stop();await start(2)
  assert.equal((await service('settings')).prefix,'跨库配置：')
  if(first.protectedStorage){assert((await service('settings')).hasKey);await stream({text:'x',delay:1});await until(()=>js(`window.serviceTest.status==='done'`),'重启后流失败');assert(await js(`window.serviceTest.events[0].credentialReady`))}
  await call('setPluginSettings',[],[{...prepared.ref,enabled:false}]);await reload()
  assert.match(await js(`window.bridge.services.invoke('demo-service','settings').then(()=>'',e=>String(e))`),/SERVICE_UNAVAILABLE/)
  assert.equal(await js(`!!document.querySelector('[data-service-example]')`),false)
  await call('setPluginSettings',[],[{...prepared.ref,enabled:true}]);await reload()
  assert.equal((await service('settings')).prefix,'跨库配置：')
  const rows=await js(`window.bridge.packages.list()`);assert(rows.find(r=>r.manifest.id==='demo-service').running)
  await executeUiCommand(js, 'host.tool.demo-service.panel');await shot('02-reenabled.png')
  assert.equal(errors.length,0,errors.join('\n'))
  checks.push('独立临时库安装外部服务包；真实新 TXT 收录加工和 MCP 读取保持正常')
  checks.push('实际 UI 持续输出、隐藏侧栏继续、主动停止；真实本机 HTTP 流、取消断开、重载中断')
  checks.push('多库共享本机配置、隔离实例和库配置；重启、停用拒绝、重新启用恢复配置')
  checks.push(first.protectedStorage?'Electron 系统保护可用，凭据加密存储并重启解密验证通过':'系统保护不可用，示例拒绝保存凭据；本轮未验证系统加密往返')
  writeFileSync(join(dir,'result.json'),JSON.stringify({ok:true,checks},null,2));console.log(JSON.stringify({ok:true,dir,checks},null,2))
} catch(error) {
  try {await shot('failure.png');writeFileSync(join(dir,'failure-dom.txt'),await js('document.body.innerText'))}catch{}
  console.error({dir,error:error.stack,errors});process.exitCode=1
} finally {await client?.close();await transport?.close();await stop();network.closeAllConnections();await new Promise(r=>network.close(r))}
