import '../../src/main/index'
import { app, type BrowserWindow } from 'electron'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import sharp from 'sharp'
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport, type StdioServerParameters } from '@modelcontextprotocol/sdk/client/stdio.js'
import { launcherWindow, showLauncher } from '../../src/main/launcher'
import { selectCapturePackage } from '../../src/main/plugin-packages'
import { openLibraries } from '../../src/main/libraries'
import { settingsSurface } from './settings-surface'

const dir = process.env.DEVELOPMENT_AI_DIR!, resume = process.env.DEVELOPMENT_AI_PHASE === 'resume'
const pause = () => new Promise(r => setTimeout(r, 100))
async function until(check: () => unknown | Promise<unknown>, label: string) {
  for (let n = 0; n < 500; n++) { if (await check()) return; await pause() }
  throw new Error('等待失败：' + label)
}
const click = (win: BrowserWindow, label: string) => until(() => win.webContents.executeJavaScript(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)});if(!b||b.disabled)return false;b.click();return true})()`), label)
// 用真实输入切换许可，桥接调用仅用于安装前的本地环境配置。
async function inputClick(win: BrowserWindow, label: string) {
  let point: { x: number; y: number } | undefined
  await until(async () => {
    point = await win.webContents.executeJavaScript(`(()=>{const e=document.querySelector('[aria-label=${JSON.stringify(label)}]');if(!e||e.disabled)return;e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect(),x=Math.round(r.x+r.width/2),y=Math.round(r.y+r.height/2);return e.contains(document.elementFromPoint(x,y))?{x,y}:undefined})()`)
    return !!point
  }, label)
  win.webContents.sendInputEvent({ type: 'mouseDown', ...point!, button: 'left', clickCount: 1 })
  win.webContents.sendInputEvent({ type: 'mouseUp', ...point!, button: 'left', clickCount: 1 }); await pause()
}
void app.whenReady().then(async () => {
  let client: Client | undefined, transport: StdioClientTransport | undefined
  try {
    await until(() => launcherWindow() || openLibraries().length, '启动窗口')
    const launcher = launcherWindow() ?? showLauncher(false)
    await until(() => launcher.webContents.executeJavaScript('!!window.bridge'), '启动服务')
    const local = (method: string, input: unknown = {}) => launcher.webContents.executeJavaScript(`window.bridge.application.service('mcp',${JSON.stringify(method)},${JSON.stringify(input)})`)
    if (!resume) { mkdirSync(join(dir, 'libraries')); await local('settings', { enabled: true, creation: { parent: join(dir, 'libraries'), mode: 'admin' } }) }
    const settings = await local('settings'), params = Object.values(JSON.parse(settings.config).mcpServers)[0] as StdioServerParameters
    client = new Client({ name: 'development-ai-regression', version: '1.0.0' }); transport = new StdioClientTransport({ ...params, stderr: 'pipe' }); await client.connect(transport)
    const call = async (name: string, args: Record<string, unknown> = {}): Promise<any> => {
      const result = await client!.callTool({ name, arguments: args }); assert(!result.isError, `${name}: ${JSON.stringify(result.content)}`); return result.structuredContent
    }
    const denied = async (name: string, args: Record<string, unknown>, code: string) => {
      const result = await client!.callTool({ name, arguments: args }); assert(result.isError && JSON.stringify(result.content).includes(code), JSON.stringify(result))
    }
    const ready = (libraryId: string) => until(async () => {
      const s = await call('get_library_status', { libraryId, sections: ['workbench'] }); return s.core === 'running' && s.workbench.state === 'ready'
    }, '工作台就绪')
    const status = (libraryId: string, requestId?: string) => call('get_development_status', { libraryId, ...(requestId ? { requestId } : {}) })
    const receipt = async (libraryId: string, requestId: string, expected = 'completed') => {
      let snapshot: any
      await until(async () => { snapshot = await status(libraryId, requestId); return !snapshot.request.running }, '验收回执 ' + requestId)
      assert.equal(snapshot.request.state, expected, JSON.stringify(snapshot)); return snapshot
    }
    const runProjectClient = (phase: string) => promisify(execFile)(process.execPath, [resolve('tests/electron/autonomous-plugin-client.mjs'), dir, phase], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 150000
    })
    if (resume) {
      await runProjectClient('resume')
      const saved = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'))
      await call('open_library', { libraryId: saved.libraryId }); await ready(saved.libraryId)
      assert.equal((await call('control_library', saved.closeInput)).state, 'completed')
      assert.equal((await status(saved.libraryId)).runtime.core, 'running', '重启后重放关闭回执不能关掉新窗口')
      assert((await call('read_content', { libraryId: saved.libraryId, id: saved.item, kind: 'demo-reviewmemo', field: 'text' })).text.includes('MCP 开发写入'))
      writeFileSync(join(dir, 'resume-result.json'), JSON.stringify({ persistedPermissions: true, persistedReceipt: true, noReplayClose: true, data: true })); return
    }
    const daily = (await client.listTools()).tools.map(t => t.name)
    assert(!daily.includes('control_library'))
    const made = await call('create_library', { name: '开发验收库', requestId: 'development-create' }), libraryId = made.libraryId
    await ready(libraryId)
    let lib = openLibraries().find(l => l.id === libraryId)!
    await click(launcher, '设置'); await until(() => { try { return settingsSurface(launcher) } catch { return false } }, '应用设置')
    const ui = settingsSurface(launcher); await click(ui, 'AI 接入 · MCP')
    await click(ui, '查看配置')
    const shownConfig = await ui.webContents.executeJavaScript('document.querySelector(\'[aria-label="MCP 客户端配置"]\').value')
    assert.deepEqual(JSON.parse(shownConfig).mcpServers['huoye'], params)
    await click(ui, '收起配置')
    writeFileSync(join(dir, 'client-config.json'), shownConfig, { mode: 0o600 })
    await click(ui, '自主开发与验收')
    await inputClick(ui, '允许 AI 自主开发插件')
    await until(async () => (await client!.listTools()).tools.some(t => t.name === 'create_development_project'), '自主工程入口')
    const projectTools = (await client.listTools()).tools.map(t => t.name)
    assert(!projectTools.includes('capture_workbench_window') && !projectTools.includes('control_library'))
    await denied('create_development_project', { libraryId, pluginId: 'unapproved', title: '已有库', requestId: 'existing-admin-test' }, 'PROJECT_DENIED')
    await runProjectClient('first')
    // 自主工程已完成两版验收。以下单独覆盖人工登记的示例与生命周期、截图。
    selectCapturePackage(join(dir, 'source')); await lib.win.webContents.executeJavaScript('window.bridge.packages.pickDevelopmentDirectory()')
    selectCapturePackage(process.env.DEVELOPMENT_AI_TOOLCHAIN!); await lib.win.webContents.executeJavaScript('window.bridge.packages.pickDevelopmentToolchain()')
    await inputClick(ui, '开启开发验收工具')
    await until(async () => (await client!.listTools()).tools.length === daily.length + 6, '开发工具列表')
    await denied('get_development_status', { libraryId }, 'DEVELOPMENT_DISABLED')
    await click(ui, '管理仓库授权'); await inputClick(ui, '开发验收库 的细项授权')
    await inputClick(ui, '开发验收库 的开发验收许可'); await inputClick(ui, '开发验收库 允许开发验收'); await inputClick(ui, '允许源码 demo-reviewmemo')
    await click(ui, '保存开发验收许可')
    const grant = (await local('settings')).libraries.find((l: any) => l.libraryId === libraryId)
    await until(async () => (await local('settings')).libraries.find((l: any) => l.key === grant.key).development?.enabled, '逐库授权保存')
    let snapshot = await status(libraryId), sourceId = snapshot.sources[0].sourceId
    await denied('capture_workbench_window', { libraryId, session: snapshot.session, windowId: 'main', windowRevision: 0 }, 'CAPTURE_DENIED')
    await inputClick(ui, '开发验收库 允许验收截图'); await click(ui, '保存开发验收许可')
    await until(async () => (await local('settings')).libraries.find((l: any) => l.key === grant.key).development?.capture, '截图许可保存')
    writeFileSync(join(dir, 'permissions.png'), (await ui.webContents.capturePage()).toPNG())
    ui.close()
    await denied('prepare_development_build', { libraryId, sourceIds: ['b'.repeat(64)] }, 'SOURCE_DENIED')
    await call('prepare_development_build', { libraryId, sourceIds: [sourceId] })
    await until(async () => { snapshot = await status(libraryId); return snapshot.sources[0].build?.state === 'ready' }, '源码构建')
    const selected = () => [{ sourceId, hash: snapshot.sources[0].availableHash }]
    const applyInput = { libraryId, session: snapshot.session, selection: selected(), revision: snapshot.revision, requestId: 'development-apply' }
    await call('apply_development_build', applyInput); await receipt(libraryId, applyInput.requestId); await ready(libraryId)
    snapshot = await status(libraryId)
    assert(snapshot.runtime.plugins.some((p: any) => p.id === 'demo-reviewmemo' && p.enabled), JSON.stringify(snapshot))
    const item = (await call('execute_operation', { libraryId, operation: 'create_text', requestId: 'development-text', args: { content: '生命周期保留的文字' } })).result.id
    await call('execute_operation', { libraryId, operation: 'demo_update_reviewmemo', requestId: 'development-edit', args: { id: item, text: 'MCP 开发写入' } })
    const imagePath = join(dir, 'fresh.png'); await sharp({ create: { width: 192, height: 128, channels: 3, background: 'coral' } }).png().toFile(imagePath)
    const imported = await call('import_to_library', { libraryId, files: [{ path: imagePath }], requestId: 'development-import', waitMs: 2000 })
    assert.deepEqual(imported.errors, [])
    await call('get_processing_status', { libraryId, ids: [imported.items[0].id], kinds: ['thumb'], waitMs: 10000 })
    const preview = CallToolResultSchema.parse(await client.callTool({ name: 'read_preview', arguments: { libraryId, ids: [imported.items[0].id] } })); assert(preview.content.some(c => c.type === 'image'), JSON.stringify(preview))
    await denied('capture_workbench_window', { libraryId, session: snapshot.session, windowId: 'main', windowRevision: 0 }, 'WINDOW_UNAVAILABLE')
    await call('show_library', { libraryId }); await pause()
    let context = await call('get_workbench_session', { libraryId })
    const captureInput = { libraryId, session: snapshot.session, windowId: 'main', windowRevision: context.expected.windowRevision, maxSide: 960 }
    const captured = CallToolResultSchema.parse(await client.callTool({ name: 'capture_workbench_window', arguments: captureInput }))
    assert(!captured.isError, JSON.stringify(captured))
    const image = captured.content.find(c => c.type === 'image'); assert(image?.type === 'image')
    assert(!JSON.stringify(captured.structuredContent).includes(image.data)); writeFileSync(join(dir, 'workbench.jpg'), Buffer.from(image.data, 'base64'))
    assert(Math.max((captured.structuredContent as any).image.width, (captured.structuredContent as any).image.height) <= 960)
    lib.win.hide(); lib.win.show(); await pause()
    await denied('capture_workbench_window', captureInput, 'CONTEXT_CHANGED')
    // 实际设置页通过公共 SettingsGuard 拒绝离开；重载和关闭均须保留当前会话。
    await inputClick(lib.win, '打开设置')
    await until(() => { try { return settingsSurface(lib.win) } catch { return false } }, '插件设置')
    const pluginUi = settingsSurface(lib.win)
    await until(() => pluginUi.webContents.executeJavaScript("(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.includes('复看备忘'));if(!b)return false;b.click();return true})()"), '插件设置分类')
    await inputClick(pluginUi, '模拟未保存页面')
    for (const action of ['reload', 'close']) {
      const requestId = 'blocked-' + action
      await call('control_library', { libraryId, session: snapshot.session, action, requestId })
      const blocked = await receipt(libraryId, requestId, 'failed'); assert.equal(blocked.session, snapshot.session); assert.equal(blocked.runtime.core, 'running')
    }
    await inputClick(pluginUi, '模拟未保存页面'); pluginUi.close()
    await call('control_library', { libraryId, session: snapshot.session, action: 'reload', requestId: 'development-reload' })
    await receipt(libraryId, 'development-reload'); await ready(libraryId)
    const reloaded = await status(libraryId); assert.notEqual(reloaded.session, snapshot.session)
    await call('control_library', { libraryId, session: snapshot.session, action: 'close', requestId: 'development-stale' })
    assert((await receipt(libraryId, 'development-stale', 'failed')).request.error.includes('SESSION_CHANGED'))
    snapshot = reloaded
    // 类型错误不能切换仍在运行的快照，修复后必须使用新 revision。
    const sourceUi = join(dir, 'source', 'ui.tsx'), originalUi = readFileSync(sourceUi, 'utf8'), oldHash = snapshot.sources[0].appliedHash
    writeFileSync(sourceUi, originalUi + '\nconst broken: number = "bad"\n')
    await until(async () => { snapshot = await status(libraryId); return snapshot.sources[0].build?.state === 'error' }, '失败构建')
    await call('apply_development_build', { ...applyInput, session: snapshot.session, requestId: 'development-stale-build' })
    assert((await receipt(libraryId, 'development-stale-build', 'failed')).request.error.includes('PREVIEW_CHANGED'))
    assert.equal((await status(libraryId)).sources[0].appliedHash, oldHash)
    writeFileSync(sourceUi, originalUi)
    await until(async () => { snapshot = await status(libraryId); return snapshot.sources[0].build?.state === 'ready' }, '构建恢复')
    const closeInput = { libraryId, session: snapshot.session, action: 'close', requestId: 'development-close' }
    await call('control_library', closeInput); assert.equal((await receipt(libraryId, closeInput.requestId)).runtime.core, 'closed')
    await call('open_library', { libraryId }); await ready(libraryId)
    assert.equal((await call('control_library', closeInput)).state, 'completed'); assert.equal((await status(libraryId)).runtime.core, 'running')
    assert((await call('read_content', { libraryId, id: item, kind: 'demo-reviewmemo', field: 'text' })).text.includes('MCP 开发写入'))
    await local('settings', { developmentMode: false }); assert.deepEqual((await client.listTools()).tools.map(t => t.name), projectTools)
    await denied('get_development_status', { libraryId }, 'DEVELOPMENT_DISABLED'); await local('settings', { developmentMode: true })
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ libraryId, item, closeInput }))
    writeFileSync(join(dir, 'first-result.json'), JSON.stringify({ dailyTools: daily.length, projectTools: projectTools.length, devTools: (await client.listTools()).tools.length, twoVersionProject: true, uiPermissions: true, sourceBoundary: true, buildAndApply: true, operation: true, nativeImageImport: true, capture: true, staleWindow: true, saveFailureRetained: true, reload: true, staleSession: true, failedBuildRetained: true, closeReopen: true, noReplayClose: true }))
  } catch (e) { console.error(e); process.exitCode = 1 }
  finally { await client?.close(); await transport?.close(); app.quit() }
})
