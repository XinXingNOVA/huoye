import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { z } from 'zod'
import { decodePackage, digest } from '../../src/plugin-packages/archive'
import { encodeSuite } from '../../src/plugin-packages/suites'
import { decodeTheme } from '../../src/plugin-packages/theme-archive'
import { MAX_THEME_BYTES } from '../../src/shared/theme-package'
import { suiteManifestSchema, recommendedTheme } from '../../src/shared/plugin-suites'
const sourceSchema = z.object(suiteManifestSchema.shape).omit({ packages: true, presets: true, themes: true }).extend({
  themes: z.array(z.string().min(1)).max(8).optional(),
  packages: z.array(z.string().min(1)).max(50),
  presets: z.array(z.object({ id: z.string(), title: z.string(), description: z.string().optional(), plugins: z.array(z.string()).max(1000), layout: z.unknown().optional(), recommendedTheme: recommendedTheme.optional() }).strict()).min(1).max(30)
})
export function packSuite(source: string, output: string) {
  if (statSync(source).size > 1024 * 1024) throw new Error('套件清单超过 1 MB')
  const config = sourceSchema.parse(JSON.parse(readFileSync(source, 'utf8')))
  const files = new Map<string, Buffer>()
  const packages = config.packages.map(path => {
    const full = resolve(dirname(source), path)
    if (statSync(full).size > 16 * 1024 * 1024) throw new Error(`插件包超过 16 MB：${path}`)
    const bytes = readFileSync(full), { manifest } = decodePackage(bytes), file = `${manifest.id}.hyplugin`
    if (files.has(file)) throw new Error(`同一套件只携带一个 ${manifest.id} 版本`)
    files.set(file, bytes)
    return { file, id: manifest.id, version: manifest.version, hash: digest(bytes), title: manifest.title }
  })
  const themeFiles = new Map<string, Buffer>()
  const themes = config.themes?.map(path => {
    const full = resolve(dirname(source), path)
    if (statSync(full).size > MAX_THEME_BYTES) throw new Error('主题包超过 8 MiB：' + path)
    const bytes = readFileSync(full)
    const { id } = decodeTheme(bytes).manifest
    const file = id + '.hytheme'
    themeFiles.set(file, bytes)
    return { file, id, hash: digest(bytes) }
  })
  const manifest = suiteManifestSchema.parse({ ...config, themes,
    packages: packages.map(({ title: _, ...p }) => p),
    presets: config.presets.map(p => ({ ...p, plugins: p.plugins.map(id => {
      const pack = packages.find(p => p.id === id)
      return pack ? { id, title: pack.title, version: pack.version, hash: pack.hash } : { id, title: id }
    }) }))
  })
  const bytes = encodeSuite(manifest, files, themeFiles)
  mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, bytes)
  return { bytes: bytes.length, packages: packages.length, presets: manifest.presets.map(p => p.title) }
}
if (require.main === module) {
  const [source, output] = process.argv.slice(2)
  if (!source || !output || !(/\.(hysuite|rmsuite)$/i.test(output))) throw new Error('用法：npm run suite:pack -- suite.json output.hysuite')
  const result = packSuite(resolve(source), resolve(output))
  console.log(`已打包 ${result.packages} 个插件、${result.presets.length} 个方案（${result.bytes} 字节）：${resolve(output)}`)
}
