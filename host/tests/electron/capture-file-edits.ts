import { libraryFileUrl } from '../../src/shared/file-location'
import sharp from 'sharp'
import { strict as assert } from 'node:assert'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport, type StdioServerParameters } from '@modelcontextprotocol/sdk/client/stdio.js'
import { versionLifecycleFlow } from './capture-version-lifecycle'
import { openLibraries } from '../../src/main/libraries'
import { callCore } from '../../src/main/core-client'
import { openLibraryMcpSettings } from './settings-surface'
import { captureMcpSettings } from './capture-settings'
import type { FileEditPreview, FileEditResult } from '../../src/shared/file-edits'
import type { SpaceHistoryPage } from '../../src/shared/space-versions'
import type { SpaceMutationPreview } from '../../src/shared/file-spaces'

export async function fileEditsFlow(win: BrowserWindow, dir: string, menu: { choose(label: string): void; labels(): string[] }) {
  await versionLifecycleFlow(win, dir)
  const lib = openLibraries().find(l => l.win === win)!
  const js = async (code: string): Promise<any> => {
    try { return await win.webContents.executeJavaScript(code) }
    catch (error) {
      writeFileSync(join(dir, 'file-edits-ui-error.txt'), await win.webContents.executeJavaScript('document.body.innerText'))
      writeFileSync(join(dir, 'file-edits-ui-error.png'), (await win.webContents.capturePage()).toPNG())
      throw new Error(`${String(error)}\nScript: ${code}`)
    }
  }
  const until = async (fn: () => Promise<unknown>, label: string) => { for (let i = 0; i < 200; i++) { if (await fn()) return; await new Promise(r => setTimeout(r, 100)) }; throw new Error(label) }
  const click = (label: string, selector = 'button', surface = win) => until(() => surface.webContents.executeJavaScript(`(()=>{const e=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>e.checkVisibility()&&e.textContent.trim()===${JSON.stringify(label)});if(!e||e.disabled)return false;e.click();return true})()`), `不能点击 ${label}`)
  const shot = async (name: string, surface = win) => { await new Promise(r => setTimeout(r, 250)); writeFileSync(join(dir, name), (await surface.webContents.capturePage()).toPNG()) }
  const info = (await callCore(lib.core, 'listFileSpaces')).find(s => s.name === '协作版本空间')!
  const file = (await callCore(lib.core, 'listSpaceFiles', { spaceId: info.id })).items.find(f => f.name === '协作文档.md')!, id = file.collected!
  const settings = await captureMcpSettings(win, 'organize')
  const client = new Client({ name: 'file-edits-check', version: '1.0.0' }), transport = new StdioClientTransport(Object.values(JSON.parse(settings.config).mcpServers)[0] as StdioServerParameters)
  await client.connect(transport)
  const mcp = async (name: string, args: object = {}) => { const r = await client.callTool({ name, arguments: { libraryId: lib.id, ...args } }); assert(!r.isError, JSON.stringify(r.content)); return r.structuredContent as any }
  try {
    const candidatePath = join(dir, '仅供空间预览.png')
    await sharp({ create: { width: 80, height: 60, channels: 3, background: '#4b8dba' } }).png().toFile(candidatePath)
    const saved = await callCore(lib.core, 'importToLibrary', [{ type: 'file', path: candidatePath }], { spaceId: info.id, collect: false, requestId: randomUUID() })
    assert.equal(saved.items.length, 0)
    const candidates = await mcp('list_space_files', { spaceId: info.id, search: '仅供空间预览', collectFilter: 'uncollected', includeCounts: true })
    assert.equal(candidates.total, 1); assert(candidates.items[0].reference); assert(candidates.counts.uncollected >= 1)
    const spacesWithCounts = await mcp('list_file_spaces', { includeCounts: true })
    assert.equal(spacesWithCounts.spaces.find((s: any) => s.id === info.id).counts.uncollected, candidates.counts.uncollected)
    const url = libraryFileUrl(lib.id, candidates.items[0].reference)
    assert.equal(await js(`new Promise(resolve=>{const image=new Image();image.onload=()=>resolve(image.naturalWidth);image.onerror=()=>resolve(0);image.src=${JSON.stringify(url)}})`), 80)
    const adopted = await mcp('adopt_space_files', { spaceId: info.id, files: [{ id: candidates.items[0].id, revision: candidates.items[0].revision }], requestId: randomUUID() })
    const candidateId = adopted.result.items[0].id
    await until(async () => !!(await callCore(lib.core, 'get', [candidateId]))[0].blocks.thumb, '候选收录后没有真实加工缩略图')
    const changed = await client.callTool({ name: 'list_space_files', arguments: { libraryId: lib.id, spaceId: info.id, search: '仅供空间预览', collectFilter: 'uncollected', snapshot: candidates.snapshot } })
    assert(changed.isError, '收录之后旧列表快照仍有效')
    const grant = settings.libraries.find((g: any) => g.libraryId === lib.id)!
    const current = (await callCore(lib.core, 'listFileSpaces')).find(s => s.id === info.id)!
    const permission = await js(`window.bridge.application.service('mcp','setSpacePermission',${JSON.stringify({ key: grant.key, spaceId: info.id, permission: 'revise', enabled: true, revision: current.revision })})`)
    assert(current.revision); assert(permission.revision > current.revision)
    assert.equal((await callCore(lib.core, 'fileStorageInfo', id)).canRevise, true)
    assert((await client.listTools()).tools.some(t => t.name === 'prepare_file_edit'))
    assert.equal((await mcp('get_file_edit_capabilities', { id })).publish.allowed, false)
    const settingsWindow = await openLibraryMcpSettings(win)
    const ui = (code: string) => settingsWindow.webContents.executeJavaScript(code)
    await click('细项授权', '.mcp-grant.is-current button', settingsWindow)
    await until(() => ui(`!![...document.querySelectorAll('.mcp-space-row')].find(e=>e.textContent.includes('协作版本空间'))`), '空间授权未显示')
    for (const label of ['允许 AI 发布', '允许 AI 回收']) {
      await until(() => ui(`(()=>{const row=[...document.querySelectorAll('.mcp-space-row')].find(e=>e.textContent.includes('协作版本空间'));const e=[...row.querySelectorAll('label')].find(e=>e.textContent.includes(${JSON.stringify(label)})).querySelector('input');if(e.disabled)return false;if(!e.checked)e.click();return true})()`), 'AI 授权无法切换')
      await until(() => ui(`![...document.querySelectorAll('.mcp-space-row input')].some(e=>e.disabled)`), '授权仍在保存')
    }
    await ui(`[...document.querySelectorAll('.mcp-space-row')].find(e=>e.textContent.includes('协作版本空间')).scrollIntoView({block:'center'})`)
    await shot('mcp-space-permissions.png', settingsWindow)
    settingsWindow.setSize(960, 760); assert(await ui('document.documentElement.scrollWidth<=innerWidth'))
    await shot('mcp-space-permissions-narrow.png', settingsWindow)
    // C1 恢复成 V4 后 A 仍采用 V3；先显式接纳，再编辑。
    const update = await mcp('preview_file_update', { id })
    await mcp('accept_file_update', { id, expectedPath: update.expectedPath, contentVersion: update.current.id, revision: update.revision, requestId: randomUUID() })
    const p = await mcp('prepare_file_edit', { id, content: { type: 'text', text: '# MCP published\n\nc2-mcp-content' }, destination: { mode: 'publish' }, requestId: randomUUID() }) as FileEditPreview
    const input = { editId: p.editId, previewToken: p.previewToken, requestId: randomUUID() }
    const result = await mcp('commit_file_edit', input) as FileEditResult
    assert.equal(result.library.state, 'accepted'); assert.equal((await mcp('commit_file_edit', input)).space.contentVersion, result.space.contentVersion)
    await until(async () => String((await callCore(lib.core, 'get', [id]))[0].blocks.body?.data.content ?? '').includes('c2-mcp-content'), 'MCP 新版未加工')
    const history = await mcp('list_file_versions', { spaceId: info.id, fileId: file.id }) as SpaceHistoryPage
    assert.equal(history.versions.length, 5)
    const restore = { spaceId: info.id, fileId: file.id, contentVersion: history.versions.at(-1)!.id, revision: history.revision, requestId: randomUUID() }
    await mcp('restore_file_version', restore)
    await until(async () => (await callCore(lib.core, 'readItem', { id })).processing === 'idle', '回收前加工未结束')
    const beforeLifecycle = (await callCore(lib.core, 'get', [id]))[0].blocks.body
    const assertPreserved = async () => {
      await until(async () => (await callCore(lib.core, 'readItem', { id })).processing === 'idle', '生命周期刷新未结束')
      const item = (await callCore(lib.core, 'get', [id]))[0]
      assert.deepEqual(item.failures, {}, '空间回收不应制造加工失败')
      assert.deepEqual(item.blocks.body, beforeLifecycle, '空间可用性变化不应重写成功正文')
    }
    const target = { spaceId: info.id, action: 'recycle', files: [{ id: file.id, revision: history.revision + 1 }] }
    const preview = await mcp('preview_space_lifecycle', target) as SpaceMutationPreview
    await mcp('apply_space_lifecycle', { ...target, version: preview.version, requestId: randomUUID() })
    assert.equal((await callCore(lib.core, 'fileStorageInfo', id)).lifecycle, 'recycled')
    await assertPreserved()
    const back = { ...target, action: 'restore', files: [{ id: file.id, revision: history.revision + 2 }] }
    const check = await mcp('preview_space_lifecycle', back) as SpaceMutationPreview
    const restoreLifecycle = { ...back, version: check.version, requestId: randomUUID() }
    await mcp('apply_space_lifecycle', restoreLifecycle)
    await assertPreserved()
    assert.equal((await mcp('apply_space_lifecycle', restoreLifecycle)).replayed, true)
    await assertPreserved()
    // 实际安装的项目外示例，通过公共 API 将修改另存到新版独享空间。
    const privateSpace = await js(`window.bridge.spaces.create(${JSON.stringify(dir)},'编辑副本空间','private')`)
    await callCore(lib.core, 'linkFileSpace', privateSpace.root)
    await click('文件版本编辑示例', '.settings-plugins-nav button', settingsWindow)
    await until(() => ui(`!!document.querySelector('[data-file-editor-example] option[value="${id}"]')`), '示例插件未加载')
    await ui(`(()=>{const e=document.querySelector('[aria-label="示例编辑文件"]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(e,${JSON.stringify(id)});e.dispatchEvent(new Event('change',{bubbles:true}))})()`)
    await click('读取原件与能力', 'button', settingsWindow)
    await until(() => ui(`!!document.querySelector('[aria-label="示例原文件文字"]')`), '示例未读取原件')
    // 随库空间也已是合法版本目标；测试须显式选择外置空间，不能依赖列表首项。
    await ui(`(()=>{const e=document.querySelector('[aria-label="示例副本目标"]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(e,${JSON.stringify(privateSpace.id)});e.dispatchEvent(new Event('change',{bubbles:true}))})()`)
    await ui(`(()=>{const e=document.querySelector('[aria-label="示例原文件文字"]');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify('# plugin independent\n\nc2-plugin-content')});e.dispatchEvent(new Event('input',{bubbles:true}))})()`)
    await click('准备独立副本', 'button', settingsWindow); await until(() => ui(`!!document.querySelector('[aria-label="示例编辑确认"]')`), '示例未生成预览')
    await ui(`document.querySelector('[aria-label="示例编辑确认"]').scrollIntoView({block:'center'})`); await shot('plugin-file-edit-preview.png', settingsWindow)
    await click('确认保存文件', 'button', settingsWindow)
    await until(async () => String((await callCore(lib.core, 'get', [id]))[0].blocks.body?.data.content ?? '').includes('c2-plugin-content'), '示例副本未加工')
    assert.equal((await callCore(lib.core, 'fileStorageInfo', id)).spaceId, privateSpace.id)
    assert.equal((await callCore(lib.core, 'get', [id]))[0].blocks.note.data.text, '仓库 A 的笔记')
    // 退出逐文件分享后，通用定位和回拖识别仍由当前窗口的仓库登记提供。
    const ref = (await callCore(lib.core, 'get', [id]))[0].blocks.file.data.path
    const physical = await js(`window.bridge.files.resolve(${JSON.stringify(ref)})`)
    assert(readFileSync(physical, 'utf8').includes('c2-plugin-content'))
    assert.deepEqual(await js(`window.bridge.files.identify(${JSON.stringify([physical, join(dir, 'not-imported.txt')])})`), [id, null])
    assert.equal(await js('typeof window.bridge.files.share'), 'undefined')
    assert.equal(await js('typeof window.bridge.migration'), 'undefined')
    for (const method of ['previewFileMigration', 'fileMigrations', 'reconnectFileStorage']) await assert.rejects(callCore(lib.core, method as any, id), /未知|不存在|not a function/)
    await assert.rejects(callCore(lib.core, 'prepareFileShare' as any, [id]), /未知|不存在|not a function/)
    await click('全部', '.tabbar button, .tabbar .tab, .nav-item')
    await until(() => js(`!!document.querySelector('[data-entity-id="${id}"]')`), '回拖验证素材未显示')
    menu.choose('文件存储')
    await js(`document.querySelector('[data-entity-id="${id}"]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2}))`)
    await until(() => js(`!!document.querySelector('.export-title')`), '文件存储对话框未显示')
    assert(menu.labels().some(label => label.startsWith('文件存储')))
    assert(!menu.labels().some(label => label.includes('共享文件到其他仓库')))
    await until(() => js(`document.querySelector('.export-dialog')?.textContent.includes('编辑副本空间')`), '新版存储信息未显示')
    await shot('file-storage-after-retirement.png')
    // 实际存储窗口副本按钮统一调用版本协议；旧同步命令已退出。
    await assert.rejects(callCore(lib.core, 'run', 'file', 'replace', { id, content: 'unsafe' }), /没有命令/)
    await click('转为独立副本')
    await until(async () => (await callCore(lib.core, 'get', [id]))[0].blocks.file.data.path !== ref, '存储窗口未生成版本副本')
    const copied = (await callCore(lib.core, 'get', [id]))[0].blocks.file.data.path
    assert(String(copied).startsWith('spaces/v2/'))
    assert(readFileSync(physical, 'utf8').includes('c2-plugin-content'))
    await click('完成')
    await callCore(lib.core, 'run', 'file', 'rename', { names: { [id]: '仅显示改名' } })
    assert.equal((await callCore(lib.core, 'get', [id]))[0].blocks.file.data.path, copied)
    await callCore(lib.core, 'undo')
    assert.equal((await callCore(lib.core, 'get', [id]))[0].blocks.file.data.path, copied)
    assert.equal(existsSync(join(lib.root, 'cache', 'undo')), false)
    writeFileSync(join(dir, 'file-edits-result.json'), JSON.stringify({ ok: true, checks: ['未收录图片通过真实协议预览', 'MCP 筛选计数与快照', '收录后真实缩略图加工', '本机授权入口与 AI 授权分离', 'B/C1 真实导入与界面', 'MCP stdio 工具发现', '默认独立拒绝', 'UI 两项授权保存', 'MCP 发布、重试、加工', 'MCP 历史与回收恢复', '项目外打包插件使用公共 API 创建版本副本', '笔记保留', '宽窄窗口', '通用文件定位与回拖识别', '旧分享菜单、桥和 RPC 已退出，存储窗口保留', '旧迁移桥、RPC 与重定位退出', '同步替换命令退出', '存储窗口版本副本与显示改名撤销', '不再生成原件撤销缓存'] }, null, 2))
  } finally { await client.close(); await transport.close() }
}
