// 只读取独立插件工程；产物集中在宿主 artifacts，不改插件源码或个人配置。
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
const here = dirname(fileURLToPath(import.meta.url)), host = resolve(here,'../..')
const [input, destination] = process.argv.slice(2)
if (!input) throw Error('用法：node suites/visual-library/build.mjs <独立插件父目录> [输出目录]')
const sources = JSON.parse(readFileSync(join(here,'sources.json'),'utf8'))
const suite = JSON.parse(readFileSync(join(here,'suite.json'),'utf8'))
const output = resolve(destination ?? join(host,'artifacts/suites/visual-library'))
const git = (cwd,...args) => execFileSync('git',args,{cwd,encoding:'utf8'}).trim()
// 全部核对通过才开始打包，避免把他人正在编辑的版本混入发行组合。
for (const p of sources.plugins) {
  const root = resolve(input,p.id), manifest = JSON.parse(readFileSync(join(root,'plugin.json'),'utf8'))
  if (manifest.id!==p.id || manifest.version!==p.version || git(root,'rev-parse','HEAD')!==p.commit || git(root,'status','--porcelain')) throw Error(`${p.id} 与锁定源码不一致或工作区有修改；请核对后更新 sources.json 与套件版本`)
}
mkdirSync(join(output,'packages'),{recursive:true})
const records = []
for (const p of sources.plugins) {
  const file = join(output,'packages',p.id+'.rmplugin')
  // 已发布包按固定摘要复用，避免工作目录变化让同版本产物发生漂移。
  if (!existsSync(file) || createHash('sha256').update(readFileSync(file)).digest('hex') !== p.packageSha256)
    execFileSync(process.execPath,[join(host,'scripts/plugins/pack.ts'),resolve(input,p.id),file],{cwd:p.buildCwd==='plugin'?resolve(input,p.id):host,stdio:'inherit'})
  const sha256=createHash('sha256').update(readFileSync(file)).digest('hex')
  if(sha256!==p.packageSha256) throw Error(`${p.id}@${p.version} 与已发布包摘要不符；不要以同版本分发重构建的不同包，请检查构建环境或发布新版本`)
  records.push({...p,sha256})
}
copyFileSync(join(here,'suite.json'),join(output,'suite.json'))
copyFileSync(join(here,'README.md'),join(output,'README.md'))
const name = `visual-library-${suite.version}.rmsuite`
execFileSync(process.execPath,[join(host,'scripts/plugins/suite.mjs'),join(output,'suite.json'),join(output,name)],{cwd:host,stdio:'inherit'})
writeFileSync(join(output,'build-record.json'),JSON.stringify({suite:suite.id,version:suite.version,hostBaseline:sources.hostBaseline,hostCommit:git(host,'rev-parse','HEAD'),node:process.version,sha256:createHash('sha256').update(readFileSync(join(output,name))).digest('hex'),plugins:records},null,2)+'\n')
console.log('套件与版本记录：'+output)
