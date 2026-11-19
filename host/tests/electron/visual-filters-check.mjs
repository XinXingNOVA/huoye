// 可选跨插件验收；显式传入插件工程，不改变正式附带清单。
import { createRequire } from 'node:module'
import { build } from 'esbuild'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, createWriteStream } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { once } from 'node:events'
import assert from 'node:assert/strict'
const require = createRequire(import.meta.url)
const roots = process.argv.slice(2)
if (roots.length < 2 || roots.length > 3) throw Error('用法：node tests/electron/visual-filters-check.mjs <rating 工程> <image-filter 工程> [palette 工程]；先 npm run build')
const dir = mkdtempSync(join(tmpdir(), 'rm-visual-filters-'))
const userData = join(dir, 'user-data'), library = join(dir, '测试.library')
console.log(dir)
const packs = roots.map((root,i) => { const pack = join(dir, `${i}.rmplugin`); execFileSync(process.execPath,['scripts/plugins/pack.ts',resolve(root),pack],{stdio:'inherit'}); return pack })
mkdirSync('artifacts/checks',{recursive:true})
const prepare = resolve('artifacts/checks/visual-filters-prepare.cjs')
await build({stdin:{contents:`
import { readFileSync } from 'node:fs'
import { PackageManager } from './src/plugin-packages/manager'
import { openLibrary } from './src/core/library'
import { setBinding } from './src/core/external-plugins'
import { PLUGINS } from './src/plugins/manifest'
const manager = new PackageManager(process.argv[2], PLUGINS.map(p=>p.id))
const lib = openLibrary(process.argv[3])
try { for(const path of process.argv.slice(4)) { const ref=manager.install(readFileSync(path)); manager.grant(lib.root,ref.hash); setBinding(lib,{...ref,enabled:true},PLUGINS) } } finally { lib.close() }
`,resolveDir:process.cwd()},outfile:prepare,bundle:true,platform:'node',format:'cjs',packages:'external'})
execFileSync(process.execPath,[prepare,userData,library,...packs],{stdio:'inherit'})
const entry = resolve('out/main/visual-filters-check.cjs')
await build({entryPoints:['tests/electron/visual-filters-main.ts'],outfile:entry,bundle:true,platform:'node',format:'cjs',packages:'external'})
for (const phase of ['first','resume']) {
 const env={...process.env,RM_USER_DATA:userData,LIBRARY_PATH:library,VISUAL_CHECK_DIR:dir,VISUAL_CHECK_PHASE:phase,VISUAL_CHECK_PALETTE:roots.length===3?'1':''}
 delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL; delete env.CAPTURE_DIR
 const child=spawn(require('electron'),[entry],{env,stdio:['ignore','pipe','pipe']})
 const logPath=join(dir,phase+'.log'),log=createWriteStream(logPath)
 child.stdout.pipe(log,{end:false});child.stderr.pipe(log,{end:false})
 const timer=setTimeout(()=>child.kill('SIGKILL'),90000)
 const [code]=await once(child,'close');clearTimeout(timer);await new Promise(r=>log.end(r))
 assert.equal(code,0,readFileSync(logPath,'utf8'))
 console.log(readFileSync(join(dir,phase+'-result.json'),'utf8'))
}
console.log('真实 Electron 新图加工、筛选、评分、撤销与重开通过：'+dir)
