import { pluginSource } from '../helpers/plugin-sources.mjs'
// AI 对话外部包真实 Electron 验证；本机模拟模型，不使用真实密钥或计费接口。
// npm run build 后运行 node tests/electron/ai-chat-check.mjs。
import { build } from 'esbuild'
import { createServer } from 'node:http'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, createWriteStream, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const project = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
process.chdir(project)
const dir = mkdtempSync(join(tmpdir(), 'rm-ai-chat-')), helper = resolve('artifacts/checks/ai-chat-prepare.cjs')
mkdirSync(dirname(helper), { recursive: true })
await build({ entryPoints: ['tests/electron/ai-chat-prepare.ts'], outfile: helper, bundle: true, platform: 'node', format: 'cjs', target: 'node24', external: ['better-sqlite3'] })
const exampleSource=join(dir,'plugin-source'),examplePackage=join(dir,'ai-chat.rmplugin')
cpSync(pluginSource("ai-chat"),exampleSource,{recursive:true})
execFileSync(process.execPath,['scripts/plugins/pack.ts',exampleSource,examplePackage],{cwd:project,stdio:'inherit'})
execFileSync(process.execPath, [helper, dir, examplePackage], { cwd: project, stdio: 'inherit' })
const prepared = JSON.parse(readFileSync(join(dir, 'prepared.json'), 'utf8'))
const browserChecks=await build({stdin:{contents:"export { buildTextIndex } from './src/plugins/text/textindex'; export { markDocTerms } from './src/plugins/text/highlight'",resolveDir:project},bundle:true,platform:'browser',format:'iife',globalName:'textMathCheck',write:false})
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

const active="document.querySelector('.tab-pane:not(.hidden)')"
const checks=[]
async function openItem(id) {
  await js(`document.querySelector('.tab').dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}))`)
  await until(()=>js(`!!${active}?.querySelector('[data-entity-id="${id}"]')`),'找不到素材 '+id)
  await js(`${active}.querySelector('[data-entity-id="${id}"]').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`)
}
async function click(text,selector='button') {
  await until(()=>js(`(()=>{const el=[...document.querySelectorAll(${JSON.stringify(selector)})].find(el=>el.textContent.trim()===${JSON.stringify(text)}&&el.checkVisibility());if(!el)return false;el.click();return true})()`),`找不到按钮 ${text}`)
}
async function clickSelector(selector) { await until(()=>js(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el||!el.checkVisibility())return false;el.click();return true})()`),`找不到 ${selector}`) }
const fill=async(selector,value)=>js(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}))})()`)
async function reload() {
  await js(`void window.bridge.vaults.reload().catch(()=>{})`)
  await until(()=>js(`location.href==='about:blank'`).catch(()=>false),'未进入重载',5000).catch(()=>{})
  await until(()=>js(`!!document.querySelector('.tabbar')&&!!window.bridge`).catch(()=>false),'重载未完成')
  await connectCore()
}
const service=(method,input)=>js(`window.bridge.services.invoke('ai-chat',${JSON.stringify(method)},${JSON.stringify(input)})`)
const requests=[];let aborted=0
const ring=String.raw`\mathbb Z[\sqrt2]=\{x+y\sqrt2:x,y\in\mathbb Z\}.`
const longFormula=String.raw`a_1+a_2+a_3+a_4+a_5+a_6+a_7+a_8+a_9+a_{10}=\sum_{i=1}^{10}a_i`
const network=createServer((req,res)=>{
  let body='';req.on('data',data=>body+=data);req.on('end',()=>{
    const value=JSON.parse(body);requests.push({value,authorization:req.headers.authorization,url:req.url})
    if(value.messages.at(-1).content.includes('错误测试')){res.writeHead(401);res.end('private-dummy-key');return}
    res.writeHead(200,{'Content-Type':'text/event-stream'})
    const slow=value.messages.at(-1).content.includes('慢速')
    const chunks=slow?Array(200).fill('还在回答。'):['## 阅读这段话\n\n','这是模拟模型给出的','**流式回答**。\n\n','$$\n'+ring,'\n$$\n\n',String.raw`行内公式 \(\frac{1}{2}+\sqrt{2}\) 也可以。`+'\n\n','$$\n'+longFormula+'\n$$\n\n','- 只使用你选择的引用\n','- 可以回到原文继续阅读。']
    let i=0
    const timer=setInterval(()=>{
      if(i===chunks.length){clearInterval(timer);res.write('data: '+JSON.stringify({choices:[{index:0,delta:{},finish_reason:'stop'}]})+'\n\n');res.end('data: [DONE]\n\n')}
      else res.write('data: '+JSON.stringify({choices:[{index:0,delta:{content:chunks[i++]},finish_reason:null}]})+'\n\n')
    },slow?80:180)
    res.on('close',()=>{clearInterval(timer);if(!res.writableEnded)aborted++})
  })
})
network.listen(0,'127.0.0.1');await once(network,'listening')
const endpoint=`http://127.0.0.1:${network.address().port}/v1`
const conversations=()=>call('query',{scope:'all',has:['ai-chat.conversation']})
const latest=async()=>{const ids=(await conversations()).ids;const [view]=await call('get',[ids[0]]);return view}
async function dragSelect(selector,count=10){
  await js('window.getSelection().removeAllRanges()')
  const point=await js(`(()=>{const el=${active}.querySelector(${JSON.stringify(selector)});if(!el)throw Error('没有选区正文');el.scrollIntoView({block:'center'});const w=document.createTreeWalker(el,NodeFilter.SHOW_TEXT);let n;while(n=w.nextNode()){if(n.textContent.trim().length>=${count})break};if(!n)throw Error('正文太短');const r=document.createRange();r.setStart(n,0);r.setEnd(n,0);const a=r.getBoundingClientRect();r.setStart(n,${count});r.setEnd(n,${count});const b=r.getBoundingClientRect();return {a:{x:a.x+1,y:a.y+a.height/2},b:{x:b.x+1,y:b.y+b.height/2},text:n.textContent.slice(0,${count})}})()`)
  await delay(200)
  await send('Input.dispatchMouseEvent',{type:'mousePressed',...point.a,button:'left',buttons:1,clickCount:1})
  for(let i=1;i<=10;i++)await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:point.a.x+(point.b.x-point.a.x)*i/10,y:point.a.y+(point.b.y-point.a.y)*i/10,button:'left',buttons:1})
  await send('Input.dispatchMouseEvent',{type:'mouseReleased',...point.b,button:'left',buttons:0,clickCount:1})
  assert.equal(await js('window.getSelection().toString()'),point.text)
  await until(()=>js(`document.querySelectorAll('.content-selection-menu').length===1`),'统一选区菜单未出现')
  assert((await js(`document.querySelector('.content-selection-menu').innerText`)).includes('向 AI 提问'))
  return point.text
}
try {
  await start(1)
  const plugins=await call('plugins');assert(plugins.some(p=>p.id==='ai-chat'&&p.enabled),JSON.stringify(plugins))
  const [asset,markdownAsset]=await call('ingest',[{type:'file',path:join(dir,'阅读验证.txt')},{type:'file',path:join(dir,'数学笔记.md')}])
  await until(async()=>(await call('get',[asset,markdownAsset])).every(v=>v.blocks.body),'新 TXT/Markdown 正文未加工')
  await until(()=>js(`!!${active}?.querySelector('[data-entity-id="${asset}"]')`),'找不到新素材')
  await js(`${active}.querySelector('[data-entity-id="${asset}"]').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`)
  await until(()=>js(`!!${active}?.querySelector('.reader-doc')`),'文字阅读器未打开')
  assert(await js(`${active}.querySelector('.doc-plain').textContent.includes('$x^2$')`))
  assert.equal(await js(`!!${active}.querySelector('.katex')`),false)
  const selected=await dragSelect('.reader-doc',10)
  await shot('01-selection.png');await click('向 AI 提问','.content-selection-menu button')
  await until(()=>js(`document.querySelector('.ai-chat-composer .ai-chat-reference')?.textContent.includes(${JSON.stringify(selected)})`),'选区未到达聊天')
  assert.equal(requests.length,0)
  await clickSelector('[aria-label="模型设置"]')
  await until(()=>js(`!!document.querySelector('[aria-label="AI 接口地址"]:not(:disabled)')`),'设置未加载')
  await fill('[aria-label="AI 接口地址"]',endpoint);await fill('[aria-label="AI 模型名称"]','mock-reader')
  const protectedStorage=(await service('settings')).protectedStorage
  if(protectedStorage)await fill('[aria-label="AI API Key"]','private-dummy-key')
  await click('保存设置');await until(async()=>(await service('settings')).model==='mock-reader','设置未保存')
  await fill('[aria-label="AI 问题"]','解释一下这段话');await click('发送 ↑')
  await until(()=>js(`document.querySelector('.ai-chat-assistant .ai-chat-markdown')?.textContent.includes('阅读这段话')`),'没有流式输出')
  await until(()=>js(`document.querySelector('.ai-chat-assistant .ai-chat-math-source')?.textContent.includes('mathbb')`),'未闭合公式没有保留源码')
  assert.equal(await js(`!!document.querySelector('.ai-chat-assistant .katex')`),false)
  await shot('02-streaming.png')
  // 切中央标签和右侧面板不停止请求。
  await js(`document.querySelector('.tab').dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}))`)
  await click('详情');await until(async()=>(await latest()).blocks['ai-chat.conversation'].data.messages.at(-1).status==='complete','隐藏后未完成')
  await click('AI 对话');const saved=await latest(), messages=saved.blocks['ai-chat.conversation'].data.messages
  assert.equal(messages[0].reference.sourceId,asset);assert.equal(messages[0].reference.text,selected)
  assert.equal(requests[0].url,'/v1/chat/completions');assert.equal(requests[0].value.stream,true)
  assert(requests[0].value.messages[0].content.includes(selected));assert(!JSON.stringify(requests[0].value).includes('未被选中的内容'));assert(!JSON.stringify(requests[0].value).includes('locator'))
  assert(!JSON.stringify(saved).includes('private-dummy-key'))
  assert(messages[1].text.includes(ring))
  await until(()=>js(`document.querySelectorAll('.ai-chat-assistant .katex').length===3`),'完成后未渲染数学公式')
  assert.equal(await js(`!!document.querySelector('.ai-chat-panel .katex-error')`),false)
  assert.equal(await js(`document.querySelector('.ai-chat-assistant math [mathvariant="double-struck"]').textContent`),'Z')
  // 文字模块和外部 AI 包各自提供字体；显式加载同族的声明，避免未使用副本让 check 返回 false。
  await js(`Promise.all([document.fonts.load('14px KaTeX_Main'),document.fonts.load('14px KaTeX_AMS')])`)
  assert(await js(`document.fonts.check('14px KaTeX_Main')&&document.fonts.check('14px KaTeX_AMS')`),'公式字体未加载')
  if(protectedStorage)assert.equal(requests[0].authorization,'Bearer private-dummy-key')
  await click('↗ 引用原文');await until(()=>js(`!!${active}?.querySelector('.reader-doc')`),'引用未返回阅读器')
  await js(`document.querySelector('.ai-chat-math-block').scrollIntoView({block:'center'})`)
  await shot('03-answer.png')
  await send('Emulation.setDeviceMetricsOverride',{width:940,height:720,deviceScaleFactor:1,mobile:false})
  assert(await js(`(()=>{const blocks=[...document.querySelectorAll('.ai-chat-math-block')],scroll=document.querySelector('.ai-chat-scroll');return blocks.some(b=>b.scrollWidth>b.clientWidth)&&scroll.scrollWidth<=scroll.clientWidth+1})()`),'长公式没有局部滚动或撑宽了聊天区域')
  await shot('03-math-narrow.png');await send('Emulation.clearDeviceMetricsOverride')
  await click('保存为文字')
  const savedText=await until(async()=>{const ids=(await call('query',{has:['text']})).ids;return (await call('get',ids)).find(v=>v.blocks.text?.data.content.includes(ring))},'另存文字没有保留公式源码')
  await until(()=>js(`${active}?.querySelectorAll('.reader-doc .katex').length===3`),'另存后的文字阅读器未渲染公式')
  await js(browserChecks.outputFiles[0].text)
  assert(await js(`(()=>{const root=document.createElement('div');root.innerHTML=${active}.querySelector('.reader-doc').innerHTML;const before=[...root.querySelectorAll('.katex')].map(n=>n.outerHTML);textMathCheck.markDocTerms(root,['x','Z','模拟模型']);const index=textMathCheck.buildTextIndex(root),after=[...root.querySelectorAll('.katex')].map(n=>n.outerHTML);const start=index.text.indexOf('只使用你选择的引用');return JSON.stringify(before)===JSON.stringify(after)&&!!root.querySelector('mark')&&!index.text.includes('\\\\mathbb')&&!index.text.includes('\\u200b')&&index.range(start,start+9).toString()==='只使用你选择的引用'})()`),'公式高亮或文字索引异常')
  await click('编辑', '.tab-pane:not(.hidden) .reader-bar button')
  assert.equal(await js(`${active}.querySelector('.reader-editor').value`),messages[1].text)
  const edited=messages[1].text.replaceAll('\\sqrt2','\\sqrt3')
  assert.notEqual(edited,messages[1].text)
  await fill('.tab-pane:not(.hidden) .reader-editor',edited);await click('完成','.tab-pane:not(.hidden) .reader-bar button')
  await until(async()=>(await call('get',[savedText.id]))[0].blocks.text.data.content===edited,'编辑公式未保存')
  await call('undo');await until(()=>js(`${active}.querySelector('math annotation')?.textContent.includes('sqrt2')`),'撤销公式修改失败')
  const markedText=await dragSelect('.reader-doc li',9)
  await click('标记摘录','.content-selection-menu button')
  const excerpt=await until(async()=>{const ids=(await call('query',{has:['anchor']})).ids;return (await call('get',ids)).find(v=>v.blocks.anchor.data.target===savedText.id)},'公式后的摘录未保存')
  assert.equal(excerpt.blocks.anchor.data.quote,markedText)
  await until(()=>js(`!!document.querySelector('[data-content-mark="${excerpt.id}"]')`),'公式后摘录高亮未出现')
  await shot('07-text-formulas.png')
  const short=await call('create',{text:{content:'$x^2$'}})
  await js(`document.querySelector('.tab').dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}))`)
  await until(()=>js(`!!${active}?.querySelector('[data-entity-id="${short}"] .katex')`),'短公式卡片未排版')
  await js(`${active}.querySelector('[data-entity-id="${short}"]').dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}))`)
  await send('Input.dispatchKeyEvent',{type:'keyDown',key:' ',code:'Space',windowsVirtualKeyCode:32});await send('Input.dispatchKeyEvent',{type:'keyUp',key:' ',code:'Space',windowsVirtualKeyCode:32})
  await until(()=>js(`!!document.querySelector('.preview-doc .katex')`),'空格预览未渲染公式')
  await shot('08-formula-preview.png')
  await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27})
  await openItem(markdownAsset);await until(()=>js(`!!${active}?.querySelector('.reader-doc .katex')`),'新 Markdown 文件未渲染公式')
  assert(await js(`${active}.querySelector('.reader-doc .wikilink').textContent==='阅读原文'`))
  const mdView=(await call('get',[markdownAsset]))[0]
  assert.equal(readFileSync(join(prepared.root,mdView.blocks.file.data.path),'utf8'),readFileSync(join(dir,'数学笔记.md'),'utf8'))
  await click('AI 对话')
  await fill('[aria-label="AI 问题"]','慢速回答测试');await click('发送 ↑')
  await until(()=>js(`[...document.querySelectorAll('.ai-chat-markdown')].at(-1)?.textContent.includes('还在回答')`),'慢速回答未开始')
  await click('■ 停止');await until(()=>aborted>=1,'停止未中断 HTTP')
  await until(async()=>(await latest()).blocks['ai-chat.conversation'].data.messages.at(-1).status==='stopped','部分回答未保存')
  await fill('[aria-label="AI 问题"]','错误测试');await click('发送 ↑')
  await until(async()=>(await latest()).blocks['ai-chat.conversation'].data.messages.at(-1).status==='error','错误未保存')
  assert(!await js(`document.querySelector('.ai-chat-panel').innerText.includes('private-dummy-key')`));assert(await js(`document.querySelector('.ai-chat-panel').innerText.includes('401')`))
  const count=requests.length;await delay(500);assert.equal(requests.length,count)
  await fill('[aria-label="AI 问题"]','慢速重载测试');await click('发送 ↑');await until(()=>requests.length>count,'重载请求未开始')
  await reload();await until(()=>aborted>=2,'重载未中断 HTTP')
  await click('AI 对话');await until(()=>js(`document.querySelector('.ai-chat-panel').textContent.includes('回答已中断')`),'重开未显示中断')
  const afterReload=requests.length;await delay(500);assert.equal(requests.length,afterReload)
  await send('Emulation.setDeviceMetricsOverride',{width:940,height:720,deviceScaleFactor:1,mobile:false});await shot('04-narrow.png');await send('Emulation.clearDeviceMetricsOverride')
  await stop();await start(2);await click('AI 对话')
  await until(()=>js(`document.querySelector('.ai-chat-panel').textContent.includes('流式回答')`),'退出重开丢失历史')
  assert.equal((await service('settings')).model,'mock-reader')
  const mathQuestion='第二段对话：$'+ring+'$'
  await clickSelector('[aria-label="新建 AI 对话"]');await fill('[aria-label="AI 问题"]',mathQuestion);await click('发送 ↑')
  await until(async()=>(await conversations()).ids.length===2,'新对话未保存')
  await until(()=>js(`![...document.querySelectorAll('.ai-chat-panel button')].some(b=>b.textContent.includes('停止'))`),'新对话未完成')
  assert(await js(`!!document.querySelector('.ai-chat-user .katex')`),'用户消息未渲染公式')
  assert.equal(requests.at(-1).value.messages.at(-1).content,mathQuestion)
  await shot('06-math-question.png')
  await clickSelector('[aria-label="对话历史"]');await click('解释一下这段话','.ai-chat-history button')
  await until(()=>js(`document.querySelector('.ai-chat-panel').textContent.includes('回答已中断')`),'历史无法切换')
  await call('setPluginSettings',[],[{...prepared.ref,enabled:false}]);await reload()
  assert.equal(await js(`!!document.querySelector('[data-ai-chat]')`),false)
  assert.equal((await conversations()).ids.length,2)
  await call('setPluginSettings',[],[{...prepared.ref,enabled:true}]);await reload();await click('AI 对话')
  assert.equal((await service('settings')).model,'mock-reader');assert.equal((await conversations()).ids.length,2)
  assert.equal(errors.length,0,errors.join('\n'));await shot('05-reenabled.png')
  checks.push('项目外打包安装，真实 utilityProcess 新 TXT 加工，真实鼠标划选经公共选区进入聊天草稿')
  checks.push('UI 配置、SSE 流式回答，切标签／隐藏面板继续，停止取消 HTTP 并保存部分回答')
  checks.push('只发送对话与显式引用，回原文，回答另存文字，HTTP 错误无凭据泄露且不重试')
  checks.push('重载中断、退出重开、历史切换、窄窗口、停用与重新启用保留历史及配置')
  checks.push('问题与回答公式、流式未闭合回退、离线字体、长公式局部滚动，发送及另存保留 LaTeX 原文')
  checks.push('另存文字即时排版、编辑源码与撤销、公式后摘录、搜索不破坏公式、短公式卡片和空格预览、新 Markdown 文件与双链、TXT 保留原文')
  checks.push(protectedStorage?'本机系统加密保存假密钥并成功用于模拟请求':'本机保护不可用，本轮以无密钥模拟接口验证')
  writeFileSync(join(dir,'result.json'),JSON.stringify({ok:true,checks},null,2));console.log(JSON.stringify({ok:true,dir,checks},null,2))
} catch(error) {
  try{await shot('failure.png');writeFileSync(join(dir,'failure-dom.txt'),await js('document.body.innerText'))}catch{}
  console.error({dir,error:error.stack,errors});process.exitCode=1
} finally {await stop();network.closeAllConnections();await new Promise(r=>network.close(r))}
