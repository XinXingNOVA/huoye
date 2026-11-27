// 验证应用级替换：真实设置窗口确认、当前仓库重载、关闭仓库更新以及应用重开。
import { createRequire } from 'node:module'
import { build } from 'esbuild'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, createWriteStream } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { once } from 'node:events'
import assert from 'node:assert/strict'
const require = createRequire(import.meta.url)
const dir = mkdtempSync(join(tmpdir(), 'rm-plugin-update-'))
console.log(dir)
mkdirSync('artifacts/checks', { recursive: true })
const prepare = resolve('artifacts/checks/plugin-update-prepare.cjs')
await build({ stdin: { contents: `
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PackageManager } from './src/plugin-packages/manager'
import { SuiteCatalog } from './src/plugin-packages/suites'
import { encodePackage } from './src/plugin-packages/archive'
import { packageManifestSchema } from './src/shared/external-plugins'
import { openLibrary } from './src/core/library'
import { setBinding } from './src/core/external-plugins'
import { PLUGINS } from './src/plugins/manifest'
const dir = process.argv[2]
const pack = version => encodePackage(packageManifestSchema.parse({formatVersion:1,apiVersion:1,id:'update-probe',title:'插件更新验证',version,author:'test',description:'更新验证',entries:{core:'core.mjs',ui:'ui.mjs'}}),new Map([
 ['core.mjs',Buffer.from("export const blocks=[{id:'update-probe.note',plugin:'update-probe',title:'备注',version:1,fields:{text:{title:'正文',type:'text'}}}]; export const plugin={id:'update-probe',version:1,blocks}")],
 ['ui.mjs',Buffer.from("export const plugin={id:'update-probe'}")]
]))
const manager = new PackageManager(join(dir,'user-data'),PLUGINS.map(p=>p.id))
const old = manager.install(pack('1.0.0'))
const locked = manager.install(pack('0.8.0'))
manager.install(pack('0.7.0'))
manager.install(pack('0.9.0'))
writeFileSync(join(dir,'probe.hyplugin'),pack('1.1.0'))
new SuiteCatalog(join(dir,'user-data','plugin-suites.json')).install({hash:'a'.repeat(64),manifest:{formatVersion:1,id:'update-kit',version:'1.0.0',title:'更新套件',description:'',packages:[{id:'update-probe',version:'1.0.0',hash:old.hash,file:'probe.rmplugin'}],presets:[{id:'main',title:'更新方案',plugins:[{id:'update-probe',title:'更新验证',version:'1.0.0',hash:old.hash}]}]}})
writeFileSync(join(dir,'next.rmplugin'),pack('1.1.0'))
for (const name of ['open','closed','older']) {
 const lib = openLibrary(join(dir,name+'.library'))
 setBinding(lib,{...(name==='older' ? locked : old),enabled:name==='open'},PLUGINS)
 if (name==='open') manager.grant(lib.root,old.hash)
 manager.begin(lib.root); manager.ready(lib.root)
 lib.close()
}
writeFileSync(join(dir,'old.json'),JSON.stringify(old))
`, resolveDir: process.cwd() }, outfile: prepare, bundle: true, platform: 'node', format: 'cjs', packages: 'external' })
execFileSync(process.execPath, [prepare, dir], { stdio: 'inherit' })
const entry = resolve('out/main/plugin-update-check.cjs')
await build({ entryPoints: ['tests/electron/plugin-update-main.ts'], outfile: entry, bundle: true, platform: 'node', format: 'cjs', packages: 'external' })
for (const phase of ['first', 'resume']) {
 const env = {...process.env, RM_USER_DATA:join(dir,'user-data'), LIBRARY_PATH:join(dir,'open.library'), UPDATE_CHECK_DIR:dir, UPDATE_CHECK_PHASE:phase}
 delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL; delete env.CAPTURE_DIR
 const child = spawn(require('electron'),[entry],{env,stdio:['ignore','pipe','pipe']})
 const path = join(dir,phase+'.log'), log = createWriteStream(path)
 child.stdout.pipe(log,{end:false}); child.stderr.pipe(log,{end:false})
 const timer = setTimeout(()=>child.kill('SIGKILL'),90000)
 const [code] = await once(child,'close'); clearTimeout(timer); await new Promise(r=>log.end(r))
 assert.equal(code,0,readFileSync(path,'utf8'))
 console.log(readFileSync(join(dir,phase+'-result.json'),'utf8'))
}
console.log('真实 Electron 插件更新通过：'+dir)
