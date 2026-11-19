import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { builtinModules, createRequire } from 'node:module'
import * as React from 'react'
import * as Jsx from 'react/jsx-runtime'
import * as ReactDom from 'react-dom'
import { build } from 'esbuild'
import ts from 'typescript'
import { z } from 'zod'
import { encodePackage, packagePath } from '../../src/plugin-packages/archive.ts'
import { coreFeaturesSchema, definitionsSchema, packageManifestSchema, uiFeaturesSchema } from '../../src/shared/external-plugins.ts'
import { checkToolFeatures } from '../../src/shared/tool-placement.ts'
import { sdkSources, uiExports } from './sdk.ts'
import { pluginCatalogSchema } from '../../src/shared/plugin-catalog-schema.ts'

const project = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const ownPath = (root: string, path: string) => { const rel = relative(root, path); return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`) }
const sourceSchema = z.object({
  id: z.string(), title: z.string(), description: z.string(), author: z.string(), version: z.string(), apiVersion: z.literal(1),
  catalog: pluginCatalogSchema.optional(),
  requires: z.array(z.string()).optional(), optional: z.array(z.string()).optional(),
  uiFeatures: uiFeaturesSchema.optional(),
  definitions: definitionsSchema.optional(),
  coreFeatures: coreFeaturesSchema.optional(),
  entries: z.object({ core: z.string().optional(), blocks: z.string().optional(), ui: z.string().optional(), service: z.string().optional() }).strict()
}).strict()

/** 构建缓存只记录成功打包实际读过的依赖；独立发布仍完整检查。 */
export async function packPlugin(directory: string, output: string, onInputs?: (files: string[]) => void): Promise<string> {
  const root = realpathSync(directory), source = sourceSchema.parse(JSON.parse(readFileSync(join(root, 'plugin.json'), 'utf8')))
  checkToolFeatures([], source.uiFeatures)
  if (source.entries.blocks && !source.entries.core) throw new Error('blocks 需要 core 入口')
  if (!source.entries.core && !source.entries.ui && !source.entries.service) throw new Error('需要 core、ui 或 service 入口')
  const entries = Object.fromEntries(Object.entries(source.entries).map(([key, path]) => {
    const file = resolve(root, path)
    if (!path.startsWith('./') || !existsSync(file) || !ownPath(root, realpathSync(file)) || !/\.tsx?$/.test(file)) throw new Error(`入口必须是自己目录内的 TS 文件：${path}`)
    return [key, file]
  }))
  const packageFile = join(root, 'package.json')
  const declared = existsSync(packageFile) ? JSON.parse(readFileSync(packageFile, 'utf8')) : undefined
  const sources = sdkSources(project)
  const paths = Object.fromEntries(Object.entries(sources).map(([key, path]) => [key, [path]]))
  Object.assign(paths, {
    react: [resolve(project, 'node_modules/@types/react/index.d.ts')],
    'react/*': [resolve(project, 'node_modules/@types/react/*')],
    'react-dom': [resolve(project, 'node_modules/@types/react-dom/index.d.ts')],
    zod: [resolve(project, 'node_modules/zod/index.d.cts')]
  })
  const program = ts.createProgram(Object.values(entries), {
    target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.ReactJSX, strict: true, skipLibCheck: true, noEmit: true, allowImportingTsExtensions: true, esModuleInterop: true, noUncheckedSideEffectImports: false,
    paths, typeRoots: [resolve(project, 'node_modules/@types')], types: ['node']
  })
  const errors = ts.getPreEmitDiagnostics(program)
  if (errors.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(errors, { getCanonicalFileName: f => f, getCurrentDirectory: () => root, getNewLine: () => '\n' }))
  const inputs = new Set(program.getSourceFiles().map(f => resolve(f.fileName)))
  // 包作者的本地源码（包括 type import）不能依赖项目私有文件。
  for (const file of program.getSourceFiles().filter(f => ownPath(root, f.fileName) && !f.fileName.includes('node_modules'))) {
    const check = (spec: string) => {
      if (declared && !spec.startsWith('.') && !spec.startsWith('node:') && !spec.startsWith('@resource-manager/plugin-api/') && !builtinModules.includes(spec)) {
        const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]
        if (!declared.dependencies?.[name] && !declared.peerDependencies?.[name] && !declared.devDependencies?.[name]) throw new Error(`插件未声明依赖：${name}`)
      }
      if (isAbsolute(spec)) throw new Error(`插件不能导入绝对路径：${spec}`)
      if (spec.startsWith('.')) {
        const base = resolve(dirname(file.fileName), spec)
        const target = [base, base + '.ts', base + '.tsx', base + '.js', join(base, 'index.ts')].find(p => existsSync(p))
        if (!ownPath(root, base) || (target && !ownPath(root, realpathSync(target)))) throw new Error(`越过插件目录：${spec}`)
      }
    }
    const visit = (node: ts.Node) => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        const spec = node.moduleSpecifier.text
        check(spec)
      }
      if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) check(node.argument.literal.text)
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
        if (!node.arguments[0] || !ts.isStringLiteral(node.arguments[0])) throw new Error('模块路径必须可静态检查')
        check(node.arguments[0].text)
      }
      if (ts.isPropertyAccessExpression(node) && ['window', 'globalThis', 'self'].includes(node.expression.getText(file)) && node.name.text === 'bridge') throw new Error('插件不能直接访问原生 bridge')
      ts.forEachChild(node, visit)
    }
    visit(file)
  }
  const files = new Map<string, Buffer>(), styles: string[] = []
  for (const side of ['core', 'ui', 'service'] as const) {
    if (!entries[side]) continue
    const modules: Record<string, string[]> = side === 'ui' ? {
      react: Object.keys(React).filter(k => k !== 'default'), 'react/jsx-runtime': Object.keys(Jsx).filter(k => k !== 'default'),
      'react-dom': Object.keys(ReactDom).filter(k => k !== 'default'),
      ...Object.fromEntries(Object.entries(uiExports).map(([name, exports]) => [`@resource-manager/plugin-api/${name}`, exports]))
    } : {}
    const contents = `export { plugin } from ${JSON.stringify(entries[side])};\n` + (side === 'core'
      ? entries.blocks ? `export { blocks } from ${JSON.stringify(entries.blocks)};` : 'export const blocks = [];'
      : '')
    const result = await build({
      stdin: { contents, resolveDir: root, sourcefile: 'package-entry.ts', loader: 'ts' },
      bundle: true, format: 'esm', platform: side === 'ui' ? 'browser' : 'node', target: 'es2022',
      jsx: 'automatic', write: false, outdir: 'dist', entryNames: side, outExtension: { '.js': '.mjs' },
      metafile: true,
      loader: { '.png': 'dataurl', '.svg': 'dataurl', '.woff2': 'dataurl', '.jpg': 'dataurl', '.webp': 'dataurl' },
      plugins: [{ name: 'rm-public-api', setup(builder) {
        builder.onResolve({ filter: /.*/ }, args => {
          const spec = args.path
          if (/^(electron|better-sqlite3|@modelcontextprotocol\/sdk)(\/|$)/.test(spec)) throw new Error(`不允许直接使用 ${spec}`)
          // Zod is part of the public schema contract. Resolve it explicitly, never search the whole host dependency tree.
          if (spec === 'zod') return { path: createRequire(import.meta.url).resolve('zod') }
          if (modules[spec]) return { path: spec, namespace: 'rm-sdk' }
          if (spec.startsWith('@resource-manager/plugin-api/')) {
            const name = spec.slice('@resource-manager/plugin-api/'.length)
            if (!sources[spec] || (side === 'ui' && name.startsWith('core/')) || (side !== 'ui' && name.startsWith('ui/'))) throw new Error(`此环境没有公共入口：${spec}`)
            return { path: sources[spec] }
          }
          if (side !== 'ui' && /^(react|react-dom)(\/|$)/.test(spec)) throw new Error('核心不能依赖 React')
          if (side === 'ui' && (spec.startsWith('node:') || builtinModules.includes(spec))) throw new Error('UI 不能引用 Node 模块')
          if (args.importer && ownPath(root, args.importer) && !args.importer.includes('node_modules') && spec.startsWith('.') && !ownPath(root, resolve(dirname(args.importer), spec))) throw new Error('依赖越过插件目录')
          return undefined
        })
        builder.onLoad({ filter: /.*/, namespace: 'rm-sdk' }, args => ({
          contents: `const m = globalThis.__rmPluginSdk[${JSON.stringify(args.path)}];\nexport default m;\n${modules[args.path].filter(k => /^[$A-Z_a-z][$\w]*$/.test(k)).map(k => `export const ${k} = m.${k};`).join('\n')}`,
          loader: 'js'
        }))
      } }]
    })
    for (const name of Object.keys(result.metafile!.inputs)) {
      const path = resolve(name)
      if (existsSync(path)) inputs.add(path) // 虚拟 SDK / stdin 没有磁盘文件，由打包器版本和 SDK 指纹覆盖。
    }
    for (const file of result.outputFiles!) {
      const name = file.path.split(/[\\/]/).pop()!
      if (!packagePath(name)) throw new Error('输出路径无效')
      files.set(name, Buffer.from(file.contents))
      if (name.endsWith('.css')) styles.push(name)
    }
    for (const out of Object.values(result.metafile!.outputs)) for (const dep of out.imports) {
      if (dep.external && !(side !== 'ui' && (dep.path.startsWith('node:') || builtinModules.includes(dep.path)))) throw new Error(`包仍依赖未打包的模块：${dep.path}`)
    }
  }
  const assets = join(root, 'assets')
  const addAssets = (dir: string) => {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, item.name)
      if (item.isSymbolicLink()) throw new Error('资源不能是符号链接')
      if (item.isDirectory()) addAssets(path)
      else if (statSync(path).isFile()) files.set(relative(root, path).split(sep).join('/'), readFileSync(path))
    }
  }
  if (existsSync(assets)) addAssets(assets)
  const manifest = packageManifestSchema.parse({ ...source, formatVersion: 1,
    entries: { ...(entries.core ? { core: 'core.mjs' } : {}), ...(entries.ui ? { ui: 'ui.mjs' } : {}), ...(entries.service ? { service: 'service.mjs' } : {}) }, styles })
  const bytes = encodePackage(manifest, files)
  mkdirSync(dirname(resolve(output)), { recursive: true }); writeFileSync(output, bytes)
  onInputs?.([...inputs].sort())
  return resolve(output)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [, , directory, output] = process.argv
  if (!directory || !output) throw new Error('用法：npm run plugin:pack -- <插件目录> <输出.hyplugin>')
  console.log(await packPlugin(directory, output))
}
