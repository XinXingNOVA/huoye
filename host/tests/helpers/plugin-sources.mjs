import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
export function pluginSource(id) {
 const file=resolve(process.env.RM_PLUGIN_SOURCES ?? '.plugin-sources.local.json')
 const sources=JSON.parse(readFileSync(file,'utf8'))
 const root=sources[id]; if(!root) throw new Error(`未配置集成插件 ${id}：${file}`)
 return resolve(file,'..',root)
}
