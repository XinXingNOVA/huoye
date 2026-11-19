import '../../src/main/index'
import { app, type BrowserWindow } from 'electron'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport, type StdioServerParameters } from '@modelcontextprotocol/sdk/client/stdio.js'
import { launcherWindow, showLauncher } from '../../src/main/launcher'
import { localPackages, localSuites, packagesChanged } from '../../src/main/plugin-packages'
import { openLibraries } from '../../src/main/libraries'
import { callCore } from '../../src/main/core-client'
import { decodeSuite } from '../../src/plugin-packages/suites'
import { decodePackage, encodePackage } from '../../src/plugin-packages/archive'
import { settingsSurface } from './settings-surface'
import { loadWorkspace } from '../../src/main/workspace-storage'
import { checkInventory } from './inventory-flow'
import { checkReview } from './batch-review-flow'
import { checkWorkbenchSession } from './workbench-session-flow'
import { prepareGenericReview, resumeGenericReview } from './generic-review-flow'
const dir = process.env.VISUAL_AI_DIR!, phase = process.env.VISUAL_AI_PHASE
const resume = phase === 'resume' || phase === 'review-resume'
const pause = () => new Promise(r => setTimeout(r, 100))
async function until(check: () => unknown | Promise<unknown>, label: string) {
  for (let n = 0; n < 400; n++) { if (await check()) return; await pause() }
  throw new Error('等待失败：' + label)
}
const click = (win: BrowserWindow, label: string) => until(() => win.webContents.executeJavaScript(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)});if(!b||b.disabled)return false;b.click();return true})()`), label)

void app.whenReady().then(async () => {
  let client: Client | undefined, transport: StdioClientTransport | undefined
  try {
    await until(() => launcherWindow() || openLibraries().length, '启动窗口')
    const launcher = launcherWindow() ?? showLauncher(false)
    await until(() => launcher.webContents.executeJavaScript('!!window.bridge'), '启动服务')
    const local = (method: string, input: unknown = {}) => launcher.webContents.executeJavaScript(`window.bridge.application.service('mcp',${JSON.stringify(method)},${JSON.stringify(input)})`)
    if (!resume) { mkdirSync(join(dir, 'libraries')); await local('settings', { enabled: true, creation: { parent: join(dir, 'libraries'), mode: 'admin' } }) }
    const settings = await local('settings')
    const params = Object.values(JSON.parse(settings.config).mcpServers)[0] as StdioServerParameters
    client = new Client({ name: 'visual-ai-regression', version: '1.0.0' }); transport = new StdioClientTransport({ ...params, stderr: 'pipe' }); await client.connect(transport)
    const call = async (name: string, args: Record<string, unknown> = {}): Promise<any> => { const result = await client!.callTool({ name, arguments: args }); assert(!result.isError, `${name}: ${JSON.stringify(result.content)}`); return result.structuredContent }
    const ready = (libraryId: string) => until(async () => {
      const status = await call('get_library_status', { libraryId, sections: ['workbench'] })
      return status.core === 'running' && status.workbench.state === 'ready'
    }, 'MCP 确认仓库布局就绪')
    const denied = async (name: string, args: Record<string, unknown>, expected: string) => {
      const result = CallToolResultSchema.parse(await client!.callTool({ name, arguments: args }))
      const error = result.content[0]
      assert(result.isError && error.type === 'text', JSON.stringify(result))
      const { code, message } = JSON.parse(error.text)
      if (/^[A-Z_]+$/.test(expected)) assert.equal(code, expected, message)
      else assert(message.includes(expected), message)
      assert(!message.includes('Error invoking remote method'), message)
    }
    if (phase === 'review-resume') {
      const state = JSON.parse(readFileSync(join(dir, 'review-result.json'), 'utf8'))
      await call('open_library', { libraryId: state.libraryId }); await ready(state.libraryId)
      const libraryId = state.libraryId, lib = openLibraries().find(l => l.id === libraryId)!
      await resumeGenericReview(state, call, async (batchId, id) => {
        await call('show_library', { libraryId })
        const { expected } = await call('get_workbench_session', { libraryId })
        const shown = await call('present_workbench', { libraryId, expected, target: { action: 'open_review', batchId }, requestId: 'sample-present-review' })
        const card = `[data-tab-content="${shown.tabId}"] [data-review-item="${id}"]`
        await until(() => lib.win.webContents.executeJavaScript(`(() => {
          const article = document.querySelector(${JSON.stringify(card)})
          if (!article?.textContent.includes('参考目录')) return false
          const button = [...article.querySelectorAll('button')].find(b => b.textContent === '撤回此项')
          if (!button || button.disabled) return false
          button.click()
          return true
        })()`), '引用标题与单项撤回按钮')
        await until(async () => (await call('review_batch', { libraryId, action: 'get', batchId })).batch.withdrawnItems === 1, '应用内单项撤回落盘')
      })
      writeFileSync(join(dir, 'review-resume-result.json'), JSON.stringify({ resubmitted: true, partialWithdrawal: true, keptLaterEdits: true }))
      return
    }
    if (resume) {
      const state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'))
      await call('open_library', { libraryId: state.libraryId }); await ready(state.libraryId)
      assert.equal((await call('get_workbench_configuration', { libraryId: state.libraryId, requestId: state.layoutInput.requestId })).state, 'completed')
      assert.equal((await call('configure_workbench', state.layoutInput)).state, 'completed')
      const preview = await call('preview_workbench', { libraryId: state.libraryId })
      assert.equal(preview.current.panels.inspector, true, '历史回执不覆盖后来的工作台')
      const lib = openLibraries().find(l => l.id === state.libraryId)!
      const row = (await callCore(lib.core, 'get', [state.item]))[0]
      assert.equal(row.blocks.rating.data.value, 5); assert(row.blocks[state.kind])
      const getReview = (action: string, batchId: string) => call('review_batch', { libraryId: lib.id, action, batchId })
      assert.equal((await getReview('get', state.review.withdrawn)).batch.decidedBy, 'application')
      assert.equal((await getReview('get', state.review.pending)).batch.state, 'pending')
      assert.equal((await getReview('confirm', state.review.pending)).batch.decidedBy, 'external')
      assert.equal((await getReview('confirm', state.review.pending)).batch.state, 'confirmed')
      assert.equal((await getReview('withdraw', state.review.rollback)).batch.preserved, 1)
      const reviewed = (await callCore(lib.core, 'get', [state.review.right]))[0]
      const tags = reviewed.blocks.tags.data.values as string[]
      assert(tags.includes('下次验收') && tags.includes('重开修正') && !tags.includes('重开待撤'))
      await denied('execute_operation', state.retainedWrite, 'TASK_CLEANED')
      assert(Array.isArray(row.blocks.tags.data.values) && row.blocks.tags.data.values.includes('交付留存'))
      writeFileSync(join(dir, 'resume-result.json'), JSON.stringify({ taskCleanupRestart: true, batchReviewRestart: true, restart: true, receipts: true, data: true })); return
    }
    const suite = decodeSuite(readFileSync(process.env.VISUAL_AI_SUITE!))
    for (const bytes of suite.packages.values()) localPackages().install(bytes)
    const rating = decodePackage(suite.packages.get(suite.manifest.packages.find(p => p.id === 'rating')!.file)!)
    const otherVersion = localPackages().install(encodePackage({ ...rating.manifest, version: '0.0.1' }, rating.files))
    localSuites().install(suite)
    const extras = [process.env.VISUAL_AI_FIELDS!, process.env.VISUAL_AI_TREE!].map(path => localPackages().install(readFileSync(path)))
    if (phase === 'review') extras.push(localPackages().install(readFileSync(join(dir, 'sample.rmplugin'))))
    packagesChanged()
    const catalog = await call('list_ecosystem_catalog'), preset = catalog.entries.find((e: any) => e.id === 'suite:visual-library:browse')
    assert.equal(catalog.supported.workbenchConfiguration, true)
    const choice = { name: '视觉 AI 验收库', background: true, preset: { id: preset.id, revision: preset.revision, layout: true } }
    for (const p of localPackages().releasePackages()) assert(catalog.entries.some((e: any) => e.hash === p.hash && e.source === 'bundled' && e.authorization === 'bundled-on-first-open'))
    assert((await call('preview_library_creation', choice)).issues.some((s: string) => s.includes('PACKAGE_APPROVAL_REQUIRED')))
    await until(() => launcher.webContents.executeJavaScript("(()=>{const b=document.querySelector('.launcher-ai-title')?.closest('.ui-setting-row')?.querySelector('button');if(!b)return false;b.click();return true})()"), '启动页托管入口')
    await until(() => launcher.webContents.executeJavaScript("(()=>{const d=[...document.querySelectorAll('.launcher-ai-permissions details')].find(e=>e.textContent.includes('视觉素材库'));if(!d)return false;d.open=true;return true})()"), '待授权套件')
    await click(launcher, '允许 AI 使用上述版本')
    await until(() => suite.manifest.packages.every(p => localPackages().automationAllowed(p.hash)), '套件许可落盘')
    assert(!localPackages().automationAllowed(otherVersion.hash), '授信套件不得连带授权同名其他版本')
    await click(launcher, '管理仓库与插件许可')
    await until(() => { try { return settingsSurface(launcher) } catch { return false } }, '设置窗口')
    const ui = settingsSurface(launcher); await click(ui, 'AI 接入 · MCP'); await click(ui, '插件包授信')
    assert.equal((await local('management', { action: 'list' })).packages.find((p: any) => p.hash === extras[0].hash).allowed, localPackages().isRelease(extras[0].hash))
    await click(ui, '允许 AI 使用当前全部已安装版本')
    await until(() => localPackages().list().every(p => localPackages().automationAllowed(p.hash)), '批量许可落盘')
    await until(() => ui.webContents.executeJavaScript(`document.querySelector('.mcp-versions')?.open === false
      && [...document.querySelectorAll('.ui-setting-desc')].some(e => e.textContent.startsWith('${localPackages().list().length} / ${localPackages().list().length} 个版本已授信'))`), '授信数量更新且版本保持折叠')
    ui.showInactive(); writeFileSync(join(dir, 'permissions.png'), (await ui.webContents.capturePage()).toPNG())
    const preview = await call('preview_library_creation', choice); assert.deepEqual(preview.issues, [])
    const made = await call('create_library', { ...choice, previewRevision: preview.revision, requestId: 'visual-ai-create' }); assert.equal(made.state, 'completed'); await ready(made.libraryId)
    const libraryId = made.libraryId, lib = openLibraries().find(l => l.id === libraryId)!
    assert.equal((await loadWorkspace(libraryId))?.presetApplication, made.taskId, 'MCP 工作台就绪时，后台起始布局已落盘')
    assert(!lib.win.isVisible())
    const added = await call('preview_library_plugins', { libraryId, plugins: extras.map(p => ({ id: p.manifest.id, hash: p.hash })) })
    assert.deepEqual(added.issues, [])
    assert.equal((await call('configure_library_plugins', { libraryId, selection: added.selection, revision: added.revision, requestId: 'visual-ai-fields' })).state, 'completed'); await ready(libraryId)
    assert(!lib.win.isVisible())
    if (phase === 'inventory') {
      const grant = (await local('settings')).libraries.find((l: { libraryId: string }) => l.libraryId === libraryId)
      const result = await checkInventory(dir, libraryId, call, denied, mode => local('settings', { grant: { key: grant.key, mode } }), until)
      writeFileSync(join(dir, 'inventory-result.json'), JSON.stringify(result))
      return
    }
    const files: string[] = []
    for (const color of ['red', 'blue']) { const file = join(dir, color + '.png'); await sharp({ create: { width: 160, height: 100, channels: 3, background: color } }).png().toFile(file); files.push(file) }
    const taskId = 'visual-task-retention'
    await call('library_task', { libraryId, action: 'create', taskId, title: '视觉任务收尾验证', inputs: files })
    const importInput = { libraryId, taskId, requestId: 'visual-ai-import', files: files.map(path => ({ path })) }
    const imported = await call('import_to_library', { ...importInput, waitMs: 2000, processingKinds: ['thumb', 'palette', 'image-filter.geometry'] }); assert.deepEqual(imported.errors, [])
    assert.equal(imported.processingObservation.state, 'observed')
    const replayedImport = await call('import_to_library', { ...importInput, waitMs: 0 })
    assert.deepEqual(replayedImport.items, imported.items); assert.deepEqual(replayedImport.saved, imported.saved)
    const ids = imported.items.map((item: any) => item.id)
    const observed = await call('get_processing_status', { libraryId, ids, kinds: ['still', 'palette', 'image-filter.geometry'], waitMs: 10000 })
    assert.equal(observed.timedOut, false, JSON.stringify(observed))
    assert(observed.items.every((item: any) => item.state === 'settled' && item.kinds.every((kind: any) => kind.state === 'ready')), JSON.stringify(observed))
    const status = await call('get_library_status', { libraryId, sections: ['plugins', 'workbench', 'processing', 'errors'] })
    assert.equal(status.core, 'running'); assert.equal(status.workbench.state, 'ready'); assert.equal(status.workbench.visible, false)
    assert.deepEqual(status.errors, []); assert(status.plugins.some((p: any) => p.id === 'palette' && p.enabled))
    const imageResult = CallToolResultSchema.parse(await client!.callTool({ name: 'read_preview', arguments: { libraryId, ids: [ids[1], 'missing-preview-slot', ids[0]], mode: 'grid', maxSide: 960 } }))
    assert(!imageResult.isError, JSON.stringify(imageResult))
    const imageContent = imageResult.content.find(c => c.type === 'image')
    assert(imageContent?.type === 'image'); assert.equal(imageContent.mimeType, 'image/jpeg')
    const sheet = Buffer.from(imageContent.data, 'base64'), metadata = imageResult.structuredContent as any
    assert.deepEqual(metadata.items.map((i: any) => [i.index, i.id, i.state]), [[1, ids[1], 'ready'], [2, 'missing-preview-slot', 'missing'], [3, ids[0], 'ready']])
    assert(!JSON.stringify(metadata).includes(imageContent.data), 'JSON 不重复包含图像字节')
    const raster = await sharp(sheet).removeAlpha().raw().toBuffer({ resolveWithObject: true })
    assert(raster.data[(180 * raster.info.width + 160) * 3 + 2] > 240, '第1格为蓝图')
    assert(raster.data[(180 * raster.info.width + 800) * 3] > 240, '第3格为红图')
    writeFileSync(join(dir, 'preview-grid.jpg'), sheet)
    if (phase === 'review') {
      const state = await prepareGenericReview(libraryId, taskId, ids, call)
      writeFileSync(join(dir, 'review-result.json'), JSON.stringify(state))
      return
    }
    let count = 0
    const op = async (operation: string, args: Record<string, unknown>) => (await call('execute_operation', { libraryId, operation, requestId: `visual-op-${++count}`, args })).result
    const description = await call('describe_library', { libraryId })
    for (const name of ['update_tags', 'create_group', 'collection_create', 'set_rating', 'set_note', 'fields_create_template', 'fields_set_values', 'save_view', 'tag_tree_set_parent']) assert(description.operations.some((op: any) => op.name === name), name)
    await op('create_group', { title: '参考类型', tag: '灵感' }); await op('tag_tree_set_parent', { tag: '灵感', parent: '视觉' })
    const folder = await op('collection_create', { title: '精选' })
    const selected = [ids[0], folder.id]
    const matching = async (role: string) => (await call('search_items', { libraryId, query: { ids: selected, role } })).items.map((v: { id: string }) => v.id)
    assert.deepEqual(await matching('material'), [ids[0]])
    assert.deepEqual(await matching('container'), [folder.id])
    assert.deepEqual(new Set(await matching('browse')), new Set(selected))
    await denied('execute_operation', { libraryId, operation: 'set_rating', requestId: 'mixed-rating', args: { ids: selected, value: 3 } }, 'NOT_FOUND')
    assert(!(await callCore(lib.core, 'get', [ids[0]]))[0].blocks.rating)
    await op('collection_delete', { id: folder.id })
    await op('collection_restore', { id: folder.id })
    await op('collection_move', { ids: [ids[0]], group: folder.id })
    await op('update_tags', { ids, add: ['灵感'] }); await op('set_rating', { ids: [ids[0]], value: 5 }); await op('set_note', { id: ids[0], text: '红色参考图', expectedSeq: null })
    const template = await op('fields_create_template', { title: '竞品页面卡' })
    await assert.rejects(op('fields_set_values', { template: template.template, items: selected.map(id => ({ id, expectedSeq: 0, values: {} })) }), /素材|容器/)
    assert((await callCore(lib.core, 'get', selected)).every(v => !v.blocks[template.kind]))
    const field = await op('fields_add_field', { template: template.template, title: '参考阶段', type: 'select' })
    await op('fields_add_option', { template: template.template, field: field.field, option: '参考' })
    await op('fields_set_values', { template: template.template, items: [{ id: ids[0], expectedSeq: 0, values: { [field.field]: '参考' } }] })
    const before = (await callCore(lib.core, 'get', [ids[0]]))[0].blocks[template.kind]
    await denied('execute_operation', { libraryId, operation: 'fields_set_values', requestId: 'invalid-field-batch', args: { template: template.template, items: [{ id: ids[0], expectedSeq: before.seq, values: { [field.field]: null } }, { id: ids[1], expectedSeq: 0, values: { [field.field]: '非法选项' } }] } }, '选项')
    assert.deepEqual((await callCore(lib.core, 'get', [ids[0]]))[0].blocks[template.kind], before, '失败整批回滚')
    await denied('execute_operation', { libraryId, operation: 'fields_set_values', requestId: 'stale-field-values', args: { template: template.template, items: [{ id: ids[0], expectedSeq: 0, values: {} }] } }, '已在别处修改')
    const view = await op('save_view', { title: '五星灵感', query: { scope: 'all', role: 'material', where: [{ op: 'eq', kind: 'rating', field: 'value', value: 5 }] }, layout: 'masonry' })
    const access = await local('settings'), grant = access.libraries.find((l: any) => l.libraryId === libraryId)
    await local('settings', { grant: { key: grant.key, mode: 'read' } })
    assert.equal((await call('get_library_status', { libraryId })).core, 'running')
    const single = CallToolResultSchema.parse(await client!.callTool({ name: 'read_preview', arguments: { libraryId, ids: [ids[0]] } }))
    assert(!single.isError && single.content.some(c => c.type === 'image'), 'read 权限可以实际读取单图')
    await local('settings', { grant: { key: grant.key, mode: 'off' } })
    await denied('read_preview', { libraryId, ids: [ids[0]] }, 'ACCESS_DENIED')
    await local('settings', { grant: { key: grant.key, mode: 'read' } })
    const changedInput = await call('get_processing_status', { libraryId, ids: [ids[0]], kinds: ['palette'], expectedRevisions: { [ids[0]]: observed.items.find((item: any) => item.id === ids[0]).revision } })
    assert.equal(changedInput.items[0].state, 'changed', '人的原始记录修改需要重新确认')
    await local('settings', { grant: { key: grant.key, mode: 'organize' } })
    const permissions = (await call('list_ecosystem_catalog', { libraryId })).target.permissions
    assert.equal(permissions.workbenchPresentation, true, '整理模式可发现推送入口')
    assert.equal(permissions.workbenchConfiguration, false, '持久编排仍需管理权限')
    await op('set_rating', { ids: [ids[0]], value: 5 })
    await denied('execute_operation', { libraryId, operation: 'fields_add_field', requestId: 'denied-structure', args: { template: template.template, title: '越权', type: 'text' } }, 'ADMIN_REQUIRED')
    await denied('preview_workbench', { libraryId }, 'ADMIN_REQUIRED')
    await local('settings', { grant: { key: grant.key, mode: 'admin' } })
    const current = await call('preview_workbench', { libraryId })
    const layout = { ...current.current, root: { type: 'split', id: 'split', direction: 'columns', ratio: 0.55, first: { type: 'group', id: 'all' }, second: { type: 'group', id: 'best' } }, primary: 'all', panels: { sidebar: true, inspector: false }, contents: {
      all: { items: [{ kind: 'page', type: 'collection', target: { presetId: 'all' } }] }, best: { items: [{ kind: 'page', type: 'collection', target: { viewId: view.id } }] }
    } }
    const planned = await call('preview_workbench', { libraryId, layout }); assert.deepEqual(planned.preview.issues, [])
    const layoutInput = { libraryId, layout, revision: planned.revision, requestId: 'visual-workbench-arrange' }
    const configured = await call('configure_workbench', layoutInput); assert.equal(configured.state, 'completed', JSON.stringify(configured))
    const ws = await loadWorkspace(libraryId); assert(ws.tabs.some((t: any) => t.params.viewId === view.id)); assert.equal(ws.editors.root.type, 'split')
    const next = await call('preview_workbench', { libraryId }), changed = { ...next.current, panels: { ...next.current.panels, inspector: true } }
    const second = await call('configure_workbench', { libraryId, layout: changed, revision: next.revision, requestId: 'visual-later-arrangement' }); assert.equal(second.state, 'completed', JSON.stringify(second))
    const stale = await call('configure_workbench', { ...layoutInput, requestId: 'visual-stale-arrangement' }); assert(stale.error.includes('PREVIEW_CHANGED'))
    assert.equal((await call('configure_workbench', layoutInput)).state, 'completed')
    assert.equal((await call('preview_workbench', { libraryId })).current.panels.inspector, true)
    const all = (await callCore(lib.core, 'query', { scope: 'content' })).ids
    assert(ids.every((id: string) => all.includes(id)))
    await call('show_library', { libraryId })
    await until(() => lib.win.webContents.executeJavaScript("document.querySelectorAll('.card').length >= 3"), '全部与精选两页可见卡片')
    writeFileSync(join(dir, 'delivery.png'), (await lib.win.webContents.capturePage()).toPNG())
    const selectCard = (id: string) => lib.win.webContents.executeJavaScript(`document.querySelector(${JSON.stringify('[data-entity-id="' + id + '"]')}).dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}))`)
    const inspectorSections = () => lib.win.webContents.executeJavaScript("[...document.querySelectorAll('.inspector-section-toggle')].map(b=>b.textContent)") as Promise<string[]>
    await selectCard(folder.id)
    await until(async () => (await inspectorSections()).some(title => title.includes('文件夹信息')), '文件夹检查器')
    assert(!(await inspectorSections()).some(title => /评分|添加模板/.test(title)), '容器不显示素材编辑分区')
    await lib.win.webContents.executeJavaScript("document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'a',bubbles:true}))")
    await until(() => lib.win.webContents.executeJavaScript("document.body.textContent.includes('仅选择普通素材进行快速附加')"), '快捷键与右键菜单使用同一容器规则')
    await selectCard(ids[0])
    await until(async () => (await inspectorSections()).some(title => title.includes('评分')), '图片评分检查器')
    if (process.env.VISUAL_AI_PHASE === 'roles') {
      writeFileSync(join(dir, 'roles-result.json'), JSON.stringify({ suitePermission: true, containerQueries: true, mixedWritesRejected: true, folderRestore: true, inspectorAndShortcut: true }))
      return
    }
    const workbenchSession = await checkWorkbenchSession(lib.win, libraryId, ids, view.id, call, denied, mode => local('settings', { grant: { key: grant.key, mode } }), async name => {
      await lib.win.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
      writeFileSync(join(dir, name + '.png'), (await lib.win.webContents.capturePage()).toPNG())
    })
    writeFileSync(join(dir, 'workbench-session-result.json'), JSON.stringify(workbenchSession))
    writeFileSync(join(dir, 'workbench-session.png'), (await lib.win.webContents.capturePage()).toPNG())
    const review = await checkReview(lib, ids, template, dir, call, denied, mode => local('settings', { grant: { key: grant.key, mode } }), until)
    const retainedWrite = { libraryId, taskId, requestId: 'retained-visual-tag', operation: 'update_tags', args: { ids: [ids[0]], add: ['交付留存'] } }
    await call('execute_operation', retainedWrite)
    await denied('library_task', { libraryId, action: 'complete', taskId }, 'TASK_DRAFTS')
    lib.win.webContents.send('menu:command', 'settings')
    await until(() => { try { return settingsSurface(lib.win) } catch { return false } }, '仓库设置')
    const maintenance = settingsSurface(lib.win)
    await click(maintenance, '数据与维护')
    await until(() => maintenance.webContents.executeJavaScript("!!document.querySelector('.task-maintenance input[name=tasks]')"), '任务容量设置')
    assert.equal(await maintenance.webContents.executeJavaScript("document.querySelector('.task-limits').open"), false)
    writeFileSync(join(dir, 'maintenance-storage.png'), (await maintenance.webContents.capturePage()).toPNG())
    await maintenance.webContents.executeJavaScript("(()=>{const e=document.querySelector('.task-maintenance input[name=tasks]');e.closest('details').open=true;e.value='1'})()")
    await click(maintenance, '保存上限')
    await until(() => maintenance.webContents.executeJavaScript("document.querySelector('.task-maintenance [role=status]')?.textContent.includes('已保存')"), '任务上限已保存')
    await denied('library_task', { libraryId, action: 'create', taskId: 'over-quota-plan', title: '超额清单', inputs: files }, 'TASK_LIMIT')
    await maintenance.webContents.executeJavaScript("[...document.querySelectorAll('.task-maintenance summary')].find(e => e.textContent === '查看任务明细').click()")
    await click(maintenance, '业务写入')
    await click(maintenance, '查看差异')
    await until(() => maintenance.webContents.executeJavaScript("document.querySelector('.task-records')?.innerText.includes('交付留存')"), '原写入差异可见')
    await click(maintenance, '预览丢弃这份草稿')
    await until(() => maintenance.webContents.executeJavaScript("document.querySelector('.task-cleanup-preview')?.innerText.includes('1 份草稿')"), '清理草稿预览')
    await click(maintenance, '确认丢弃草稿')
    await until(async () => (await call('library_task', { libraryId, action: 'get', section: 'writes', taskId })).writes[0].reviewState === 'discarded', '草稿清理')
    await click(maintenance, '完成任务')
    await click(maintenance, '预览整项清理')
    await until(() => maintenance.webContents.executeJavaScript("document.querySelector('.task-cleanup-preview')?.innerText.includes('2 条来源路径')"), '清理整项任务预览')
    const cleanupPreview = await maintenance.webContents.executeJavaScript("document.querySelector('.task-cleanup-preview').innerText")
    assert(cleanupPreview.includes('2 条来源路径') && cleanupPreview.includes('2 条导入尝试'), cleanupPreview)
    await maintenance.webContents.executeJavaScript("document.querySelector('.task-cleanup-preview').scrollIntoView({block:'center'})")
    writeFileSync(join(dir, 'task-cleanup.png'), (await maintenance.webContents.capturePage()).toPNG())
    await click(maintenance, '确认清理任务记录')
    await until(async () => !(await call('library_task', { libraryId, action: 'list' })).tasks.some((t: any) => t.taskId === taskId), '清理后任务移除')
    await until(() => maintenance.webContents.executeJavaScript("document.querySelector('.task-marker-usage')?.innerText.includes('任务标记 1 条 · 请求标记 2 条 · 估算占用')"), '清理后自动刷新防重用量')
    assert.equal(await maintenance.webContents.executeJavaScript("!!document.querySelector('.task-marker-notice')"), false)
    await denied('import_to_library', importInput, 'TASK_CLEANED')
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ libraryId, layoutInput, item: ids[0], kind: template.kind, review, retainedWrite }))
    writeFileSync(join(dir, 'first-result.json'), JSON.stringify({ batchReview: true, suitePermission: true, bulkPermission: true, nativeImageProcessing: true, processingViaMcp: true, inlineImportWait: true, importReplay: true, previewImageContent: true, previewGridMapping: true, previewPermission: true, runtimeStatus: true, readStatusPermission: true, inputRevision: true, operations: true, fieldRollback: true, adminBoundary: true, savedView: true, layout: true, staleRejected: true, replay: true }))
  } catch (e) { console.error(e); process.exitCode = 1 }
  finally { await client?.close(); await transport?.close(); app.quit() }
})
