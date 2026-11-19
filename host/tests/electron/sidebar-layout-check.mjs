// 基础构建后运行；安装公共接口示例，不依赖任何业务插件工程。
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const electron = createRequire(import.meta.url)('electron')
import { build } from 'esbuild'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { cpSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
const dir = mkdtempSync(join(tmpdir(), 'rm-sidebar-layout-'))
console.log(dir)
const playback = process.argv.includes('--playback')
const palette = process.argv.includes('--palette')
const pluginInput = process.argv.includes('--plugin-input')
const presetContents = process.argv.includes('--preset-contents')
const browsing = process.argv.includes('--browsing'), presetApi = process.argv.includes('--preset-api') || presetContents
const inspector = process.argv.includes('--inspector'), tagPlugins = process.argv.includes('--tags')
const extensions = process.argv.includes('--extensions'), tableTools = process.argv.includes('--table-tools')
const packs = []
const pack = join(dir, 'tools.rmplugin')
if (extensions) {
  const sources = join(dir, 'extensions')
  cpSync(resolve('examples/extensions'), sources, { recursive: true, filter: path => !path.includes('node_modules') && !path.includes('package-lock.json') })
  for (const name of ['contributor', 'provider']) {
    const directory = join(sources, name), target = join(dir, name + '.rmplugin')
    execFileSync('npm', ['install', '--offline', '--ignore-scripts', '--legacy-peer-deps', '--no-audit', '--no-fund'], { cwd: directory, stdio: 'pipe' })
    execFileSync(process.execPath, ['scripts/plugins/pack.ts', directory, target], { stdio: 'inherit' })
    packs.push(target)
  }
} else if (browsing || tableTools || inspector || tagPlugins || pluginInput || palette || playback) {
  const sourcesFile = resolve(process.env.RM_PLUGIN_SOURCES ?? '.plugin-sources.local.json')
  const sources = JSON.parse(readFileSync(sourcesFile, 'utf8'))
  for (const id of playback ? ['music'] : palette ? ['palette'] : pluginInput ? ['tags', 'fields', 'collection'] : tagPlugins ? ['tags', 'tag-groups', 'tag-tree'] : inspector ? ['tags', 'tag-groups'] : tableTools ? ['tags', 'tag-groups', 'table', 'fields'] : ['table', 'kanban']) {
    if (!sources[id]) throw new Error('布局验证需要配置独立插件来源：' + id)
    const target = join(dir, id + '.rmplugin'); packs.push(target)
    execFileSync(process.execPath, ['scripts/plugins/pack.ts', resolve(dirname(sourcesFile), sources[id]), target], { stdio: 'inherit' })
  }
} else {
  execFileSync(process.execPath, ['scripts/plugins/pack.ts', process.argv.includes('--collection') ? 'examples/collection-surface' : 'examples/tool-views', pack], { stdio: 'inherit' })
  packs.push(pack)
}
if (tableTools) {
  const target = join(dir, 'table-probe.rmplugin')
  execFileSync(process.execPath, ['scripts/plugins/pack.ts', 'tests/fixtures/table-contribution', target], { stdio: 'inherit' })
  packs.push(target)
}
if (presetApi) {
  const presetPack = join(dir, 'presets.rmplugin')
  execFileSync(process.execPath, ['scripts/plugins/pack.ts', 'examples/workbench-presets', presetPack], { stdio: 'inherit' })
  packs.push(presetPack)
}
const helper = resolve('artifacts/checks/sidebar-layout-prepare.cjs')
mkdirSync(resolve('artifacts/checks'), { recursive: true })
await build({ stdin: { contents: `
import { readFileSync } from 'node:fs'
import { PackageManager } from './src/plugin-packages/manager'
import { openLibrary } from './src/core/library'
import { readBindings, setBinding } from './src/core/external-plugins'
import { PLUGINS } from './src/plugins/manifest'
const manager = new PackageManager(process.argv[2], PLUGINS.map(p => p.id))
const lib = openLibrary(process.argv[3])
try {
  if (['disable-tag-tree', 'enable-tag-tree', 'disable-kanban', 'enable-kanban', 'disable-demo-presets', 'enable-demo-presets', 'disable-demo-extension-provider', 'enable-demo-extension-provider'].includes(process.argv[4])) {
    const binding = readBindings(lib).find(p => p.manifest.id === process.argv[4].replace(/^(enable|disable)-/, ''))
    setBinding(lib, { ...binding, enabled: process.argv[4].startsWith('enable-') }, PLUGINS)
  } else for (const pack of process.argv.slice(4)) {
    const ref = manager.install(readFileSync(pack)); manager.grant(lib.root, ref.hash); setBinding(lib, { ...ref, enabled: true }, PLUGINS)
  }
} finally { lib.close() }
`, resolveDir: process.cwd() }, outfile: helper, bundle: true, platform: 'node', format: 'cjs', target: 'node24', external: ['better-sqlite3'] })
const userData = join(dir, 'user-data'), library = join(dir, '布局.library')
execFileSync(process.execPath, [helper, userData, library, ...packs], { stdio: 'inherit' })
const openWith = process.argv.includes('--openers')
const queryViews = process.argv.includes('--views')
const editing = process.argv.includes('--editing')
const lifecycle = process.argv.includes('--lifecycle'), instances = process.argv.includes('--instances')
for (const flow of playback ? ['playback'] : palette ? ['palette'] : pluginInput ? ['plugininput'] : presetContents ? ['workbenchpresetcontents', 'workbenchpresetcontentsresume'] : tagPlugins ? ['tagplugins', 'tagpluginsmissing', 'tagpluginsresume'] : inspector ? ['inspector'] : tableTools ? ['tabletools', 'tabletoolsresume', 'tabletoolsfaults'] : extensions ? ['uiextensions', 'uiextensionsmissing', 'uiextensionsresume'] : process.argv.includes('--context') ? ['contexttools', 'contexttoolsresume'] : presetApi ? ['workbenchpresetapi', 'workbenchpresetapimissing', 'workbenchpresetapiresume'] : process.argv.includes('--presets') ? ['workbenchpresets', 'workbenchpresetsresume'] : browsing ? ['browsinglayout', 'browsinglayoutmissing', 'browsinglayoutresume'] : process.argv.includes('--collection') ? ['collectionsurface', 'collectionsurfaceresume'] : openWith ? ['openwith', 'openwithresume'] : queryViews ? ['queryviews', 'queryviewsresume'] : editing ? ['sharedediting', 'sharededitingresume'] : instances ? ['pageinstances', 'pageinstancesresume'] : lifecycle ? ['pagelifecycle', 'pagelifecycleresume'] : process.argv.includes('--editors') ? ['editorlayout', 'editorlayoutresume'] : ['sidebarlayout', 'sidebarlayoutresume']) {
  if (flow === 'sidebarlayout') await build({ entryPoints: ['tests/electron/surface-slots-fixture.jsx'], outfile: join(dir, 'surface-slots-fixture.js'), bundle: true, platform: 'browser', format: 'iife', globalName: 'surfaceSlotCheck', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } })
  if (tagPlugins && flow !== 'tagplugins') execFileSync(process.execPath, [helper, userData, library, flow === 'tagpluginsmissing' ? 'disable-tag-tree' : 'enable-tag-tree'], { stdio: 'inherit' })
  if (extensions && flow !== 'uiextensions') execFileSync(process.execPath, [helper, userData, library, flow === 'uiextensionsmissing' ? 'disable-demo-extension-provider' : 'enable-demo-extension-provider'], { stdio: 'inherit' })
  if (presetApi && !presetContents && flow !== 'workbenchpresetapi') execFileSync(process.execPath, [helper, userData, library, flow === 'workbenchpresetapimissing' ? 'disable-demo-presets' : 'enable-demo-presets'], { stdio: 'inherit' })
  if (browsing && flow !== 'browsinglayout') execFileSync(process.execPath, [helper, userData, library, flow === 'browsinglayoutmissing' ? 'disable-kanban' : 'enable-kanban'], { stdio: 'inherit' })
  const env = { ...process.env, RM_USER_DATA: userData, LIBRARY_PATH: library, CAPTURE_DIR: dir, CAPTURE_FLOW: flow }
  delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
  const child = spawn(electron, ['.'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  const path = join(dir, flow + '.log'), log = createWriteStream(path)
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false })
  const timer = setTimeout(() => child.kill('SIGKILL'), 90000)
  const [code] = await once(child, 'close'); clearTimeout(timer); await new Promise(resolve => log.end(resolve))
  assert.equal(code, 0, readFileSync(path, 'utf8'))
  assert(existsSync(join(dir, flow + '-result.json')), readFileSync(path, 'utf8'))
}
console.log((playback ? '音视频记录与音乐接续' : palette ? '色板拆包' : pluginInput ? '内容拖入与块分面' : tagPlugins ? '独立标签插件协作' : inspector ? '详情操作、上下文名称与筛选' : tableTools ? '标签、表格与字段契约' : extensions ? '插件自定义扩展点' : process.argv.includes('--context') ? '智能工具与来源上下文' : presetApi ? '预设公共 API、预览与界面替换' : process.argv.includes('--presets') ? '工作台布局预设' : browsing ? '浏览布局与配置' : process.argv.includes('--collection') ? '公共集合与页面输入' : openWith ? '打开方式与查看副本' : queryViews ? '查询视图' : editing ? '共享编辑会话' : instances ? '页面多实例' : lifecycle ? '页面结束与阅读进度' : process.argv.includes('--editors') ? '中央标签组' : '侧栏容器') + (inspector || pluginInput || palette ? '界面验收通过：' : '操作、状态保持与重启恢复通过：') + dir)
