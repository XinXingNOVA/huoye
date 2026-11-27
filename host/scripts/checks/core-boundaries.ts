// 后端插件的维护边界：包括类型、辅助文件和重新导出；不是不可信代码沙箱。
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import ts from 'typescript'

const extensions = ['', '.ts', '.tsx', '.js', '.mjs', '/index.ts', '/index.tsx']
const publicModules = new Set(['plugin-api/core/playback.ts', 'plugin-api/core/contracts.ts', 'plugin-api/core/process.ts', 'plugin-api/core/images.ts', 'plugin-api/core/capabilities.ts', 'plugin-api/ingest.ts', 'plugin-api/content-selection.ts', 'plugin-api/pdf-text.ts', 'plugin-api/format.ts', 'plugin-api/operations.ts', 'plugin-api/queries.ts', 'plugin-api/urls.ts'])

export function checkCoreBoundaries(root: string, entries: string[], environment: 'core' | 'service' = 'core'): void {
  const src = realpathSync(resolve(root, 'src'))
  const rel = (file: string) => relative(src, file).replaceAll(sep, '/')
  const seen = new Set<string>()
  const visit = (file: string, chain: string[], owner: string) => {
    file = realpathSync(file)
    const here = rel(file)
    const key = `${owner}:${here}`
    if (seen.has(key) || !/\.[cm]?[jt]sx?$/.test(file)) return
    seen.add(key)
    const fail = (message: string, target = ''): never => { throw new Error(`后端边界：${message}（${[...chain, here, target].filter(Boolean).join(' → ')}）`) }
    const ast = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
    const refs: string[] = []
    const walk = (node: ts.Node) => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) refs.push(node.moduleSpecifier.text)
      else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) refs.push(node.argument.literal.text)
      else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && node.moduleReference.expression && ts.isStringLiteral(node.moduleReference.expression)) refs.push(node.moduleReference.expression.text)
      else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
        if (!node.arguments[0] || !ts.isStringLiteral(node.arguments[0])) fail('模块路径必须可静态检查')
        refs.push((node.arguments[0] as ts.StringLiteral).text)
      }
      ts.forEachChild(node, walk)
    }
    walk(ast)
    for (const path of refs) {
      const spec = path.split('?')[0]
      if (!spec.startsWith('.') && !spec.startsWith('/')) {
        if (/^(electron|better-sqlite3|react|react-dom)(\/|$)/.test(spec) || (environment === 'core' && /^@modelcontextprotocol\/sdk(\/|$)/.test(spec))) fail('不能直接依赖宿主数据库、界面或接入协议', spec)
        continue // 后端允许 Node 和解码库；第三方依赖的内部实现不属于此检查范围。
      }
      const base = resolve(dirname(file), spec)
      const found = extensions.map(ext => base + ext).find(p => existsSync(p) && statSync(p).isFile())
      if (!found) continue // 缺失模块由类型检查处理，也允许生成器的最小目录夹具。
      const target = realpathSync(found), there = rel(target)
      if (/^(core|main|mcp|preload|renderer)\//.test(there)) fail('不能引用宿主内部文件，请使用公共后端 API', there)
      if (there.startsWith('plugin-api/') && !(environment === 'core' ? publicModules.has(there) : ['plugin-api/local-service.ts', 'plugin-api/service.ts', 'plugin-api/operations.ts', 'plugin-api/ingest.ts'].includes(there))) fail('不能引用界面或公共 API 内部实现', there)
      if (there.startsWith('plugins/')) {
        if (!here.startsWith('plugins/')) fail('公共契约和共享模块不能反向引用插件或装配', there)
        const parts = there.split('/')
        if (parts[1] !== here.split('/')[1] && !/^plugins\/[^/]+\/(blocks|extension)\.ts$/.test(there)) fail('跨插件只能引用公开的 blocks / extension 契约', there)
      }
      if (!/^(shared|plugin-api|plugins)\//.test(there)) fail('依赖必须位于插件、共享契约或公共 API', there)
      visit(target, [...chain, here], owner)
    }
  }
  entries.forEach(file => visit(file, [], rel(file).split('/')[1]))
}
