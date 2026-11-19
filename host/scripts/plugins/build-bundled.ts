// 随应用交付的包仍走公共打包器；宿主编译结果不静态导入这些插件的业务代码。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve, join, dirname } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { packPlugin } from './pack.ts'
import { decodePackage } from '../../src/plugin-packages/archive.ts'
import { PluginBuildCache } from './build-cache.ts'
import { bundledDescriptors } from './distribution.ts'

export async function buildPluginPackages(output: string, project = resolve(dirname(fileURLToPath(import.meta.url)), '../..'), options: { cacheDirectory?: string } = {}) {
  const start = performance.now(), cache = options.cacheDirectory ? new PluginBuildCache(options.cacheDirectory) : undefined
  let reused = 0
  mkdirSync(output, { recursive: true })
  const catalog: { file: string; hash: string }[] = []
  const ids = new Set<string>()
  for (const { dir } of bundledDescriptors(project)) {
    const name = JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf8')).id as string
    const sourceFile = resolve(process.env.RM_PLUGIN_SOURCES ?? join(project, '.plugin-sources.local.json'))
    const sources = JSON.parse(readFileSync(sourceFile, 'utf8')) as Record<string, string>
    if (typeof sources[name] !== 'string') throw new Error(`未配置插件源码：${name}（${sourceFile}）`)
    const source = resolve(dirname(sourceFile), sources[name])
    if (JSON.parse(readFileSync(join(source, 'plugin.json'), 'utf8')).id !== name) throw new Error(`插件来源身份不符：${name}`)
    // 包名从受限插件 ID 产生；manifest 的完整检查由公共打包器完成。
    if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error('分发目录名称无效')
    const file = `${name}.hyplugin`
    if (cache) { if (await cache.pack(source, join(output, file)) === 'cached') reused++ }
    else await packPlugin(source, join(output, file))
    const pack = decodePackage(readFileSync(join(output, file)))
    if (ids.has(pack.manifest.id)) throw new Error(`分发包 ID 重复：${pack.manifest.id}`)
    ids.add(pack.manifest.id); catalog.push({ file, hash: pack.hash })
  }
  writeFileSync(join(output, 'catalog.json'), JSON.stringify(catalog, null, 2) + '\n')
  if (cache) console.log(`插件包：复用 ${reused}，重建 ${catalog.length - reused}（${Math.round(performance.now() - start)} ms）`)
  return catalog
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const output = resolve(process.argv[2] ?? 'artifacts/plugins')
  const catalog = await buildPluginPackages(output)
  console.log(`已打包 ${catalog.length} 个插件：${output}`)
}
