import { pluginSource } from '../helpers/plugin-sources.mjs'
// 独立 CDP 验证程序，不在宿主注册 capture flow，也不修改 MCP 或用户仓库。
// 先生成 artifacts/plugins/epub.rmplugin 和 npm run build，再 node tests/electron/epub-check.mjs。
import { build } from 'esbuild'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, createWriteStream } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const project = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
process.chdir(project)
const dir = mkdtempSync(join(tmpdir(), 'rm-epub-electron-')), helper = resolve('artifacts/checks/epub-prepare.cjs')
mkdirSync(dirname(helper), { recursive: true })
await build({ alias: { '@test-plugins/epub': pluginSource('epub') }, entryPoints: ['tests/electron/epub-prepare.ts'], outfile: helper, bundle: true, platform: 'node', format: 'cjs', target: 'node24', external: ['better-sqlite3'] })
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
  child = spawn(resolve('node_modules/.bin/electron'), ['.', '--remote-debugging-port=0'], { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] })
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
  if (!child || child.exitCode !== null) return
  const exited = once(child, 'exit')
  child.kill('SIGTERM')
  await Promise.race([exited, delay(5000).then(() => { if (child.exitCode === null) child.kill('SIGKILL') })])
  socket?.close(); pending.clear()
}
async function shot(name) { const image = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(dir, name), Buffer.from(image.data, 'base64')) }
const clickText = (selector, text) => js(`(() => { const e=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>e.textContent.trim()===${JSON.stringify(text)});if(!e)throw Error('找不到按钮 '+${JSON.stringify(text)});e.click() })()`)
async function readyChapter(title) { await until(() => js(`document.querySelector('.tab-pane.active .epub-content')?.textContent.includes(${JSON.stringify(title)}) || [...document.querySelectorAll('.epub-content')].some(e=>e.getBoundingClientRect().height>0 && e.textContent.includes(${JSON.stringify(title)}))`), `章节未显示：${title}`); await delay(250) }
const checks = []
try {
  await start(1)
  const assembly = (await call('info')).assembly.plugins
  for (const id of ['epub', ...prepared.bundled]) assert(assembly.some(p => p.id === id && p.enabled), `${id} 未启用`)
  const [id, second, fixed] = await call('ingest', ['山间来信.epub', 'EPUB2-无封面.epub', '固定版式.epub'].map(name => ({ type: 'file', path: join(dir, name) })))
  const book = await until(async () => { const [v] = await call('get', [id]); if (v.failures['epub.read']) throw Error(v.failures['epub.read']); return v.blocks.epub && v.blocks.thumb && v }, '新 EPUB 加工未完成')
  assert.deepEqual(book.failures, {})
  assert.equal(book.blocks.epub.data.title, '山间来信')
  assert.equal(book.blocks.still.data.path, book.blocks.epub.data.cover)
  // 代表图属于通用数据契约；批注可裁取 EPUB 刚产出的封面，验证两条加工链共同运行。
  const local = await call('create', { anchor: { target: id, type: '图片区域', x: 0, y: 0, w: 0.5, h: 0.5, aspect: 0.75 } })
  const crop = await until(async () => { const [v] = await call('get', [local]); if (Object.keys(v.failures).length) throw Error(JSON.stringify(v.failures)); return v.blocks.still && v.blocks.thumb && v }, '与 EPUB 共存的批注裁图未完成')
  assert(crop.blocks.still.data.path.endsWith(`${local}.jpg`))
  assert(existsSync(join(prepared.root, crop.blocks.still.data.path)))
  checks.push(`与 ${prepared.bundled.length} 个附带插件全部启用，EPUB 封面与批注裁图及各自缩略图成功`)
  assert.equal(readFileSync(join(prepared.root, book.blocks.file.data.path)).compare(readFileSync(join(dir, '山间来信.epub'))), 0)
  await until(async () => (await call('get', [second]))[0].blocks.epub, 'EPUB 2 未加工')
  await until(async () => (await call('get', [fixed]))[0].failures['epub.read']?.includes('固定版式'), '固定版式没有明确错误')
  assert.deepEqual(new Set((await call('query', { search: [{ kind: 'epubtext', field: 'content', text: '晴岚密语' }] })).ids), new Set([id, second]))
  const chapterQuery = await call('executeQuery', { query: 'epub.read_chapter', args: { id, chapter: 2, limit: 500 } })
  assert(chapterQuery.result.text.includes('晴岚密语'))
  checks.push('Electron utilityProcess 导入 EPUB 2/3、封面与正文加工、固定版式错误、原文件、搜索与章节查询')
  await until(() => js(`!!document.querySelector('[data-entity-id="${id}"]')`), '书籍卡片未出现')
  await js(`document.querySelector('[data-entity-id="${id}"]').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`)
  await readyChapter('雨后的山路')
  assert.equal(await js('window.EPUB_INJECTED'), undefined)
  await clickText('.epub-toolbar button', '☰ 目录')
  await until(() => js(`!!document.querySelector('.epub-directory')`), '目录面板未出现')
  await shot('01-reader.png')
  await clickText('.epub-toc-row', '二 · 风经过书页')
  await readyChapter('晴岚密语')
  await js(`document.querySelector('.epub-scroll').scrollTop=1400`)
  const saved = await until(async () => { const [v] = await call('get', [id]); return v.blocks.epubreading?.data.offset > 300 && v.blocks.epubreading.data }, '阅读位置未保存')
  await clickText('.epub-toolbar button', '书签＋')
  await until(async () => (await call('get', [id]))[0].blocks.epubbookmarks?.data.items.length === 1, '书签未保存')
  await clickText('.epub-settings-wrap>button', 'Aa 排版')
  await js(`document.querySelector('[aria-label="增大字号"]').click()`)
  await delay(500)
  assert(await js(`document.querySelector('.epub-scroll').scrollTop>800`))
  await clickText('.epub-settings-wrap>button', 'Aa 排版')
  const readingTab = await js(`document.querySelector('.tab.active').dataset.tab`)
  await js(`document.querySelector('.tab:not(.active)').dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}))`)
  await delay(250)
  await js(`document.querySelector('[data-tab="${readingTab}"]').dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}))`)
  await readyChapter('晴岚密语')
  assert(await js(`document.querySelector('.epub-scroll').scrollTop>800`))
  checks.push('实际阅读、目录跳转、滚动保存、书签、字号变化和切换标签续读')
  await clickText('.epub-toc-row', '一则脚注')
  await until(() => js(`(()=>{const r=[...document.querySelectorAll('[data-epub-anchor]')].find(e=>e.dataset.epubAnchor==='note').getBoundingClientRect(),v=document.querySelector('.epub-scroll').getBoundingClientRect();return r.top>=v.top && r.bottom<=v.bottom})()`), '脚注定位失败')
  await clickText('.epub-content a', '回到第一章')
  await readyChapter('雨后的山路')
  await clickText('.epub-toolbar button', '搜索')
  await js(`const input=document.querySelector('.epub-search input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'晴岚密语');input.dispatchEvent(new Event('input',{bubbles:true}));`)
  await clickText('.epub-search button', '查找')
  await readyChapter('晴岚密语')
  assert((await js(`document.querySelector('.epub-content mark')?.textContent`)).includes('晴岚密语'))
  await send('Emulation.setDeviceMetricsOverride', { width: 860, height: 720, deviceScaleFactor: 1, mobile: false })
  await shot('02-narrow.png')
  assert(await js(`document.querySelector('.epub-toolbar').scrollWidth<=document.querySelector('.epub-toolbar').clientWidth+1`))
  await send('Emulation.clearDeviceMetricsOverride')
  await js(`document.querySelector('.epub-scroll').scrollTop=1700`)
  const resume = await until(async () => { const [v] = await call('get', [id]); return v.blocks.epubreading?.data.offset > 300 && v.blocks.epubreading.data }, '重启前位置未保存')
  await delay(1000); await shot('03-resume-before.png')
  checks.push('脚注与跨章链接、书内搜索定位、高亮、窄窗口布局')
  writeFileSync(join(dir, 'resume.json'), JSON.stringify({ id, resume, saved }))
  await stop(); await start(2)
  await readyChapter('晴岚密语')
  assert(await js(`document.querySelector('.epub-scroll').scrollTop>800`))
  assert((await call('get', [id]))[0].blocks.epubbookmarks.data.items.length === 1)
  await shot('04-resume-after.png')
  checks.push('退出并重启应用后续读与书签恢复')
  const settings = await call('plugins')
  await js(`window.bridge.packages.apply(${JSON.stringify({ disabled: settings.filter(p => p.chosen).map(p => p.id), changes: [{ hash: prepared.hash, enabled: false }] })})`)
  try { await js('void window.bridge.vaults.reload()') } catch (e) { if (!String(e).includes('navigated or closed')) throw e }
  await until(() => js(`!!document.querySelector('.tabbar') && !window.epubTestCore`), '重载界面未恢复'); await connectCore()
  await until(async () => !(await call('info')).assembly.plugins.some(p => p.id === 'epub' && p.enabled), '停用未生效')
  assert((await call('readContent', { id, kind: 'epubtext', field: 'content' })).text.includes('雨后的山路'))
  assert.equal((await call('get', [id]))[0].blocks.epubreading.data.sourceHash, book.blocks.file.data.hash)
  await js(`window.bridge.packages.uninstall(${JSON.stringify(prepared.hash)})`)
  checks.push('实际停用和卸载后原文、进度及书签保留')
  assert.equal(errors.length, 0, errors.join('\n'))
  writeFileSync(join(dir, 'result.json'), JSON.stringify({ ok: true, checks }, null, 2))
  console.log(JSON.stringify({ ok: true, dir, checks }, null, 2))
} catch (error) {
  try { await shot('failure.png'); writeFileSync(join(dir, 'failure-dom.txt'), await js('document.body.innerText')) } catch {}
  console.error({ dir, error: String(error), errors }); process.exitCode = 1
} finally { await stop() }
