/** Collect license texts from installed, locked runtime dependencies. Uses Electron's checksum-verified installer if its runtime is missing; never reads app data. */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
const project = fileURLToPath(new URL('../..', import.meta.url))
const readJson = p => JSON.parse(readFileSync(p, 'utf8'))
const sha = b => createHash('sha256').update(b).digest('hex')
const legalName = /^(licen[cs]e|copying|copyright|notice|third.party.notices)(?:[._-]|$)/i
export function dependencyNotices(base, roots) {
  const files = new Map(), packages = new Map()
  const visit = (name, from, optional = false) => {
    const require = createRequire(join(from, 'package.json'))
    const directory = (require.resolve.paths(name) ?? []).map(p => join(p, name)).find(p => existsSync(join(p, 'package.json')))
    if (!directory) { if (optional) return; throw new Error(`缺少依赖：${name}，请先安装锁定依赖`) }
    const p = readJson(join(directory, 'package.json')), id = `${p.name}@${p.version}`
    if (packages.has(id)) return
    const prefix = `${p.name.replaceAll('/', '-').replace('@', '')}-${p.version}`
    const record = { name: p.name, version: p.version, license: p.license ?? p.licenses ?? 'see included notices', repository: p.repository, files: [] }
    packages.set(id, record)
    const add = (path, content = readFileSync(join(directory, path))) => {
      files.set(`${prefix}/${path}`, content); record.files.push(`${prefix}/${path}`)
    }
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isFile() && legalName.test(entry.name)) add(entry.name)
    }
    // Binary distributions document additional component licenses in their README.
    if (p.name.startsWith('@img/') || p.name.startsWith('@napi-rs/canvas')) {
      for (const file of ['README.md', 'versions.json']) if (existsSync(join(directory, file))) add(file)
    }
    if (p.name === 'pdfjs-dist') for (const sub of ['cmaps', 'iccs', 'standard_fonts', 'wasm']) {
      if (existsSync(join(directory, sub))) for (const file of readdirSync(join(directory, sub))) if (legalName.test(file)) add(`${sub}/${file}`)
    }
    if (p.name === 'electron') { add('dist/LICENSES.chromium.html'); return } // npm download helpers are not shipped
    if (!record.files.length) throw new Error(`依赖缺少可交付的许可文本：${id}`)
    for (const dep of Object.keys(p.dependencies ?? {})) visit(dep, directory, false)
    for (const dep of Object.keys(p.optionalDependencies ?? {})) visit(dep, directory, true)
  }
  roots.forEach(name => visit(name, base))
  return { files, packages: [...packages.values()].sort((a, b) => a.name.localeCompare(b.name)) }
}
export function prepareNotices(root = project) {
  const pkg = readJson(join(root, 'package.json'))
  // Recent Electron versions download their runtime lazily, after npm ci.
  const electron = dirname(createRequire(join(root, 'package.json')).resolve('electron/package.json'))
  if (!existsSync(join(electron, 'dist/LICENSES.chromium.html'))) {
    console.log('准备 Electron 运行文件与许可（首次可能需要下载）')
    execFileSync(process.execPath, [join(electron, 'install.js')], { stdio: 'inherit', timeout: 180_000 })
  }
  // These build-time packages contribute code/fonts to the renderer and shipped plugins.
  const renderer = ['electron', 'react', 'react-dom', 'markdown-it', 'katex', '@mdit/plugin-tex', 'fflate']
  const result = dependencyNotices(root, [...Object.keys(pkg.dependencies), ...renderer])
  for (const file of ['LICENSE', 'THIRD-PARTY-NOTICES.md', 'OPTIONAL-PLUGIN-LICENSES.txt']) {
    result.files.set(file, readFileSync(join(root, 'packaging/source-public', file)))
  }
  const extras = join(root, 'packaging/licenses')
  for (const file of readdirSync(extras)) result.files.set(`native/${file}`, readFileSync(join(extras, file)))
  const manifest = { format: 1, platform: `${process.platform}-${process.arch}`, packages: result.packages,
    files: [...result.files].map(([path, data]) => ({ path, bytes: data.length, sha256: sha(data) })) }
  const target = join(root, 'out/legal')
  rmSync(target, { recursive: true, force: true }); mkdirSync(target, { recursive: true })
  for (const [path, data] of result.files) { mkdirSync(dirname(join(target, path)), { recursive: true }); writeFileSync(join(target, path), data) }
  writeFileSync(join(target, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  console.log(`已收集 ${manifest.packages.length} 个已安装运行依赖的许可材料：${target}`)
  return manifest
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) prepareNotices()
