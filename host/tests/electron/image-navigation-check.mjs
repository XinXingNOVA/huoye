import { pluginSource } from '../helpers/plugin-sources.mjs'
// 真实 Electron utilityProcess + MCP stdio；仅使用独立临时仓库。
// npm run build 后运行 node tests/electron/image-navigation-check.mjs。
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
const dir = mkdtempSync(join(tmpdir(), 'rm-image-navigation-')), helper = resolve('artifacts/checks/image-navigation-prepare.cjs')
mkdirSync(dirname(helper), { recursive: true })
await build({ entryPoints: ['tests/electron/collection-prepare.ts'], outfile: helper, bundle: true, platform: 'node', format: 'cjs', target: 'node24', external: ['better-sqlite3'] })
const exampleSource=join(dir,'plugin-source'),examplePackage=join(dir,'collection.rmplugin')
cpSync(pluginSource("collection"),exampleSource,{recursive:true})
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
  client=new Client({name:'collection-check',version:'1.0.0'})
  transport=new StdioClientTransport({...params,stderr:'pipe'})
  await client.connect(transport)
}
async function mcp(name,args={}) {
  const result=await client.callTool({name,arguments:{libraryId,...args}})
  assert(!result.isError,JSON.stringify(result.content));return result.structuredContent
}
const checks=[]
const op=(name,args,requestId=`collection-${name}-${++serial}`)=>mcp('execute_operation',{operation:`collection_${name}`,args,requestId})
async function click(text,selector='button') {
  await until(()=>js(`(()=>{const el=[...document.querySelectorAll(${JSON.stringify(selector)})].find(el=>el.textContent.trim()===${JSON.stringify(text)}&&el.checkVisibility());if(!el)return false;el.click();return true})()`),`找不到按钮 ${text}`)
}
try {
  await start(1);await connectMcp()
  const group=(await op('create',{title:'图片顺序验证'})).result.id
  const pictures=[]
  for(const [name,color,order] of [['B','#557a91',10],['A','#936651',30],['C','#718453',40],['outside','#76527f',0]]) {
    const path=join(dir,`${name}.png`)
    await sharp({create:{width:1000,height:680,channels:3,background:color}}).png().toFile(path)
    const r=await mcp('execute_operation',{operation:'import_files',requestId:`image-${name}-import`,args:{files:[{path,...(order?{metadata:{'collection.join':{group,order}}}:{})}]}})
    pictures.push(r.result.items[0].id)
  }
  const [b,a,c,outside]=pictures
  const texts=[]
  for(let i=0;i<20;i++) {
    const id=await call('create',{text:{content:`组内文字 ${i}`}});texts.push(id)
    await call('put',id,'collectionMember',{group,order:11+i})
  }
  await until(async()=> (await call('get',pictures)).every(v=>v.blocks.image&&v.blocks.thumb),'新图片加工未完成')
  await click('组','.nav-item');await click('打开组')
  await until(()=>js(`!!document.querySelector('[data-collection-item="${b}"]')`),'组内第一张图片未出现')
  assert.equal(await js(`!!document.querySelector('[data-collection-item="${c}"]')`),false)
  await js(`document.querySelector('[data-collection-item="${b}"] .card').dispatchEvent(new MouseEvent('dblclick',{bubbles:true,button:0}))`)
  const current=()=>js(`[...document.querySelectorAll('.viewer[data-image-id]')].find(v=>v.checkVisibility())?.getAttribute('data-image-id')`)
  const position=()=>js(`[...document.querySelectorAll('.viewer[data-image-id]')].find(v=>v.checkVisibility())?.querySelector('.image-viewer-position')?.textContent`)
  await until(async()=>await current()===b&&(await position())==='1 / 3','图片没有继承组内顺序')
  assert(await js(`document.querySelector('.viewer button[aria-label="上一张"]').disabled`))
  assert(await js(`document.querySelector('.image-viewer-bar').getBoundingClientRect().bottom<=document.querySelector('.viewer-stage').getBoundingClientRect().top+1`))
  await js(`document.querySelector('.viewer button[aria-label="下一张"]').click()`)
  await until(async()=>await current()===a&&(await position())==='2 / 3','未按组顺序跨页切到 A')
  await send('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowRight',code:'ArrowRight',windowsVirtualKeyCode:39});await send('Input.dispatchKeyEvent',{type:'keyUp',key:'ArrowRight',code:'ArrowRight',windowsVirtualKeyCode:39})
  await until(async()=>await current()===c&&(await position())==='3 / 3','右箭头未切到 C')
  assert(await js(`document.querySelector('.viewer button[aria-label="下一张"]').disabled`))
  await js(`document.querySelector('.viewer button[aria-label="上一张"]').click()`)
  await until(async()=>await current()===a,'上一张未返回 A')
  const scale=await js(`document.querySelector('.viewer .player-time').textContent`)
  await js(`document.querySelector('.viewer button[aria-label="放大图片"]').click()`)
  assert.notEqual(await js(`document.querySelector('.viewer .player-time').textContent`),scale)
  await click('适应','.viewer button')
  await until(()=>js(`[...document.querySelectorAll('.viewer-image>img')].some(i=>i.complete&&i.naturalWidth===1000)`),'图片未解码')
  await shot('01-image-group-navigation.png')
  await send('Emulation.setDeviceMetricsOverride',{width:960,height:720,deviceScaleFactor:1,mobile:false});await shot('02-image-narrow.png');await send('Emulation.clearDeviceMetricsOverride')
  await click('全部','.nav-item')
  await until(()=>js(`!!document.querySelector('[data-entity-id="${a}"]')`),'全部视图素材未出现')
  await js(`document.querySelector('[data-entity-id="${a}"]').dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}))`)
  await until(()=>js(`document.querySelector('.inspector')?.textContent.includes('A.png')`),'详情未选中图片')
  await click('打开','.inspector button')
  const expected=(await call('query',{has:['image']})).ids
  await until(async()=>await current()===a&&(await position())===`${expected.indexOf(a)+1} / 4`,'详情打开未继承全部视图或未刷新既有查看器来源')
  await click('未分组','.nav-item')
  await until(()=>js(`!!document.querySelector('[data-collection-item="${outside}"]')`),'未分组卡片未出现')
  await click('打开素材')
  await until(async()=>await current()===outside&&(await position())==='1 / 1','未分组导航扩大了范围')
  assert(await js(`document.querySelector('[data-image-id="${outside}"] button[aria-label="下一张"]').disabled`))
  assert.equal(errors.length,0,errors.join('\n'))
  checks.push('真实 Electron 新图片导入、缩略图加工和原图解码；组内跨页 B→A→C，跳过文字和组外图片；按钮与方向键、首尾边界、顶部位置、缩放及窄窗口')
  checks.push('从全部视图详情打开继承列表，复用查看器刷新来源；未分组仅按当前页范围导航')
  writeFileSync(join(dir,'result.json'),JSON.stringify({ok:true,checks},null,2));console.log(JSON.stringify({ok:true,dir,checks},null,2))
} catch(error) {
  try {await shot('failure.png');writeFileSync(join(dir,'failure-dom.txt'),await js('document.body.innerText'))}catch{}
  console.error({dir,error:error.stack,errors});process.exitCode=1
} finally {await client?.close();await transport?.close();await stop()}
