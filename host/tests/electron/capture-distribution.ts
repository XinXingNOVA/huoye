// 发布目录验收：不依赖 Python、源码目录或开发服务器，只使用包内运行时与资源。
import { executeUiCommand } from './capture-command'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, dialog, type BrowserWindow } from 'electron'
import sharp from 'sharp'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport, type StdioServerParameters } from '@modelcontextprotocol/sdk/client/stdio.js'
import { invokeApplicationService } from '../../src/main/application-services'
import { callCore } from '../../src/main/core-client'
import { openLibraries, reloadLibrary } from '../../src/main/libraries'
import { showLauncher } from '../../src/main/launcher'
import { loadWorkspace } from '../../src/main/workspace-storage'
import { localPackages, selectCapturePackage } from '../../src/main/plugin-packages'
import { findProgram, programDirectories } from '../../src/platform/programs'
import { DISTRIBUTION } from '../../src/plugins/generated/distribution'
import type { ApplicationMcpSettings } from '../../src/plugins/mcp/settings'
import type { ContentChunk, ItemDetails, LibraryDescription, OperationResult, SearchPageResult } from '../../src/shared/automation'
import type { CreateLibraryReceipt } from '../../src/shared/application-access'
import type { IngestResult } from '../../src/plugin-api/operations'
import type { PackagePreview } from '../../src/shared/external-plugins'

const check = (value: unknown, label: string) => { if (!value) throw new Error(label) }
async function until(fn: () => unknown, label: string) {
  for (let i = 0; i < 200; i++) { if (await fn()) return; await new Promise(r => setTimeout(r, 100)) }
  throw new Error(label)
}
function samplePdf() {
  const stream = 'BT /F1 18 Tf 40 100 Td (packagedpdfneedle) Tj ET'
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 160] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`]
  let pdf = '%PDF-1.4\n'; const offsets = [0]
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n` })
  const xref = Buffer.byteLength(pdf)
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return pdf
}
async function verifyStarterWindows(dir: string) {
  const cases = [
    { title: '视觉素材库', count: 8, expected: 'palette', layout: 'masonry' },
    { title: '通用资料与表格库', count: 6, expected: 'fields', layout: 'table' },
    { title: '空白底座', count: 0 }
  ]
  for (const item of cases) {
    const win = showLauncher(false), js = (code: string) => win.webContents.executeJavaScript(code)
    await until(() => js("!!document.querySelector('.launcher-home-actions')"), '开始页未就绪')
    await js("document.querySelector('.launcher-home-actions button.primary').click()")
    await until(() => js("document.querySelectorAll('.launcher-starters button').length === 3"), '全新配置缺少预置方案')
    const pick = dialog.showOpenDialog
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [dir] })) as typeof pick
    try {
      await js("[...document.querySelectorAll('.launcher-create button')].find(b => b.textContent === '选择位置…').click()")
      await until(() => js(`document.querySelector('.launcher-location-path')?.textContent.includes(${JSON.stringify(dir)})`), '测试父目录选择失败')
    } finally { dialog.showOpenDialog = pick }
    await js(`(() => {
      const name = document.querySelector('#launcher-name')
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(name, ${JSON.stringify(item.title)})
      name.dispatchEvent(new Event('input', { bubbles: true }))
      ;[...document.querySelectorAll('.launcher-starters button')].find(b => b.textContent === ${JSON.stringify(item.title)}).click()
    })()`)
    await until(() => js(`document.querySelector('.launcher-starters [aria-pressed=true]')?.textContent === ${JSON.stringify(item.title)} && !!document.querySelector('.launcher-create-btn:not(:disabled)')`), '方案未通过预演：' + item.title)
    if (item.layout === 'masonry') writeFileSync(join(dir, 'starter-options.png'), (await win.webContents.capturePage()).toPNG())
    await js("document.querySelector('.launcher-create-btn').click()")
    await until(() => win.isDestroyed(), '建库未完成：' + item.title)
    const lib = openLibraries().find(l => l.root === join(dir, item.title))
    if (!lib) throw new Error('未找到新建仓库窗口：' + item.title)
    const enabled = (await callCore(lib.core, 'plugins')).filter(p => p.enabled && p.external)
    check(enabled.length === item.count && (!item.expected || enabled.some(p => p.id === item.expected)), '实际启用与方案不符：' + item.title)
    if (item.layout) {
      await until(async () => !!(await loadWorkspace(lib.id))?.presetApplication, '配套工作台未落盘：' + item.title)
      const [id] = await callCore(lib.core, 'ingest', [{ type: 'text', text: '起始方案验收样例' }])
      const selector = item.layout === 'table' ? `.table-scroller [data-entity-id="${id}"]` : '.rm-palette-families'
      await until(() => lib.win.webContents.executeJavaScript(`!!document.querySelector('${selector}')`), '配套界面未就绪：' + item.title)
    }
  }
}
export async function runDistributionCapture(launcher: BrowserWindow, dir: string) {
  const client = new Client({ name: 'packaged-smoke', version: '1.0.0' })
  const settings = (input: unknown = {}) => invokeApplicationService('mcp', 'settings', input) as Promise<ApplicationMcpSettings>
  const resume = process.env.CAPTURE_FLOW === 'distributionresume'
  const resultFile = join(dir, resume ? 'resume-result.json' : 'result.json')
  try {
    check(app.isPackaged, '此流程必须测试打包后的应用')
    check(!!process.env.RM_USER_DATA && app.getPath('userData') === process.env.RM_USER_DATA, '必须使用独立用户配置')
    await until(() => launcher.webContents.executeJavaScript(`!!document.querySelector('.launcher')`), '仓库管理界面加载失败')
    if (!resume) {
      const parent = join(dir, '中文 仓库'); mkdirSync(parent, { recursive: true })
      await settings({ enabled: true, creation: { parent, mode: 'organize' } })
    }
    const params = Object.values(JSON.parse((await settings()).config).mcpServers)[0] as StdioServerParameters
    await client.connect(new StdioClientTransport({ ...params, stderr: 'pipe' }))
    const call = async <T>(name: string, args: Record<string, unknown> = {}): Promise<T> => {
      const reply = await client.callTool({ name, arguments: args })
      check(!reply.isError, `${name}: ${JSON.stringify(reply.content)}`)
      return reply.structuredContent as T
    }
    const suiteCatalog = await call<{ entries: { id: string; source: string; issues: string[] }[] }>('list_ecosystem_catalog', { limit: 100 })
    check(['visual-library', 'reference-library'].every(id => suiteCatalog.entries.some(e => e.id === id && e.source === 'bundled' && !e.issues.length)), 'MCP 未发现就绪的随附套件')
    if (!resume) await verifyStarterWindows(realpathSync(dir))
    const request = { name: '安装包 验收', requestId: 'distribution-create' }
    if (resume) {
      const saved = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'))
      const receipt = await call<CreateLibraryReceipt>('create_library', request)
      check(receipt.replayed && receipt.libraryId === saved.libraryId, '建库回执未跨重启保留')
      await call('open_library', { libraryId: saved.libraryId })
      const text = await call<ContentChunk>('read_content', { libraryId: saved.libraryId, id: saved.textId, kind: 'text', field: 'content' })
      check(text.text === '安装包测试 packagedtextneedle', '重启后文字丢失')
      const lib = openLibraries().find(l => l.id === saved.libraryId)!
      await until(() => lib.win.webContents.executeJavaScript(`!!document.querySelector('.window-toolbar')`), '重启界面未恢复')
      if (saved.tools) {
        check((await callCore(lib.core, 'info')).assembly.plugins.some(p => p.id === 'demo-tools' && p.enabled), '重启后公共示例插件丢失')
        await until(() => lib.win.webContents.executeJavaScript(`!!document.querySelector('[data-demo-instance]')`), '重启后工具位置未恢复')
      }
      writeFileSync(resultFile, JSON.stringify({ ok: true, platform: process.platform, libraryId: saved.libraryId, checks: ['MCP 连接', '建库回执', '文字恢复', '插件恢复'] }, null, 2))
      return
    }
    check((await client.listTools()).tools.some(t => t.name === 'create_library'), '未发现应用级 MCP 工具')
    await call('list_libraries')
    const receipt = await call<CreateLibraryReceipt>('create_library', request), libraryId = receipt.libraryId
    const lib = openLibraries().find(l => l.id === libraryId)!
    await until(() => lib.win.webContents.executeJavaScript(`!!document.querySelector('.window-toolbar')`), '仓库界面加载失败')
    const assembly = (await callCore(lib.core, 'info')).assembly.plugins
    const bundled = new Set(localPackages().bundled().map(p => p.manifest.id))
    for (const p of DISTRIBUTION.filter(p => p.origin === 'bundled')) {
      check(bundled.has(p.id), `安装包缺少随附插件：${p.id}`)
      check(assembly.some(a => a.id === p.id && a.enabled) === p.defaultEnabled, `附带包默认选择不符：${p.id}`)
    }
    check((await call<LibraryDescription>('describe_library', { libraryId })).operations.some(o => o.name === 'import_files'), '文件操作未发布')
    const created = await call<OperationResult>('execute_operation', { libraryId, operation: 'create_text', requestId: 'distribution-text', args: { content: '安装包测试 packagedtextneedle' } })
    const textId = (created.result as { id: string }).id
    const input = join(dir, '新 文件'); mkdirSync(input)
    const png = join(input, '图像 一.png'), pdf = join(input, '文档 一.pdf'), wav = join(input, '声音 一.wav'), video = join(input, '视频 一.mp4')
    await sharp({ create: { width: 100, height: 60, channels: 3, background: '#49a0d0' } }).png().toFile(png)
    writeFileSync(pdf, samplePdf())
    const mediaDir = join(process.resourcesPath, 'media', `${process.platform}-${process.arch}`, 'bin')
    const ffmpeg = findProgram('ffmpeg', programDirectories([mediaDir]))
    check(ffmpeg, '缺少 ffmpeg')
    if (process.platform === 'win32') check(ffmpeg!.startsWith(mediaDir), '没有使用包内 ffmpeg')
    execFileSync(ffmpeg!, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', wav], { windowsHide: true, timeout: 20000 })
    execFileSync(ffmpeg!, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=10:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', video], { windowsHide: true, timeout: 20000 })
    const paths = [png, pdf, wav, video], hashes = paths.map(p => createHash('sha256').update(readFileSync(p)).digest('hex'))
    const imported = (await call<OperationResult>('execute_operation', { libraryId, operation: 'import_files', requestId: 'distribution-import', args: { paths } })).result as IngestResult
    check(imported.errors.length === 0 && imported.items.length === 4, '新素材收录失败')
    const ids = imported.items.map(i => i.id)
    await until(async () => {
      const views = await callCore(lib.core, 'get', ids)
      return views[0].blocks.thumb && views[1].blocks.pdftext && views[1].blocks.thumb && views[2].blocks.audio && views[3].blocks.video && views[3].blocks.thumb
    }, '新素材加工未完成（图片／PDF／音频／视频）')
    for (const view of await callCore(lib.core, 'get', ids)) {
      check(!String(view.blocks.file.data.path).includes('\\'), '新文件路径使用了系统分隔符')
      const storage = await callCore(lib.core, 'fileStorageInfo', view.id)
      check(storage.path && createHash('sha256').update(readFileSync(storage.path)).digest('hex') === hashes[ids.indexOf(view.id)], '空间原件字节变化')
    }
    check((await call<ContentChunk>('read_content', { libraryId, id: ids[1], kind: 'pdftext', field: 'content' })).text.includes('packagedpdfneedle'), 'PDF 正文读取失败')
    await call('execute_operation', { libraryId, operation: 'update_tags', requestId: 'distribution-tags', args: { ids: [textId], add: ['发布验收'] } })
    check((await call<SearchPageResult>('search_items', { libraryId, query: { text: 'packagedtextneedle', where: [{ kind: 'tags', field: 'values', op: 'eq', value: '发布验收' }] } })).items[0]?.id === textId, '正文与标签联合查询失败')
    check((await call<ItemDetails>('read_item', { libraryId, id: textId })).fields.some(f => f.kind === 'tags'), '标签未保存')
    await callCore(lib.core, 'run', 'file', 'rename', { names: { [ids[0]]: '重命名 中文' } })
    await callCore(lib.core, 'undo')
    check((await callCore(lib.core, 'get', [ids[0]]))[0].blocks.file.data.name === '图像 一.png', '改名撤销失败')
    const cmaps = await lib.win.webContents.executeJavaScript(`fetch('lib://pdfjs/standard_fonts/LiberationSans-Regular.ttf').then(r => r.ok && r.arrayBuffer()).then(b => b && b.byteLength > 100)`)
    check(cmaps, '包内 PDF 字体资源不可读')
    if (process.env.PLUGIN_PACKAGE) {
      selectCapturePackage(process.env.PLUGIN_PACKAGE)
      const preview = await lib.win.webContents.executeJavaScript('window.bridge.packages.pick()') as PackagePreview
      check(preview.items[0].manifest?.id === 'demo-tools', '应使用公共工具示例安装包验收')
      await lib.win.webContents.executeJavaScript(`window.bridge.packages.install(${JSON.stringify(preview.token)})`)
      await lib.win.webContents.executeJavaScript(`window.bridge.packages.apply(${JSON.stringify({ disabled: [], changes: [{ hash: preview.items[0].hash, enabled: true }] })})`)
      await reloadLibrary(lib)
      await until(() => lib.win.webContents.executeJavaScript(`!!document.querySelector('.window-toolbar')`), '重载界面未恢复')
      await executeUiCommand(code => lib.win.webContents.executeJavaScript(code), 'host.tool.demo-tools.draft')
      await until(() => lib.win.webContents.executeJavaScript(`!!document.querySelector('[data-demo-instance]')`), '公共工具 UI 包未加载')
      check((await callCore(lib.core, 'info')).assembly.plugins.some(p => p.id === 'demo-tools' && p.enabled), '公共示例包未启用')
    }
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ libraryId, textId, tools: !!process.env.PLUGIN_PACKAGE }))
    writeFileSync(join(dir, 'packaged.png'), (await lib.win.webContents.capturePage()).toPNG())
    writeFileSync(resultFile, JSON.stringify({ ok: true, platform: process.platform, arch: process.arch, libraryId,
      checks: ['开始页三种方案建库', 'MCP 随附套件目录', '启动与界面', '应用 MCP 建库', '文字／搜索／标签', '新图片／PDF／音视频加工', '中文路径', '改名与撤销', 'PDF 资源', ...(process.env.PLUGIN_PACKAGE ? ['公共工具包安装与启用'] : [])] }, null, 2))
  } catch (e) {
    writeFileSync(resultFile, JSON.stringify({ ok: false, error: String(e) }, null, 2)); console.error('[distribution]', e)
    process.exitCode = 1
  } finally { await client.close(); app.quit() }
}
