import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { PackageManager } from '../../src/plugin-packages/manager'
import { openLibrary } from '../../src/core/library'
import { setBinding } from '../../src/core/external-plugins'
import { PLUGINS } from '../../src/plugins/manifest'

const dir=resolve(process.argv[2]),root=join(dir,'事务能力.library'),userData=join(dir,'user-data')
mkdirSync(dir,{recursive:true})
const manager=new PackageManager(userData,PLUGINS.map(p=>p.id)),lib=openLibrary(root)
try {
  const catalog: {file:string;hash:string}[]=JSON.parse(readFileSync(resolve('out/main/plugins/catalog.json'),'utf8'))
  for(const entry of catalog) {
    const ref=manager.install(readFileSync(resolve('out/main/plugins',entry.file)))
    if(ref.hash!==entry.hash)throw new Error('附带包摘要不匹配')
    manager.grant(root,ref.hash);setBinding(lib,{...ref,enabled:true},PLUGINS)
  }
  const example=manager.install(readFileSync(process.argv[3]))
  manager.grant(root,example.hash);setBinding(lib,{...example,enabled:true},PLUGINS)
} finally {lib.close()}
writeFileSync(join(dir,'自动化导入.txt'),'这是通过真实 MCP 收录的新文件，附有标签、笔记与来源。')
writeFileSync(join(dir,'第二项.txt'),'另一份独立的素材')
writeFileSync(join(dir,'prepared.json'),JSON.stringify({root,userData}))
