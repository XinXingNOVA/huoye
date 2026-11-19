import { packageTaskBlockers } from '../../src/plugin-packages/task-references'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, type BrowserWindow } from 'electron'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport, type StdioServerParameters } from '@modelcontextprotocol/sdk/client/stdio.js'
import { encodePackage, digest } from '../../src/plugin-packages/archive'
import { encodeSuite } from '../../src/plugin-packages/suites'
import { packageManifestSchema } from '../../src/shared/external-plugins'
import { suiteManifestSchema } from '../../src/shared/plugin-suites'
import { localPackages } from '../../src/main/plugin-packages'
import { openLibraries } from '../../src/main/libraries'
import { callCore } from '../../src/main/core-client'
import { isWindowReady } from '../../src/main/page-lifecycle'
import { SpaceVersions } from '../../src/storage/space-versions'
import { FileSpace } from '../../src/storage/file-space'
import { settingsSurface } from './settings-surface'
import type { ApplicationMcpSettings } from '../../src/plugins/mcp/settings'

export async function runApplicationManagementCapture(win: BrowserWindow, dir: string) {
  const pause = () => new Promise(r => setTimeout(r, 100))
  const until = async (check: () => unknown | Promise<unknown>, label: string) => { for (let n = 0; n < 180; n++) { if (await check()) return; await pause() } throw new Error(label) }
  const local = (method: string, input: unknown = {}) => win.webContents.executeJavaScript(`window.bridge.application.service('mcp',${JSON.stringify(method)},${JSON.stringify(input)})`)
  const click = (surface: BrowserWindow, label: string) => until(() => surface.webContents.executeJavaScript(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)});if(!b||b.disabled)return false;b.click();return true})()`), `按钮未就绪：${label}`)
  const ready = (id: string) => until(() => { const lib = openLibraries().find(l => l.id === id); return lib && isWindowReady(lib.win) && !lib.reloading }, '工作台未就绪')
  let client: Client | undefined, transport: StdioClientTransport | undefined
  try {
    await until(() => win.webContents.executeJavaScript('!!window.bridge'), '开始页未就绪')
    const resume = process.env.CAPTURE_FLOW === 'appmanagementresume'
    if (!resume) { mkdirSync(join(dir, 'libraries')); await local('settings', { enabled: true, creation: { parent: join(dir, 'libraries'), mode: 'admin' } }) }
    const config = await local('settings') as ApplicationMcpSettings
    const params = Object.values(JSON.parse(config.config).mcpServers)[0] as StdioServerParameters
    client = new Client({ name: 'management-regression', version: '1.0.0' }); transport = new StdioClientTransport({ ...params, stderr: 'pipe' }); await client.connect(transport)
    const call = async (name: string, args: Record<string, unknown> = {}): Promise<any> => { const result = await client!.callTool({ name, arguments: args }); assert(!result.isError, `${name}: ${JSON.stringify(result.content)}`); return result.structuredContent }
    const denied = async (name: string, args: Record<string, unknown>, code: string) => { const result = await client!.callTool({ name, arguments: args }); assert(result.isError && JSON.stringify(result.content).includes(code), JSON.stringify(result)) }
    if (resume) {
      const saved = JSON.parse(readFileSync(join(dir, 'appmanagement-state.json'), 'utf8'))
      assert.equal((await call('install_packages', { requestId: 'managed-install' })).state, 'completed')
      assert.equal((await call('configure_library_plugins', saved.lastInput)).state, 'completed')
      assert.equal(openLibraries().length, 0, '重放完成回执不应打开库')
      assert.equal((await call('list_allowed_file_spaces')).spaces[0].id, saved.spaceId)
      await call('open_library', { libraryId: saved.libraryId }); await ready(saved.libraryId)
      const lib = openLibraries().find(l => l.id === saved.libraryId)!
      assert(!lib.win.isVisible()); assert((await callCore(lib.core, 'plugins')).find(p => p.id === 'managed-probe')?.enabled)
      assert((await callCore(lib.core, 'listFileSpaces')).some(s => s.id === saved.spaceId && !s.default))
      const file = join(dir, 'new-after-management.txt'); writeFileSync(file, 'managed-package-native-processing')
      const imported = await call('import_to_library', { libraryId: lib.id, requestId: 'managed-new-import', files: [{ path: file }] })
      assert.equal(imported.errors.length, 0)
      await until(async () => (await callCore(lib.core, 'readItem', { id: imported.items[0].id })).fields.some(f => f.kind === 'body'), '新文本未加工')
      writeFileSync(join(dir, 'appmanagementresume-result.json'), JSON.stringify({ ok: true }))
      console.log('[capture] 管理能力重启：安装与配置回执、后台状态、空间关联和全新文本加工通过'); return
    }
    const flag = join(dir, 'managed-fail')
    const code = `import{existsSync}from'node:fs';if(existsSync(${JSON.stringify(flag)}))throw new Error('managed probe startup failed');export const blocks=[];export const plugin={id:'managed-probe',blocks};`
    const manifest = packageManifestSchema.parse({ formatVersion: 1, apiVersion: 1, id: 'managed-probe', title: '托管测试插件', description: '隔离验证', author: 'test', version: '1.0.0', entries: { core: 'core.mjs' } })
    const bytes = encodePackage(manifest, new Map([['core.mjs', Buffer.from(code)]])), hash = digest(bytes)
    const suite = suiteManifestSchema.parse({ formatVersion: 1, id: 'managed-suite', title: '托管测试套件', version: '1.0.0', description: '', packages: [{ file: 'probe.rmplugin', id: manifest.id, version: manifest.version, hash }], presets: [{ id: 'main', title: '托管组合', plugins: [{ id: 'managed-probe', title: manifest.title, hash }, { id: 'text', title: '文字' }] }] })
    const file = join(dir, 'managed.rmsuite'); writeFileSync(file, encodeSuite(suite, new Map([['probe.rmplugin', bytes]])))
    const requested = await call('request_package_installation', { requestId: 'managed-install', paths: [file] })
    assert.equal(requested.approvalRequired[0].hash, hash)
    assert((await call('install_packages', { requestId: 'managed-install' })).error.includes('PACKAGE_APPROVAL_REQUIRED'))
    assert.equal(localPackages().list().length, 0)
    await denied('approve-installation', { requestId: 'managed-install' }, 'TOOL_UNAVAILABLE')
    writeFileSync(file, 'source replaced after preview')
    await click(win, '设置'); await until(() => { try { return !!settingsSurface(win) } catch { return false } }, '设置窗口未打开')
    const settings = settingsSurface(win); await click(settings, 'AI 接入 · MCP'); await click(settings, '插件包授信')
    await click(settings, '允许安装并用于托管仓库')
    await until(() => localPackages().automationAllowed(hash), '人工许可未保存')
    await until(() => settings.webContents.executeJavaScript("document.body.textContent.includes('已许可，等待 AI 继续')"), '许可界面未更新')
    await settings.webContents.executeJavaScript("[...document.querySelectorAll('h3')].find(e=>e.textContent==='AI 使用插件的许可').scrollIntoView()")
    settings.showInactive(); writeFileSync(join(dir, 'managed-approval.png'), (await settings.webContents.capturePage()).toPNG())
    assert.equal((await call('install_packages', { requestId: 'managed-install' })).state, 'completed')
    const ui = (code: string) => settings.webContents.executeJavaScript(code)
    await click(settings, '刷新待处理请求')
    const version = '[aria-label="允许 AI 使用 managed-probe 1.0.0"]'
    assert.equal(await ui("document.querySelector('.mcp-versions').open"), false)
    assert.equal(await ui(`document.querySelector('${version}').checkVisibility()`), false)
    await ui("document.querySelector('.mcp-versions summary').click()")
    await until(() => ui(`document.querySelector('${version}').checkVisibility() && !document.querySelector('${version}').disabled`), '版本许可没有展开')
    await ui(`document.querySelector('${version}').click()`)
    await until(() => !localPackages().automationAllowed(hash), '单版本撤销未保存')
    await click(settings, '允许 AI 使用当前全部已安装版本')
    await until(() => localPackages().automationAllowed(hash), '批量授权未保存')
    const catalog = await call('list_ecosystem_catalog'), preset = catalog.entries.find((e: any) => e.kind === 'preset' && e.id === 'suite:managed-suite:main')
    const choice = { name: '托管插件库', preset: { id: preset.id, revision: preset.revision } }, preview = await call('preview_library_creation', choice)
    assert.deepEqual(preview.issues, [])
    const made = await call('create_library', { ...choice, previewRevision: preview.revision, requestId: 'managed-create' })
    assert.equal(made.state, 'completed'); await ready(made.libraryId)
    const second = await call('create_library', { name: '旁观库', requestId: 'separate-create' }); await ready(second.libraryId)
    const lib = openLibraries().find(l => l.id === made.libraryId)!, other = openLibraries().find(l => l.id === second.libraryId)!
    assert(!(await callCore(other.core, 'externalPlugins')).length)
    const text = await call('execute_operation', { libraryId: lib.id, operation: 'create_text', requestId: 'kept-text-create', args: { content: '插件停用仍保留的文字' } })
    const configure = async (plugins: { id: string }[], requestId: string) => {
      const p = await call('preview_library_plugins', { libraryId: lib.id, plugins, mode: 'replace' }); assert.deepEqual(p.issues, [])
      const input = { libraryId: lib.id, selection: p.selection, revision: p.revision, requestId }
      return { input, result: await call('configure_library_plugins', input) }
    }
    const off = await configure([], 'disable-managed')
    assert.equal(off.result.state, 'completed'); await ready(lib.id)
    assert.equal((await callCore(lib.core, 'plugins')).find(p => p.id === 'text')?.enabled, false)
    assert((await callCore(lib.core, 'readItem', { id: text.result.id })).fields.length)
    writeFileSync(flag, 'fail')
    const failed = await configure([{ id: 'text' }, { id: 'managed-probe' }], 'enable-managed')
    assert.equal(failed.result.state, 'pending'); assert(failed.result.saved && failed.result.runtimeProblems.length)
    await ready(lib.id)
    const abandoned = await configure([{ id: 'text' }, { id: 'managed-probe' }], 'cancel-adjustment')
    assert.equal(abandoned.result.state, 'pending'); await ready(lib.id)
    assert(packageTaskBlockers(app.getPath('userData'), hash, ['mcp']).some(s => s.includes('插件调整')))
    assert.equal((await call('cancel_library_configuration', { libraryId: lib.id, requestId: 'cancel-adjustment' })).state, 'cancelled')
    assert.equal((await call('configure_library_plugins', abandoned.input)).state, 'cancelled')
    rmSync(flag)
    const fixed = await call('configure_library_plugins', failed.input)
    assert.equal(fixed.state, 'completed'); assert.deepEqual(fixed.runtimeProblems, []); await ready(lib.id); assert(!lib.win.isVisible())
    assert.deepEqual(packageTaskBlockers(app.getPath('userData'), hash, ['mcp']), [], '终态回执不能锁定旧包更新')
    const conflict = await call('preview_library_plugins', { libraryId: lib.id, plugins: [], mode: 'replace' })
    await configure([{ id: 'text' }], 'manual-later-choice'); await ready(lib.id)
    await denied('configure_library_plugins', { libraryId: lib.id, selection: conflict.selection, revision: conflict.revision, requestId: 'stale-configure' }, 'PREVIEW_CHANGED')
    assert.equal((await call('configure_library_plugins', failed.input)).state, 'completed')
    assert.equal((await callCore(lib.core, 'plugins')).find(p => p.id === 'managed-probe')?.enabled, false, '完成回执不覆盖后续配置')
    const last = await configure([{ id: 'text' }, { id: 'managed-probe' }], 'final-managed'); await ready(lib.id)
    const state = await local('settings') as ApplicationMcpSettings, grant = state.libraries.find(l => l.libraryId === lib.id)!
    await local('settings', { grant: { key: grant.key, mode: 'organize' } })
    await denied('preview_library_plugins', { libraryId: lib.id, plugins: [] }, 'ADMIN_REQUIRED')
    await local('settings', { grant: { key: grant.key, mode: 'admin' } })
    const spaceRoot = join(dir, 'allowed-space'), versions = SpaceVersions.create(spaceRoot, 'shared'), spaceId = versions.space.id; versions.space.close()
    await denied('link_library_file_space', { libraryId: lib.id, spaceId }, 'SPACE_DENIED')
    await local('management', { action: 'allow-space', root: spaceRoot })
    await call('link_library_file_space', { libraryId: lib.id, spaceId }); await call('link_library_file_space', { libraryId: lib.id, spaceId })
    const linked = (await callCore(lib.core, 'listFileSpaces')).find(s => s.id === spaceId)!
    assert(!linked.default && !linked.canRevise && !linked.canRecycle)
    const space = new FileSpace(spaceRoot); assert.equal(space.info().mode, 'shared'); space.close()
    assert(!(await callCore(other.core, 'externalPlugins')).length)
    writeFileSync(join(dir, 'appmanagement-state.json'), JSON.stringify({ libraryId: lib.id, lastInput: last.input, spaceId }))
    writeFileSync(join(dir, 'appmanagement-result.json'), JSON.stringify({ ok: true }))
    console.log('[capture] 安装许可、固定套件、首次建库、停用保留、重载失败接续、旧预演拒绝、跨库隔离和空间关联通过')
  } catch (e) { console.error('[capture] appmanagement FAILED', e); process.exitCode = 1 }
  finally { await client?.close(); await transport?.close(); app.quit() }
}
