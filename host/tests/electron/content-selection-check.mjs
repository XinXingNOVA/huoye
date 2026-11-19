import { pluginSource } from '../helpers/plugin-sources.mjs'
// 独立 CDP 验证程序，不在宿主注册 capture flow，也不修改 MCP 或用户仓库。
// 先生成 artifacts/plugins/epub.rmplugin 和 npm run build，再 node tests/electron/content-selection-check.mjs。
import { build } from 'esbuild'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, createWriteStream } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const electron = createRequire(import.meta.url)('electron')
const project = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
process.chdir(project)
const dir = mkdtempSync(join(tmpdir(), 'rm-selection-electron-')), helper = resolve('artifacts/checks/selection-prepare.cjs')
mkdirSync(dirname(helper), { recursive: true })
await build({ alias: { '@test-plugins/epub': pluginSource('epub') }, entryPoints: ['tests/electron/selection-prepare.ts'], outfile: helper, bundle: true, platform: 'node', format: 'cjs', target: 'node24', external: ['better-sqlite3'] })
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
const call = (method, ...args) => js(`window.epubTestCore(${JSON.stringify(method)}, ${JSON.stringify(args)})`)
async function connectCore() {
  await js(`new Promise(resolve => { const handler = e => { if(e.source!==window||e.data!=='core:port')return; window.removeEventListener('message',handler); const port=e.ports[0],pending=new Map();let n=0;port.onmessage=e=>{const m=e.data,p=pending.get(m.id);if(!p)return;pending.delete(m.id);m.error?p.reject(Error(m.error)):p.resolve(m.result)};window.epubTestCore=(method,args)=>new Promise((resolve,reject)=>{const id=++n;pending.set(id,{resolve,reject});port.postMessage({id,method,args})});resolve(true) };window.addEventListener('message',handler);window.bridge.connectCore() })`)
}
async function start(round) {
  const env = { ...process.env, RM_USER_DATA: prepared.userData, LIBRARY_PATH: prepared.root }
  delete env.CAPTURE_DIR; delete env.CAPTURE_FLOW; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
  const portFile = join(prepared.userData, 'DevToolsActivePort'), old = existsSync(portFile) ? readFileSync(portFile, 'utf8') : ''
  child = spawn(electron, ['.', '--remote-debugging-port=0'], { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] })
  const log = createWriteStream(join(dir, `electron-${round}.log`)); child.stdout.pipe(log); child.stderr.pipe(log)
  child.on('exit', () => log.end())
  const port = await until(() => { if (!existsSync(portFile)) return; const data = readFileSync(portFile, 'utf8'); return data !== old && data.split('\n')[0] }, '调试端口未就绪')
  const page = await until(async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(p => p.type === 'page' && !p.url.includes('launcher')), '阅读仓库未打开')
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
  socket?.close(); pending.clear()
  const proc = child
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return
  const exited = once(proc, 'exit')
  proc.kill('SIGTERM')
  const timeout = setTimeout(() => proc.kill('SIGKILL'), 5000)
  try { await exited } finally { clearTimeout(timeout) }
}
async function shot(name) { const image = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(dir, name), Buffer.from(image.data, 'base64')) }
const clickText = (selector, text) => js(`(() => { const e=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>e.textContent.trim()===${JSON.stringify(text)});if(!e)throw Error('找不到按钮 '+${JSON.stringify(text)});e.click() })()`)
async function readyChapter(title) { await until(() => js(`document.querySelector('.tab-pane:not(.hidden) .epub-content')?.textContent.includes(${JSON.stringify(title)}) || [...document.querySelectorAll('.epub-content')].some(e=>e.getBoundingClientRect().height>0 && e.textContent.includes(${JSON.stringify(title)}))`), `章节未显示：${title}`); await delay(250) }
const checks=[]
const active="document.querySelector('.tab-pane:not(.hidden)')"
async function openItem(id){
  await js(`document.querySelector('.tab').dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}))`)
  const [view] = await call('get', [id])
  const command = view.blocks.anchor ? 'host.view.annotations' : 'host.view.all'
  await js(`document.querySelector('[aria-label="打开命令面板"]').click()`)
  await until(()=>js(`!!document.querySelector('[data-command-id="${command}"]')`),'找不到视图命令 '+command)
  await js(`document.querySelector('[data-command-id="${command}"]').click()`)
  await until(()=>js(`!!${active}?.querySelector('[data-entity-id="${id}"]')`),'找不到素材卡片 '+id)
  await js(`${active}.querySelector('[data-entity-id="${id}"]').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`)
}
async function dragSelect(selector,count=10){
  await js('window.getSelection().removeAllRanges()')
  const point=await js(`(()=>{const el=${active}.querySelector(${JSON.stringify(selector)});if(!el)throw Error('没有选区正文');el.scrollIntoView({block:'center'});const w=document.createTreeWalker(el,NodeFilter.SHOW_TEXT);let n;while(n=w.nextNode()){if(n.textContent.trim().length>=${count})break};if(!n)throw Error('正文太短');const r=document.createRange();r.setStart(n,0);r.setEnd(n,0);const a=r.getBoundingClientRect();r.setStart(n,${count});r.setEnd(n,${count});const b=r.getBoundingClientRect();return {a:{x:a.x+1,y:a.y+a.height/2},b:{x:b.x+1,y:b.y+b.height/2},text:n.textContent.slice(0,${count})}})()`)
  await delay(200)
  await send('Input.dispatchMouseEvent',{type:'mousePressed',...point.a,button:'left',buttons:1,clickCount:1})
  for(let i=1;i<=10;i++)await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:point.a.x+(point.b.x-point.a.x)*i/10,y:point.a.y+(point.b.y-point.a.y)*i/10,button:'left',buttons:1})
  await send('Input.dispatchMouseEvent',{type:'mouseReleased',...point.b,button:'left',buttons:0,clickCount:1})
  assert.equal(await js('window.getSelection().toString()'),point.text)
  await until(()=>js(`document.querySelectorAll('.content-selection-menu').length===1`),'统一选区菜单未出现')
  assert((await js(`document.querySelector('.content-selection-menu').innerText`)).includes('复制'))
  return point.text
}
const excerpts=async(source)=>(await call('query',{where:[{op:'eq',kind:'anchor',field:'target',value:source},{op:'eq',kind:'anchor',field:'type',value:'内容摘录'}]})).ids
async function mark(source,before=0){const previous=await excerpts(source);assert.equal(previous.length,before);await clickText('.content-selection-menu button','标记摘录');return until(async()=>{const ids=await excerpts(source);return ids.length===before+1&&ids.find(id=>!previous.includes(id))},'摘录未创建')}
async function note(text){
  await clickText('.content-selection-menu button','添加批注')
  await until(()=>js(`!!document.querySelector('.selection-note-dialog textarea')`),'批注对话框未出现')
  await js(`(()=>{const e=document.querySelector('.selection-note-dialog textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(text)});e.dispatchEvent(new Event('input',{bubbles:true}))})()`)
}
try{
  await start(1)
  const info=await call('info');for(const id of ['epub',...prepared.bundled])assert(info.assembly.plugins.some(p=>p.id===id&&p.enabled),id+' 未启用')
  const [book,pdf]=await call('ingest',[{type:'file',path:join(dir,'山间来信.epub')},{type:'file',path:join(dir,'共享选区.pdf')}])
  const [text]=await call('ingest',[{type:'text',text:'# 共享选区\n\n普通文字也可以统一选择、摘录和批注。\n\n第二段用来检查原文变化。'}])
  await until(async()=>{const values=await call('get',[book,pdf]);return values[0].blocks.epub&&values[0].blocks.thumb&&values[1].blocks.pdftext&&values[1].blocks.thumb},'新文件未完成加工')
  await openItem(book);await readyChapter('雨后的山路')
  const selected=await dragSelect('.epub-content p')
  await shot('01-epub-selection.png')
  await clickText('.content-selection-menu button','复制')
  assert.equal(await js('navigator.clipboard.readText()'),selected)
  await dragSelect('.epub-content p')
  await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27})
  await delay(100);assert.equal(await js(`!!document.querySelector('.content-selection-menu')`),false)
  await dragSelect('.epub-content p')
  const bookQuote=await mark(book)
  await until(()=>js(`!!document.querySelector('[data-content-mark="${bookQuote}"]')`),'电子书高亮未出现')
  let stored=(await call('get',[bookQuote]))[0]
  assert.equal(stored.blocks.anchor.data.quote,selected);assert.equal(stored.blocks.anchor.data.locator.provider,'epub.quote')
  await until(async()=>(await call('get',[bookQuote]))[0].blocks.place?.data.found===true,'EPUB 定位加工失败')
  await dragSelect('.epub-content p');await note('保留上下文 #阅读')
  // 输入框夺走浏览器选区，保存仍须使用点击时的快照。
  await js('window.getSelection().removeAllRanges()');await clickText('.selection-note-dialog button','保存批注')
  await until(async()=>(await excerpts(book)).length===2,'EPUB 批注未保存')
  const notes=await call('get',await excerpts(book));assert(notes.some(v=>v.blocks.note?.data.text==='保留上下文'&&v.blocks.tags?.data.values.includes('阅读')))
  await shot('02-epub-marks.png')
  await clickText('.epub-footer button','下一章 →');await readyChapter('晴岚密语');await delay(400);await readyChapter('晴岚密语')
  await openItem(bookQuote);await readyChapter('雨后的山路')
  assert(await js(`!!document.querySelector('[data-content-mark="${bookQuote}"]')`))
  await dragSelect('.epub-content p')
  await js(`document.querySelector('.tab').dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}))`)
  assert.equal(await js(`!!document.querySelector('.content-selection-menu')`),false)
  checks.push('EPUB 实际拖选、统一菜单、标记、批注标签、焦点改变后保存快照、跨章回跳、切标签清选区')
  await openItem(text);await until(()=>js(`!!${active}?.querySelector('.reader-doc p')`),'文字阅读器未就绪')
  await dragSelect('.reader-doc p');const textQuote=await mark(text)
  await until(()=>js(`!!document.querySelector('[data-content-mark="${textQuote}"]')`),'文字高亮未出现')
  const legacyText=await call('create',{anchor:{target:text,type:'文本区间',quote:'普通文字',prefix:'共享选区',suffix:'也可以',offset:4,aspect:2},note:{text:'旧文字批注'}})
  await until(()=>js(`!!${active}?.querySelector('.text-mark')`),'旧文字高亮丢失')
  await dragSelect('.reader-doc p');await note('这条不应保存')
  await call('put',text,'text',{content:'原文已经改变，旧选区失效。'})
  await delay(400);await clickText('.selection-note-dialog button','保存批注')
  await until(()=>js(`document.querySelector('.selection-note-dialog [role=alert]')?.textContent.includes('重新选择')`),'失效选区未阻止写入')
  assert.equal((await excerpts(text)).length,1)
  await clickText('.selection-note-dialog button','取消')
  await call('undo');await delay(400)
  assert.equal((await call('get',[legacyText]))[0].blocks.note.data.text,'旧文字批注')
  await openItem(textQuote);await until(()=>js(`!!${active}?.querySelector('.reader-doc')`),'文字摘录回跳失败')
  checks.push('普通文字共用选区入口，旧文字标记继续显示；内容变化拒绝旧快照保存，撤销与回跳正常')
  await openItem(pdf);await until(()=>js(`!!${active}?.querySelector('.pdf-page[data-page="1"] .textLayer span')`),'PDF 文字层未就绪')
  await clickText('.pdf-bar button','目录')
  await until(()=>js(`!!document.querySelector('.pdf-outline-toggle')`),'文档目录未显示')
  await js(`document.querySelector('.pdf-outline-toggle').click()`)
  await clickText('.pdf-outline-entry','Second page')
  await until(()=>js(`${active}.querySelector('.pdf-page-jump').textContent.startsWith('2 /')`),'章节未跳到第二页')
  await clickText('.pdf-bar button','查找')
  await send('Input.insertText',{text:'shared channel'})
  await until(()=>js(`${active}.querySelector('.pdf-find [role=status]')?.textContent==='1 / 2'`),'文内匹配计数错误')
  await js(`${active}.querySelector('[aria-label="下一处匹配"]').click()`)
  await until(()=>js(`!!${active}.querySelector('[data-page="2"] .pdf-find-highlight')`),'第二页匹配未高亮')
  await js(`${active}.querySelector('[aria-label="关闭查找"]').click()`)
  await clickText('.pdf-outline-entry','Part one')
  await dragSelect('.pdf-page[data-page="1"] .textLayer span',12);const pdfQuote=await mark(pdf)
  await until(()=>js(`!!document.querySelector('[data-content-mark="${pdfQuote}"]')`),'PDF 新摘录高亮未出现')
  await clickText('.pdf-bar button','+');await delay(500)
  const geometry=await js(`(()=>{const m=document.querySelector('[data-content-mark="${pdfQuote}"]'),p=${active}.querySelector('.pdf-page[data-page="1"]'),a=m.getBoundingClientRect(),b=p.getBoundingClientRect();return {x:(a.left-b.left)/b.width,y:(a.top-b.top)/b.height}})()`)
  const box=(await call('get',[pdfQuote]))[0].blocks.anchor.data.locator.data.fragments[0].rects[0]
  assert(Math.abs(geometry.x-box.x)<.002&&Math.abs(geometry.y-box.y)<.002)
  const pdfSource=(await call('get',[pdf]))[0]
  const legacyPdf=await call('create',{anchor:{target:pdf,type:'PDF摘录',sourceHash:pdfSource.blocks.file.data.hash,quote:'旧 PDF 摘录',page:1,fragments:[{page:1,quote:'旧 PDF 摘录',rects:[{x:.06,y:.1,w:.3,h:.03}]}],aspect:2}})
  await until(()=>js(`!!document.querySelector('[data-pdf-mark="${legacyPdf}"]')`),'旧 PDF 高亮丢失')
  await js(`${active}.querySelector('.pdf-page[data-page="2"]').scrollIntoView({block:'center'})`)
  await until(()=>js(`!!${active}?.querySelector('.pdf-page[data-page="2"] .textLayer span')`),'PDF 第二页未就绪')
  await js(`(()=>{const a=${active}.querySelector('.pdf-page[data-page="1"] .textLayer span').firstChild,b=${active}.querySelector('.pdf-page[data-page="2"] .textLayer span').firstChild,r=document.createRange();r.setStart(a,0);r.setEnd(b,b.length);const s=window.getSelection();s.removeAllRanges();s.addRange(r);b.parentElement.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}))})()`)
  await until(()=>js(`!!document.querySelector('.content-selection-menu')`),'跨页选区未出现菜单')
  const multi=await mark(pdf,1),multiData=(await call('get',[multi]))[0].blocks.anchor.data
  assert.equal(multiData.locator.data.fragments.length,2)
  await openItem(pdfQuote);await until(()=>js(`!!document.querySelector('[data-content-mark="${pdfQuote}"]')`),'PDF 回跳失败')
  await shot('03-pdf-marks.png')
  checks.push('新 PDF 在 Electron 加工，实际拖选与跨页摘录、页内高亮、原文回跳，旧 PDF 标记保留')
  await openItem(bookQuote);await readyChapter('雨后的山路')
  await clickText('.epub-footer button','下一章 →');await readyChapter('晴岚密语')
  await delay(700);await stop();await start(2)
  await readyChapter('晴岚密语');await delay(400);await readyChapter('晴岚密语')
  await openItem(bookQuote);await readyChapter('雨后的山路');await until(()=>js(`!!document.querySelector('[data-content-mark="${bookQuote}"]')`),'重启丢失摘录标记')
  await call('trash',[bookQuote]);await until(()=>js(`!document.querySelector('[data-content-mark="${bookQuote}"]')`),'删除后标记未撤下')
  await call('undo');await until(()=>js(`!!document.querySelector('[data-content-mark="${bookQuote}"]')`),'撤销后标记未恢复')
  const runtime=await js('window.bridge.packages.runtime()'),anno=runtime.packages.find(p=>p.manifest.id==='annotate')
  const settings=await call('plugins')
  await js(`window.bridge.packages.apply(${JSON.stringify({disabled:settings.filter(p=>p.chosen).map(p=>p.id),changes:[{hash:anno.hash,enabled:false}]})})`)
  try{await js('void window.bridge.vaults.reload()')}catch(e){if(!String(e).includes('navigated or closed'))throw e}
  await until(()=>js(`!!document.querySelector('.tabbar')&&!window.epubTestCore`),'重载未恢复');await connectCore();await readyChapter('雨后的山路')
  await dragSelect('.epub-content p')
  assert.equal((await js(`document.querySelector('.content-selection-menu').innerText`)).includes('标记摘录'),false)
  assert.equal((await call('readContent',{id:bookQuote,kind:'anchor',field:'quote'})).text,selected)
  checks.push('从摘录继续阅读后重启仍续读、不被旧定位请求拉回；删除与撤销；停用批注后仍可选字复制，已有摘录可通用读取')
  assert.equal(errors.length,0,errors.join('\n'))
  writeFileSync(join(dir,'result.json'),JSON.stringify({ok:true,checks},null,2));console.log(JSON.stringify({ok:true,dir,checks},null,2))
}catch(error){try{await shot('failure.png');writeFileSync(join(dir,'failure-dom.txt'),await js('document.body.innerText'))}catch{};console.error({dir,error:error.stack,errors});process.exitCode=1}finally{await stop()}
