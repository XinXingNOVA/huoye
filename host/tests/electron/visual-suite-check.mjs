// 实际交付套件的端到端验收；不重新打包测试替身，也不访问日常仓库。
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createWriteStream, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'
const require = createRequire(import.meta.url)
const suite = resolve(process.argv[2] ?? 'packaging/starters/visual-library.hysuite')
const dir = mkdtempSync(join(tmpdir(),'rm-visual-suite-'))
console.log(dir)
const entry = resolve('out/main/visual-suite-check.cjs')
await build({entryPoints:['tests/electron/visual-suite-main.ts'],outfile:entry,bundle:true,platform:'node',format:'cjs',packages:'external'})
// 复用既有正式包，并模拟色板同版本的不同构建；套件不能覆盖它。
const fixtureModule=join(dir,'package-fixture.cjs')
await build({stdin:{contents:"export {PackageManager} from './src/plugin-packages/manager'; export {decodePackage,encodePackage} from './src/plugin-packages/archive'; export {decodeSuite,encodeSuite,SuiteCatalog} from './src/plugin-packages/suites'",resolveDir:process.cwd()},outfile:fixtureModule,bundle:true,platform:'node',format:'cjs'})
const {PackageManager,decodePackage,encodePackage,decodeSuite,encodeSuite,SuiteCatalog}=require(fixtureModule), manager=new PackageManager(join(dir,'user-data'),[])
// 用户已从本机移除随附套件，此流程验证手动安装和同版本替代构建。
const priorSuites = new SuiteCatalog(join(dir, 'user-data', 'plugin-suites.json'))
priorSuites.provisionBundled(JSON.parse(readFileSync('out/main/plugins/suites.json', 'utf8')))
for (const entry of priorSuites.list()) priorSuites.remove(entry.manifest.id, entry.hash)
const update = decodeSuite(readFileSync(suite))
const packageBytes = id => update.packages.get(update.manifest.packages.find(p => p.id === id).file)
const lock=JSON.parse(readFileSync('suites/visual-library/sources.json','utf8'))
for(const id of ['tag-groups','image-filter']) {
 const ref=manager.install(packageBytes(id))
 assert.equal(ref.hash,lock.plugins.find(p=>p.id===id).packageSha256)
}

const color=decodePackage(packageBytes('palette'))
color.files.set('ui.mjs',Buffer.concat([color.files.get('ui.mjs'),Buffer.from('\n// independently published build\n')]))
const local=manager.install(encodePackage(color.manifest,color.files))
writeFileSync(join(dir,'local-palette.json'),JSON.stringify(local))
update.manifest.version=update.manifest.version.split('.').map((v,i)=>String(Number(v)+(i===2?1:0))).join('.')
update.manifest.presets[0].layout.panels.inspector=false
writeFileSync(join(dir,'next.rmsuite'),encodeSuite(update.manifest,update.packages))
for (const phase of ['first','resume']) {
 const env = {...process.env,RM_USER_DATA:join(dir,'user-data'),VISUAL_SUITE_DIR:dir,VISUAL_SUITE_FILE:suite,VISUAL_SUITE_PHASE:phase}
 delete env.LIBRARY_PATH;delete env.CAPTURE_DIR;delete env.ELECTRON_RUN_AS_NODE;delete env.ELECTRON_RENDERER_URL
 const child = spawn(require('electron'),[entry],{env,stdio:['ignore','pipe','pipe']})
 const path=join(dir,phase+'.log'),log=createWriteStream(path)
 child.stdout.pipe(log,{end:false});child.stderr.pipe(log,{end:false})
 const timer=setTimeout(()=>child.kill('SIGKILL'),150000)
 const [code]=await once(child,'close');clearTimeout(timer);await new Promise(r=>log.end(r))
 assert.equal(code,0,readFileSync(path,'utf8'))
 console.log(readFileSync(join(dir,phase+'-result.json'),'utf8'))
}
console.log('视觉素材库套件验收通过：'+dir)
