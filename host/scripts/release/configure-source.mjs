// 只写相对目录配置；不安装、不构建、不覆盖已有不同配置。从源码包任意位置运行。
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const host = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const mappings = JSON.parse(readFileSync(join(host, '.plugin-sources.example.json'), 'utf8'))
const planned = [[join(host, '.plugin-sources.local.json'), mappings]]
for (const [id, path] of Object.entries(mappings)) {
  const plugin = resolve(host, path)
  if (JSON.parse(readFileSync(join(plugin, 'plugin.json'), 'utf8')).id !== id) throw new Error(`插件 ID 不符：${id}`)
  planned.push([join(plugin, '.rm-dev.json'), { toolchain: relative(plugin, host).split('\\').join('/') }])
}
for (const [path, value] of planned) if (existsSync(path) && JSON.stringify(JSON.parse(readFileSync(path, 'utf8'))) !== JSON.stringify(value)) throw new Error(`保留已有不同配置，请手动核对：${path}`)
for (const [path, value] of planned) if (!existsSync(path)) writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' })
console.log(`已配置 ${Object.keys(mappings).length} 个插件的相对来源；分别在宿主与需要的插件工程运行 npm ci。`)
