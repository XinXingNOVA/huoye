import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createWriteStream, existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
const dir = mkdtempSync(join(tmpdir(),'rm-application-creation-'))
console.log(dir)
for (const flow of ['appcreation','appcreationresume','appcreationrestore']) {
  const env = { ...process.env, RM_USER_DATA:join(dir,'user-data'), CAPTURE_DIR:dir, CAPTURE_FLOW:flow }
  delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL; delete env.LIBRARY_PATH
  const child = spawn(resolve('node_modules/.bin/electron'),['.'],{ env, detached:process.platform!=='win32', stdio:['ignore','pipe','pipe'] })
  const file = join(dir,flow+'.log'), log = createWriteStream(file)
  child.stdout.pipe(log,{end:false});child.stderr.pipe(log,{end:false})
  const timeout=setTimeout(()=>{try{if(process.platform==='win32')child.kill('SIGKILL');else process.kill(-child.pid,'SIGKILL')}catch{}},90000)
  const [code]=await once(child,'close');clearTimeout(timeout)
  await new Promise(r=>log.end(r))
  assert.equal(code,0,readFileSync(file,'utf8'))
  assert(existsSync(join(dir,flow+'-result.json')),readFileSync(file,'utf8'))
}
console.log('MCP 后台创建、隐藏窗口、取消与中断接续通过：'+dir)
