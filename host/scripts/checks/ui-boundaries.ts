// 检查实际插件 UI 的本地依赖闭包，包含 type import 和 re-export。
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import ts from 'typescript'

const publicModules = new Set([
  'plugin-api/local-service.ts', 'plugin-api/ingest.ts', 'plugin-api/content-selection.ts', 'plugin-api/pdf-text.ts', 'plugin-api/format.ts', 'plugin-api/ui/application.ts', 'plugin-api/core.ts', 'plugin-api/operations.ts', 'plugin-api/queries.ts', 'plugin-api/ui/contracts.ts', 'plugin-api/ui/entities.ts', 'plugin-api/ui/editing.ts', 'plugin-api/ui/file-editing.ts',
  'plugin-api/ui/collection.tsx', 'plugin-api/ui/selection.tsx', 'plugin-api/ui/data.ts', 'plugin-api/ui/media.tsx', 'plugin-api/ui/fields.tsx',
  'plugin-api/ui/locale.ts', 'plugin-api/ui/kit.tsx', 'plugin-api/ui/widgets.tsx', 'plugin-api/ui/hooks.ts', 'plugin-api/ui/navigation.ts',
  'plugin-api/ui/extensions.tsx', 'plugin-api/ui/extension-types.ts',
  'plugin-api/ui/settings.ts', 'plugin-api/ui/local-state.ts', 'plugin-api/ui/commands.ts',
  'plugin-api/ui/search.tsx', 'plugin-api/ui/layout.ts', 'plugin-api/ui/playback.ts'
])
const extensions = ['', '.ts', '.tsx', '.js', '.mjs', '/index.ts', '/index.tsx']
const typeOnly = (node: ts.ImportDeclaration | ts.ExportDeclaration) => {
  if (ts.isImportDeclaration(node)) {
    const c = node.importClause
    return !!c && (c.isTypeOnly || (!c.name && c.namedBindings && ts.isNamedImports(c.namedBindings) && c.namedBindings.elements.length > 0 && c.namedBindings.elements.every((s) => s.isTypeOnly)))
  }
  return node.isTypeOnly || (node.exportClause && ts.isNamedExports(node.exportClause) && node.exportClause.elements.length > 0 && node.exportClause.elements.every((s) => s.isTypeOnly))
}

export function checkUiBoundaries(root: string, entries: string[]): void {
  const seen = new Set<string>()
  const src = realpathSync(resolve(root, 'src'))
  const rel = (file: string) => relative(src, file).replaceAll(sep, '/')
  const visit = (file: string, chain: string[], fromApi = false) => {
    file = realpathSync(file)
    const key = `${file}:${fromApi}`
    if (seen.has(key) || !/\.[cm]?[jt]sx?$/.test(file)) return
    seen.add(key)
    const here = rel(file)
    const api = here.startsWith('plugin-api/')
    const fail = (message: string, target = ''): never => { throw new Error(`UI 边界：${message}（${[...chain, here, target].filter(Boolean).join(' → ')}）`) }
    const ast = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
    const refs: { path: string; type: boolean }[] = []
    const isWindow = (node: ts.Node | undefined) => !!node && ts.isIdentifier(node) && ['window', 'globalThis', 'self'].includes(node.text)
    const walk = (node: ts.Node) => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        refs.push({ path: node.moduleSpecifier.text, type: !!typeOnly(node) })
      } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
        refs.push({ path: node.argument.literal.text, type: true })
      } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
        if (!node.arguments[0] || !ts.isStringLiteral(node.arguments[0])) fail('模块路径必须可静态检查')
        refs.push({ path: (node.arguments[0] as ts.StringLiteral).text, type: false })
      }
      // bridge 是宿主的 Electron 通道，公共 UI 通过 UiHost 获取具体能力。
      if (ts.isPropertyAccessExpression(node) && isWindow(node.expression) && node.name.text === 'bridge') fail('不能直接访问 bridge，请使用 UiHost')
      if (ts.isElementAccessExpression(node) && isWindow(node.expression) && ts.isStringLiteral(node.argumentExpression) && node.argumentExpression.text === 'bridge') fail('不能直接访问 bridge，请使用 UiHost')
      if (ts.isBindingElement(node) && (node.propertyName ?? node.name).getText(ast) === 'bridge' && ts.isVariableDeclaration(node.parent.parent) && isWindow(node.parent.parent.initializer)) fail('不能解构 bridge，请使用 UiHost')
      ts.forEachChild(node, walk)
    }
    walk(ast)
    for (const ref of refs) {
      if (!ref.path.startsWith('.') && !ref.path.startsWith('/')) continue // 第三方包由构建检查
      const base = resolve(dirname(file), ref.path.split('?')[0])
      const found = extensions.map((ext) => base + ext).find((p) => existsSync(p) && statSync(p).isFile())
      if (!found) {
        // 运行时路径由生成器检查；类型文件不存在由 tsc 报错。
        continue
      }
      const target = realpathSync(found)
      const there = rel(target)
      if (there.startsWith('renderer/')) fail('插件不能引用宿主内部文件，请使用公共 UI API', there)
      if (there.startsWith('plugin-api/') && !api && !publicModules.has(there)) fail('不能引用公共 API 的内部注入实现', there)
      const runtimePath = (api || fromApi) && !ref.type
      if (runtimePath && there.startsWith('plugins/')) fail('公共 API 不能反向加载插件或装配清单', there)
      // 核心类型引用仍允许，核心实现的运行时混入由生成器拒绝。
      if (ref.type && /^(core|main|mcp|preload)\//.test(there)) continue
      visit(target, [...chain, here], runtimePath)
    }
  }
  entries.forEach((path) => visit(path, []))
}
