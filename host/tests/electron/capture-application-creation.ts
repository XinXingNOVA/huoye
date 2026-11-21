import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport, type StdioServerParameters } from '@modelcontextprotocol/sdk/client/stdio.js'
import { suiteManifestSchema } from '../../src/shared/plugin-suites'
import { decodeSuite, encodeSuite } from '../../src/plugin-packages/suites'
import { localPackages, localSuites } from '../../src/main/plugin-packages'
import { PresetCatalog } from '../../src/plugin-packages/preset-catalog'
import { encodePackage } from '../../src/plugin-packages/archive'
import { packageManifestSchema } from '../../src/shared/external-plugins'
import { openLibraries, reloadLibrary } from '../../src/main/libraries'
import { applicationCreations } from '../../src/main/library-creation'
import { auxiliaryOwner } from '../../src/main/auxiliary-windows'
import { callCore } from '../../src/main/core-client'
import { isWindowReady } from '../../src/main/page-lifecycle'
import type { CreateLibraryReceipt, ApplicationCreationPreview } from '../../src/shared/application-creation'
import type { ApplicationMcpSettings } from '../../src/plugins/mcp/settings'
import type { WorkbenchLayout } from '../../src/shared/workbench-layout'
import type { LibraryStatus } from '../../src/shared/library-status'

export async function runApplicationCreationCapture(win: BrowserWindow, dir: string) {
  const pause = () => new Promise(r => setTimeout(r, 100))
  const until = async (check: () => unknown | Promise<unknown>, label: string) => {
    for (let n = 0; n < 180; n++) { if (await check()) return; await pause() }
    throw new Error(label)
  }
  const settings = (input = {}) => win.webContents.executeJavaScript(`window.bridge.application.service('mcp','settings',${JSON.stringify(input)})`) as Promise<ApplicationMcpSettings>
  let client: Client | undefined, transport: StdioClientTransport | undefined
  const flag = join(dir, 'creation-fail'), hold = join(dir, 'creation-hold'), boots = join(dir, 'creation-boots.txt')
  const schemes = new PresetCatalog(app.getPath('userData'))
  try {
    await until(() => win.webContents.executeJavaScript('!!window.bridge'), '开始页桥未就绪')
    const resume = process.env.CAPTURE_FLOW === 'appcreationresume'
    if (!resume) { mkdirSync(join(dir, 'libraries')); await settings({ enabled: true, creation: { parent: join(dir, 'libraries'), mode: 'admin' } }) }
    const config = await settings()
    const params = Object.values(JSON.parse(config.config).mcpServers)[0] as StdioServerParameters
    client = new Client({ name: 'background-creation-check', version: '1.0.0' })
    transport = new StdioClientTransport({ ...params, stderr: 'pipe' }); await client.connect(transport)
    const call = async <T = CreateLibraryReceipt>(name: string, args: Record<string, unknown> = {}): Promise<T> => {
      const result = await client!.callTool({ name, arguments: args })
      assert(!result.isError, `${name}: ${JSON.stringify(result.content)}`)
      return result.structuredContent as T
    }
    const denied = async (name: string, args: Record<string, unknown>, code: string) => {
      const result = await client!.callTool({ name, arguments: args })
      assert(result.isError && JSON.stringify(result.content).includes(code), JSON.stringify(result))
    }
    const ready = async (requestId: string) => until(async () => (await call('get_library_creation', { requestId })).runtime?.workbench === 'ready', '工作台未就绪')
    if (resume) {
      const saved = JSON.parse(readFileSync(join(dir, 'appcreation-state.json'), 'utf8'))
      rmSync(flag, { force: true }); rmSync(hold, { force: true })
      assert.equal(openLibraries().length, 0)
      assert.equal((await call('create_library', saved.completeInput)).libraryId, saved.complete.libraryId)
      assert.equal(openLibraries().length, 0, '完成回执不得隐式重开')
      assert.equal((await call('resume_library_creation', { requestId: saved.cancelInput.requestId })).state, 'cancelled')
      for (const [input, old] of [[saved.failedInput, saved.failed], [saved.interruptedInput, saved.interrupted]]) {
        const restored = await call('resume_library_creation', { requestId: input.requestId })
        assert.equal(restored.state, 'completed'); assert.equal(restored.libraryId, old.libraryId)
        await ready(input.requestId)
        const lib = openLibraries().find(l => l.id === restored.libraryId)!
        assert.equal(await lib.win.webContents.executeJavaScript('document.documentElement.dataset.theme'), 'warm-paper')
        assert(!lib.win.isVisible() && lib.background)
        assert((await callCore(lib.core, 'plugins')).find(p => p.id === 'creation-agent-probe')?.enabled, '不能换用后来更新为空的方案')
        assert.equal((await callCore(lib.core, 'info')).disabledPlugins.includes('text'), false)
      }
      await call('open_library', { libraryId: saved.complete.libraryId })
      const lib = openLibraries().find(l => l.id === saved.complete.libraryId)!
      await until(() => lib.win.webContents.executeJavaScript("document.documentElement.dataset.theme === 'daylight'"), '重新开库丢失手动外观')
      assert(!lib.win.isVisible())
      const file = join(dir, 'fresh-after-restart.txt'); writeFileSync(file, 'background-creation-native-import')
      const result = await call<{ items: { id: string }[]; errors: unknown[] }>('import_to_library', { libraryId: lib.id, files: [{ path: file }], requestId: 'background-import' })
      assert.equal(result.errors.length, 0); assert.equal(result.items.length, 1)
      await until(async () => (await callCore(lib.core, 'readItem', { id: result.items[0].id })).fields.some(f => f.kind === 'body'), '新文件正文加工未完成')
      await call('show_library', { libraryId: lib.id }); assert(lib.win.isVisible())
      writeFileSync(join(dir, 'appcreationresume-result.json'), JSON.stringify({ ok: true }))
      console.log('[capture] 后台建库重启：固定方案、完成与取消回执、启动中断接续、新文件导入和显式显示通过')
      return
    }

    const manifest = packageManifestSchema.parse({ formatVersion: 1, apiVersion: 1, id: 'creation-agent-probe', title: '后台建库验证', description: '隔离测试', author: 'test', version: '1.0.0', entries: { core: 'core.mjs' } })
    const code = `import{existsSync,appendFileSync}from'node:fs';appendFileSync(${JSON.stringify(boots)},${JSON.stringify('boot\n')});if(existsSync(${JSON.stringify(flag)}))throw new Error('creation probe failed');if(existsSync(${JSON.stringify(hold)}))await new Promise(()=>{});export const blocks=[];export const plugin={id:'creation-agent-probe',blocks};`
    const bytes = encodePackage(manifest, new Map([['core.mjs', Buffer.from(code)]]))
    const packs = localPackages(), ref = packs.install(bytes)
    const layout: WorkbenchLayout = { version: 1, root: { type: 'split', id: 'split', direction: 'columns', ratio: 0.6, first: { type: 'group', id: 'main' }, second: { type: 'group', id: 'side' } }, primary: 'main', panels: { sidebar: true, inspector: false }, contents: {
      main: { items: [{ kind: 'page', type: 'collection', target: { presetId: 'all' } }], active: 0 }, side: { items: [{ kind: 'page', type: 'file-spaces', target: {} }], active: 0 }
    } }
    const suite = suiteManifestSchema.parse({ formatVersion: 1, id: 'creation-check', title: '建库验证', description: '', version: '1.0.0', packages: [],
      presets: [{ id: 'test', title: '后台验证方案', plugins: [{ id: ref.manifest.id, title: ref.manifest.title }, { id: 'text', title: '文字' }], layout, recommendedTheme: 'warm-paper' }] })
    localSuites().install(decodeSuite(encodeSuite(suite, new Map())))
    const preset = schemes.get('suite:creation-check:test')
    const choice = (name: string) => ({ name, preset: { id: preset.id, revision: preset.revision }, background: true })
    const untrusted = await call<ApplicationCreationPreview>('preview_library_creation', choice('未授权'))
    assert(untrusted.issues.some(e => e.includes('PACKAGE_APPROVAL_REQUIRED')))
    await denied('create_library', { ...choice('未授权'), previewRevision: untrusted.revision, requestId: 'untrusted-create' }, 'PACKAGE_APPROVAL_REQUIRED')
    assert(!existsSync(untrusted.root))
    // 测试将精确摘要登记为随附；产品 MCP 没有这个授信入口。
    packs.provisionBundled([bytes])
    const input = async (name: string, requestId: string) => { const c = choice(name), preview = await call<ApplicationCreationPreview>('preview_library_creation', c); assert.deepEqual(preview.issues, []); return { ...c, previewRevision: preview.revision, requestId } }
    const completeInput = await input('后台完成', 'complete-create')
    let unexpectedFocus = 0
    const focus = (_e: unknown, focused: BrowserWindow) => { if (focused !== win) unexpectedFocus++ }
    app.on('browser-window-focus', focus)
    const [complete, duplicate] = await Promise.all([call('create_library', completeInput), call('create_library', completeInput)])
    assert.equal(complete.state, 'completed'); assert.equal(duplicate.libraryId, complete.libraryId)
    assert.equal(readFileSync(boots, 'utf8'), 'boot\n', '首次按方案直接装配一次')
    await ready(completeInput.requestId)
    const lib = openLibraries().find(l => l.id === complete.libraryId)!
    assert.equal(await lib.win.webContents.executeJavaScript('document.documentElement.dataset.theme'), 'warm-paper')
    await lib.win.webContents.executeJavaScript("window.bridge.appearance.change('library', {action:'select', id:'daylight'})")
    assert(!lib.win.isVisible()); assert(!win.isDestroyed(), '后台创建不能关闭开始页')
    const ws: any = await lib.win.webContents.executeJavaScript(`window.bridge.loadWorkspace(${JSON.stringify(lib.id)})`)
    assert.equal(ws.editors.root.type, 'split')
    // 用本地插件设置登记缺少页面的方案。外部客户端应能区分布局被阻塞和已就绪。
    const missingPage = { ...layout, contents: { main: { items: [{ kind: 'page', type: 'missing-test-page', target: {} }], active: 0 } } }
    const pendingId = await lib.win.webContents.executeJavaScript(`(async () => {
      const presets = window.bridge.pluginPresets, current = await presets.current()
      await presets.apply(current.selection, current.revision, { title: '缺少页面', layout: ${JSON.stringify(missingPage)} })
      return (await presets.pending()).id
    })()`)
    const status = () => call<LibraryStatus>('get_library_status', { libraryId: lib.id, sections: ['workbench'] })
    assert.deepEqual((await status()).workbench, { state: 'layout-pending', visible: false })
    const blocked = await call<{ issues: string[] }>('preview_library_plugins', { libraryId: lib.id, plugins: [{ id: 'text' }] })
    assert(blocked.issues.some(issue => issue.startsWith('[LAYOUT_PENDING]')))
    await lib.win.webContents.executeJavaScript(`window.bridge.pluginPresets.cancelPending(${JSON.stringify(pendingId)})`)
    assert.deepEqual((await status()).workbench, { state: 'ready', visible: false })
    await call('open_library', { libraryId: lib.id }); assert(!lib.win.isVisible())
    await reloadLibrary(lib); await ready(completeInput.requestId); assert(!lib.win.isVisible())
    await lib.win.webContents.executeJavaScript(`window.bridge.auxiliary.prepare('content:creation-probe').then(()=>window.open('about:blank','rm-content:creation-probe')).then(()=>true)`)
    await until(() => BrowserWindow.getAllWindows().some(w => w !== lib.win && auxiliaryOwner(w) === lib.win), '附属画面未创建')
    await lib.win.webContents.executeJavaScript(`window.bridge.auxiliary.show('content:creation-probe')`)
    const auxiliary = BrowserWindow.getAllWindows().find(w => w !== lib.win && auxiliaryOwner(w) === lib.win)!
    assert(!auxiliary.isVisible()); assert.equal(unexpectedFocus, 0)
    app.off('browser-window-focus', focus)
    await call('show_library', { libraryId: lib.id }); assert(lib.win.isVisible() && auxiliary.isVisible())
    await lib.win.webContents.executeJavaScript(`window.bridge.auxiliary.close('content:creation-probe')`)

    writeFileSync(flag, 'fail')
    const failedInput = await input('启动失败', 'failed-create'), failed = await call('create_library', failedInput)
    assert.equal(failed.state, 'pending'); assert(failed.error?.includes('方案插件未能运行'))
    const cancelInput = await input('取消保留', 'cancelled-create'), cancelled = await call('create_library', cancelInput)
    assert.equal(cancelled.state, 'pending')
    assert.equal((await call('cancel_library_creation', { requestId: cancelInput.requestId })).state, 'cancelled')
    assert(existsSync(join(cancelled.root, 'library.db')))
    rmSync(flag)
    const interruptedInput = await input('启动中断', 'interrupted-create')
    writeFileSync(hold, 'hold')
    const before = readFileSync(boots, 'utf8').length
    void call('create_library', interruptedInput).catch(() => {})
    await until(() => readFileSync(boots, 'utf8').length > before, '未进入插件启动阶段')
    const interrupted = await call('get_library_creation', { requestId: interruptedInput.requestId })
    assert(interrupted.running && interrupted.state === 'pending')
    assert.equal(applicationCreations.find('mcp', interruptedInput.requestId)?.libraryId, interrupted.libraryId)
    localSuites().install(decodeSuite(encodeSuite({ ...suite, version: '1.1.0',
      presets: [{ ...suite.presets[0], plugins: [], layout: undefined, recommendedTheme: 'graphite' }] }, new Map())))
    writeFileSync(join(dir, 'appcreation-state.json'), JSON.stringify({ completeInput, complete, failedInput, failed, cancelInput, interruptedInput, interrupted }))
    writeFileSync(join(dir, 'appcreation-result.json'), JSON.stringify({ ok: true }))
    console.log('[capture] 后台建库：预检与包授权、一次装配、隐藏主窗与小窗、后台重载、固定计划、失败及取消通过；模拟插件启动中断')
    app.exit(0) // 故意绕过正常退出，验证任务与 SQLite 初始化回执的实际重启接续。
  } catch (e) { console.error('[capture] appcreation FAILED', e); process.exitCode = 1 }
  finally { await client?.close(); await transport?.close(); app.quit() }
}

/** 走主进程正常重开列表，检查显式展示的库与仍在后台的库各自恢复。 */
export async function runCreationRestoreCapture(dir: string) {
  try {
    const saved = JSON.parse(readFileSync(join(dir, 'appcreation-state.json'), 'utf8'))
    const libraries = openLibraries()
    assert.equal(libraries.length, 3)
    for (const lib of libraries) {
      for (let n = 0; n < 180 && !isWindowReady(lib.win); n++) await new Promise(r => setTimeout(r, 100))
      assert(isWindowReady(lib.win))
      const revealed = lib.id === saved.complete.libraryId
      assert.equal(lib.win.isVisible(), revealed)
      assert.equal(lib.background, !revealed)
    }
    const hidden = libraries.find(l => l.id === saved.failed.libraryId)!
    const ws: any = await hidden.win.webContents.executeJavaScript(`window.bridge.loadWorkspace(${JSON.stringify(hidden.id)})`)
    assert.equal(ws.editors.root.type, 'split')
    writeFileSync(join(dir, 'appcreationrestore-result.json'), JSON.stringify({ ok: true }))
    console.log('[capture] 正常退出重开：后台意图、显式前台窗口和方案布局保持')
  } catch (e) { console.error('[capture] appcreationrestore FAILED', e); process.exitCode = 1 }
  finally { app.quit() }
}
