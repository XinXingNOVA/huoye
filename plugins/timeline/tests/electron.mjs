// Black-box regression. No host source imports or database fixtures.
// A built host and local plugin pack are required; all data is isolated.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connect } from './cdp.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const configured = process.env.RM_PLUGIN_TOOLCHAIN || JSON.parse(readFileSync(join(root, '.rm-dev.json'), 'utf8')).toolchain
const host = resolve(root, configured)
const electron = createRequire(join(host, 'package.json'))('electron')
const temp = mkdtempSync(join(tmpdir(), 'rm-timeline-check-'))
const freePort = async () => {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const port = server.address().port; await new Promise(r => server.close(r)); return port
}
const mainPort = await freePort(), pagePort = await freePort()
const pause = ms => new Promise(r => setTimeout(r, ms))
let child, main, page, logs = ''
const until = async fn => {
  const end = Date.now() + 15000; let error
  while (Date.now() < end) {
    try { const value = await fn(); if (value) return value } catch (e) { error = e }
    await pause(100)
  }
  throw new Error('Timed out: ' + (error?.message || 'condition did not become true'))
}
const launch = async () => {
  const env = { ...process.env, RM_USER_DATA: join(temp, 'user-data'), LIBRARY_PATH: join(temp, 'test.library') }
  for (const key of ['CAPTURE_DIR', 'CAPTURE_FLOW', 'ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL']) delete env[key]
  child = spawn(electron, [`--inspect=127.0.0.1:${mainPort}`, `--remote-debugging-port=${pagePort}`, '.'], { cwd: host, env, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', d => { logs += d }); child.stderr.on('data', d => { logs += d })
  main = await until(() => connect(mainPort))
  page = await until(() => connect(pagePort, t => t.type === 'page'))
  await until(() => page.evaluate(`!!document.querySelector('[aria-label="显示设置"]')`))
}
const quit = async () => {
  const exiting = child, closed = once(exiting, 'close')
  await main.evaluate(`process.mainModule.require('electron').app.quit(); true`)
  page.close(); main.close()
  let timer
  try { await Promise.race([closed, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Electron did not exit')), 10000) })]) }
  finally { clearTimeout(timer) }
  child = undefined
}
const rpcSetup = `new Promise(resolve=>{
  window.addEventListener('message',function receive(e){
    if(e.data!=='core:port')return;window.removeEventListener('message',receive);
    const port=e.ports[0],pending=new Map();let seq=0;
    port.onmessage=ev=>{const p=pending.get(ev.data.id);if(p){pending.delete(ev.data.id);ev.data.error?p.reject(Error(ev.data.error)):p.resolve(ev.data.result)}};
    globalThis.testRpc=(method,...args)=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});port.postMessage({id,method,args})});resolve(true)
  });window.bridge.connectCore()
})`
const deadline = setTimeout(() => { console.error('Electron test timed out'); child?.kill('SIGKILL'); process.exitCode = 1 }, 90000)
try {
  console.log('Isolated integration data: ' + temp)
  await launch()
  const pack = join(root, 'artifacts/timeline.rmplugin')
  await main.evaluate(`globalThis.savedDialog=process.mainModule.require('electron').dialog.showOpenDialog;process.mainModule.require('electron').dialog.showOpenDialog=async()=>({canceled:false,filePaths:[${JSON.stringify(pack)}]})`)
  await page.evaluate(`(async()=>{const p=await window.bridge.packages.pick();await window.bridge.packages.install(p.token);await window.bridge.packages.apply({disabled:[],changes:[{hash:p.items[0].hash,enabled:true}]});return true})()`)
  await main.evaluate(`process.mainModule.require('electron').dialog.showOpenDialog=globalThis.savedDialog`)
  await quit(); await launch()
  await page.evaluate(rpcSetup)
  const files = join(temp, 'files'); mkdirSync(files)
  const paths = Array.from({ length: 90 }, (_, i) => { const path = join(files, `Note-${i}.md`); writeFileSync(path, `# Note ${i}\nUnique import ${i}\n`); return { path } })
  const report = await page.evaluate(`testRpc('importFiles',{requestId:'timeline-regression-import',files:${JSON.stringify(paths)}})`)
  assert.equal(report.errors.length, 0)
  await page.evaluate(`document.querySelector('[aria-label="显示设置"]').click();true`)
  await until(() => page.evaluate(`!!document.querySelector('[aria-label="浏览布局"]')`))
  await page.evaluate(`{const el=document.querySelector('[aria-label="浏览布局"]');el.value='timeline';el.dispatchEvent(new Event('change',{bubbles:true}));true}`)
  await until(() => page.evaluate(`document.querySelectorAll('.rm-timeline .card').length > 0`))
  await page.evaluate(`document.querySelector('.display-panel').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));document.querySelector('.rm-timeline-scroll').scrollTop=950;true`)
  await until(() => page.evaluate(`document.querySelector('.rm-timeline-scroll').scrollTop > 900`))
  // Let the scroll event reach the host page-state callback before requesting shutdown.
  await pause(200)
  const before = await page.evaluate(`document.querySelector('.rm-timeline-scroll').scrollTop`)
  assert((await page.evaluate(`document.querySelectorAll('.rm-timeline .card').length`)) < 90)
  await quit(); await launch()
  await until(() => page.evaluate(`document.querySelectorAll('.rm-timeline .card').length > 0`))
  await until(() => page.evaluate(`Math.abs(document.querySelector('.rm-timeline-scroll').scrollTop-${before})<1`))
  console.log('Fresh imports, virtual cards and full restart restored the timeline position: ' + before)
  await quit()
} finally {
  clearTimeout(deadline); page?.close(); main?.close(); if (child?.exitCode === null) child.kill('SIGKILL')
  writeFileSync(join(temp, 'electron.log'), logs)
}
