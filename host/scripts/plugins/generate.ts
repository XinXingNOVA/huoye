// 静态发现：只读声明与 TypeScript 语法树，不执行插件模块。
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
import { checkUiBoundaries } from '../checks/ui-boundaries.ts'
import { checkCoreBoundaries } from '../checks/core-boundaries.ts'
import { validatePlugins, type PluginInfo } from '../../src/shared/plugin-plan.ts'
import { bundledDescriptors, readDistribution, validateDistribution } from './distribution.ts'
import { pluginCatalogSchema } from '../../src/shared/plugin-catalog-schema.ts'

type Descriptor = PluginInfo & { entries: NonNullable<PluginInfo['entries']> }
const header = '// 自动生成：npm run plugins:generate。请修改各插件的 plugin.json / distribution.json，勿手工编辑。\n'
const entryNames = ['blocks', 'core', 'ui', 'service'] as const
const own = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const source = (file: string, text: string) => ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
const inside = (parent: string, file: string) => { const p = relative(parent, file); return !isAbsolute(p) && p !== '..' && !p.startsWith(`..${sep}`) }

function readDescriptor(file: string): Descriptor {
  const data: unknown = JSON.parse(readFileSync(file, 'utf8'))
  if (!own(data)) throw new Error(`${file}：需要对象声明`)
  const allowed = new Set(['id', 'title', 'description', 'catalog', 'order', 'requires', 'optional', 'required', 'entries', 'executables', 'scope'])
  for (const key of Object.keys(data)) if (!allowed.has(key)) throw new Error(`${file}：未知字段 ${key}`)
  if (data.catalog !== undefined) data.catalog = pluginCatalogSchema.parse(data.catalog)
  for (const key of ['id', 'title', 'description']) if (typeof data[key] !== 'string' || !data[key].trim()) throw new Error(`${file}：缺少 ${key}`)
  if (data.scope !== undefined && !['application', 'library'].includes(data.scope as string)) throw new Error(`${file}：scope 无效`)
  if (data.order !== undefined && (typeof data.order !== 'number' || !Number.isFinite(data.order))) throw new Error(`${file}：order 无效`)
  if (data.required !== undefined && typeof data.required !== 'boolean') throw new Error(`${file}：required 无效`)
  for (const key of ['requires', 'optional']) {
    if (data[key] !== undefined && (!Array.isArray(data[key]) || !data[key].every((id) => typeof id === 'string'))) throw new Error(`${file}：${key} 需要 ID 数组`)
  }
  if (!own(data.entries) || !Object.keys(data.entries).length) throw new Error(`${file}：需要至少一个入口`)
  for (const [key, entry] of Object.entries(data.entries)) {
    if (!entryNames.includes(key as typeof entryNames[number]) || typeof entry !== 'string' || !entry.startsWith('./')) throw new Error(`${file}：入口 ${key} 无效`)
    const path = resolve(dirname(file), entry)
    if (!inside(dirname(file), path) || !existsSync(path) || !statSync(path).isFile() || !inside(realpathSync(dirname(file)), realpathSync(path))) throw new Error(`${file}：入口 ${key} 不存在或越过插件目录：${entry}`)
    if (!/\.tsx?$/.test(path) || (key !== 'ui' && extname(path) !== '.ts')) throw new Error(`${file}：${key} 入口必须为 ${key === 'ui' ? '.ts / .tsx' : '.ts'}`)
    const name = key === 'blocks' ? 'blocks' : 'plugin'
    const ast = source(path, readFileSync(path, 'utf8'))
    const exported = ast.statements.some((s) => {
      if (ts.isExportDeclaration(s)) return !s.isTypeOnly && !s.moduleSpecifier && s.exportClause && ts.isNamedExports(s.exportClause) && s.exportClause.elements.some((e) => !e.isTypeOnly && e.name.text === name)
      return ts.isVariableStatement(s) && s.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) && s.declarationList.declarations.some((d) => ts.isIdentifier(d.name) && d.name.text === name)
    })
    if (!exported) throw new Error(`${file}：${entry} 缺少本地命名导出 ${name}`)
  }
  if (data.executables !== undefined) {
    if (!own(data.executables) || !data.entries.service) throw new Error(`${file}：独立入口需要 service 入口`)
    for (const [name, entry] of Object.entries(data.executables)) {
      if (!/^[a-z][a-z0-9-]*$/.test(name) || ['index', 'core'].includes(name) || typeof entry !== 'string' || !entry.startsWith('./')) throw new Error(`${file}：独立入口名称或路径无效：${name}`)
      const path = resolve(dirname(file), entry)
      if (!inside(dirname(file), path) || !existsSync(path) || !statSync(path).isFile() || extname(path) !== '.ts' || !inside(realpathSync(dirname(file)), realpathSync(path))) throw new Error(`${file}：独立入口不存在或越过插件目录：${entry}`)
    }
  }
  if (data.scope === 'application' && (data.entries.core || data.entries.blocks)) throw new Error(`${file}：应用插件不能注册仓库数据块或核心入口`)
  if (data.entries.blocks && !data.entries.core) throw new Error(`${file}：声明数据块需要 core 入口负责注册与写入`)
  return data as unknown as Descriptor
}

/** 本地运行时依赖闭包检查。第三方包仍由浏览器构建检查，不声称这是不可信代码沙箱。 */
function checkBrowserEntries(entries: string[], coreEntries: Set<string>, generated: Map<string, string>, root: string): void {
  const seen = new Set<string>()
  const forbidden = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`), 'electron', 'better-sqlite3', 'sharp', '@napi-rs/canvas'])
  const visit = (file: string, chain: string[]) => {
    if (seen.has(file)) return
    seen.add(file)
    const rel = relative(root, file).replaceAll(sep, '/')
    if (coreEntries.has(file) || /^(core|main|mcp|preload)\//.test(rel) || /^plugins\/[^/]+\/lib\//.test(rel)) throw new Error(`界面/共用入口引用核心代码：${[...chain, rel].join(' → ')}`)
    if (!/\.[cm]?[jt]sx?$/.test(file) || file.endsWith('.d.ts')) return
    const text = generated.get(file) ?? readFileSync(file, 'utf8')
    const imports: string[] = []
    const walk = (node: ts.Node) => {
      if (ts.isImportDeclaration(node)) {
        const clause = node.importClause
        if (clause?.isTypeOnly) return
        if (clause && !clause.name && clause.namedBindings && ts.isNamedImports(clause.namedBindings) && clause.namedBindings.elements.length && clause.namedBindings.elements.every((e) => e.isTypeOnly)) return
        imports.push((node.moduleSpecifier as ts.StringLiteral).text)
      } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
        if (node.isTypeOnly || (node.exportClause && ts.isNamedExports(node.exportClause) && node.exportClause.elements.length && node.exportClause.elements.every((e) => e.isTypeOnly))) return
        imports.push((node.moduleSpecifier as ts.StringLiteral).text)
      } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
        if (!node.arguments[0] || !ts.isStringLiteral(node.arguments[0])) throw new Error(`无法静态检查动态模块路径：${rel}`)
        imports.push(node.arguments[0].text)
      }
      ts.forEachChild(node, walk)
    }
    walk(source(file, text))
    for (const specifier of imports) {
      const spec = specifier.split('?')[0]
      const pkg = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]
      if (specifier.startsWith('node:') || forbidden.has(spec) || forbidden.has(pkg)) throw new Error(`界面/共用入口引用核心模块：${[...chain, rel, spec].join(' → ')}`)
      if (!spec.startsWith('.')) continue
      const base = resolve(dirname(file), spec)
      const target = [base, ...['.ts', '.tsx', '.js', '.mjs', '/index.ts', '/index.tsx'].map((ext) => base + ext)].find((p) => generated.has(p) || (existsSync(p) && statSync(p).isFile()))
      if (!target) throw new Error(`模块不存在：${rel} → ${specifier}`)
      visit(target, [...chain, rel])
    }
  }
  entries.forEach((file) => visit(file, []))
}

function discoverPlugins(project: string) {
  const dir = resolve(project, 'src/plugins')
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(resolve(dir, d.name, 'plugin.json')))
    .map((d) => ({ dir: d.name, info: readDescriptor(resolve(dir, d.name, 'plugin.json')) }))
    .sort((a, b) => (a.info.order ?? 1000) - (b.info.order ?? 1000) || (a.info.id < b.info.id ? -1 : a.info.id > b.info.id ? 1 : 0))
}

/** 构建配置在生成之后重新读取目录，首次新增入口也能在同次构建生效。 */
export function pluginExecutables(project = process.cwd()) {
  return discoverPlugins(project).flatMap(p => Object.entries(p.info.executables ?? {}).map(([name, entry]) => ({ id: p.info.id, name, source: `src/plugins/${p.dir}/${entry.slice(2)}` })))
}

/** 返回变更文件；check 模式只报告过期产物，不写磁盘。 */
export function generatePlugins(project = process.cwd(), check = false): string[] {
  const dir = resolve(project, 'src/plugins')
  const plugins = discoverPlugins(project)
  const bundled = bundledDescriptors(project)
  validatePlugins([...plugins.map(p => p.info), ...bundled.map(p => p.info)])
  // 一个插件目录只需有声明即可发现，目录名不必与 ID 相同。
  const generated = new Map<string, string>()
  const put = (name: string, text: string) => generated.set(resolve(dir, 'generated', name), header + text)
  const distribution = [...plugins.map(p => readDistribution(resolve(dir, p.dir), p.info, 'builtin')), ...bundled.map(p => readDistribution(p.dir, p.info, 'bundled'))]
  validateDistribution(distribution)
  put('distribution.ts', `import type { PluginDistribution } from '../../shared/plugin-distribution'\n\nexport const DISTRIBUTION: PluginDistribution[] = ${JSON.stringify(distribution, null, 2)}\n`)
  put('manifest.ts', `import type { PluginInfo } from '../../shared/plugin-plan'\n\nexport const PLUGINS: PluginInfo[] = ${JSON.stringify(plugins.map((p) => p.info), null, 2)}\n`)
  for (const environment of ['core', 'ui', 'service'] as const) {
    const imports: string[] = []
    const rows: string[] = []
    plugins.filter(p => p.info.scope !== 'application').forEach((p, i) => {
      const entry = p.info.entries[environment]
      if (!entry) return
      imports.push(`import { plugin as p${i} } from ${JSON.stringify(`../${p.dir}/${entry.slice(2)}`)}`)
      rows.push(`  { id: ${JSON.stringify(p.info.id)}, plugin: p${i} }`)
    })
    const type = environment === 'core' ? 'CorePlugin' : environment === 'service' ? 'ServicePlugin' : 'UiPlugin'
    const typePath = environment === 'core' ? '../../plugin-api/core/contracts' : environment === 'service' ? '../../plugin-api/service' : '../../plugin-api/ui/contracts'
    put(`${environment}.ts`, `import type { ${type} } from '${typePath}'\n${imports.join('\n')}\n\nexport const entries: { id: string; plugin: ${type} }[] = [\n${rows.join(',\n')}\n]\n`)
  }
  for (const environment of ['ui', 'service'] as const) {
    const type = environment === 'ui' ? 'ApplicationUiPlugin' : 'ApplicationServicePlugin'
    const typePath = environment === 'ui' ? '../../plugin-api/ui/application' : '../../plugin-api/service'
    const selected = plugins.filter(p => p.info.scope === 'application' && p.info.entries[environment])
    put(`application-${environment}.ts`, `import type { ${type} } from '${typePath}'\n${selected.map((p,i) => `import { plugin as p${i} } from ${JSON.stringify(`../${p.dir}/${p.info.entries[environment]!.slice(2)}`)}`).join('\n')}\nexport const entries: { id: string; plugin: ${type} }[] = [${selected.map((p,i) => `{ id: ${JSON.stringify(p.info.id)}, plugin: p${i} }`).join(', ')}]\n`)
  }
  const imports: string[] = []
  const rows: string[] = []
  plugins.forEach((p, i) => {
    const entry = p.info.entries.blocks
    if (!entry) return
    imports.push(`import { blocks as b${i} } from ${JSON.stringify(`../${p.dir}/${entry.slice(2)}`)}`)
    rows.push(`  { id: ${JSON.stringify(p.info.id)}, blocks: b${i} }`)
  })
  put('blocks.ts', `import type { BlockKind } from '../../shared/blocks'\n${imports.join('\n')}\n\nexport const entries: { id: string; blocks: BlockKind[] }[] = [\n${rows.join(',\n')}\n]\n`)
  const executables = plugins.flatMap(p => Object.entries(p.info.executables ?? {}).map(([name, entry]) => ({ id: p.info.id, name, source: `src/plugins/${p.dir}/${entry.slice(2)}` })))
  if (new Set(executables.map(e => e.name)).size !== executables.length) throw new Error('插件独立入口输出名称重复')
  put('executables.ts', `export const executables: { id: string; name: string; source: string }[] = ${JSON.stringify(executables, null, 2)}\n\n// 只用于类型检查所有独立入口，不会加载其运行时代码。\nexport type ExecutableModules = {\n${executables.map(e => `  ${JSON.stringify(e.name)}: typeof import(${JSON.stringify('../' + e.source.slice('src/plugins/'.length))})`).join('\n')}\n}\n`)
  const paths = (key: keyof Descriptor['entries']) => plugins.flatMap((p) => p.info.entries[key] ? [resolve(dir, p.dir, p.info.entries[key]!)] : [])
  checkCoreBoundaries(project, paths('core'))
  checkCoreBoundaries(project, [...paths('service'), ...executables.map(e => resolve(project, e.source))], 'service')
  checkUiBoundaries(project, paths('ui'))
  checkBrowserEntries([...paths('ui'), ...paths('blocks')], new Set([...paths('core'), ...paths('service'), ...executables.map(e => resolve(project, e.source))]), generated, resolve(project, 'src'))
  const changed = [...generated].filter(([path, data]) => !existsSync(path) || readFileSync(path, 'utf8') !== data)
  if (check && changed.length) throw new Error(`插件生成清单已过期，请运行 npm run plugins:generate：${changed.map(([p]) => relative(project, p)).join('、')}`)
  for (const [path, data] of changed) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, data)
  }
  return changed.map(([path]) => relative(project, path))
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const files = generatePlugins(process.cwd(), process.argv.includes('--check'))
    console.log(files.length ? `生成插件清单：${files.join('、')}` : '插件清单检查通过')
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
