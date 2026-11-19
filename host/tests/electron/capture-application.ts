import { openLibraryMcpSettings, findSettingsSurface, settingsScript, settingsSurface } from './settings-surface'
import type { EcosystemCatalog } from '../../src/shared/ecosystem-catalog'
import type { HistoryPage, HistoryDetail } from '../../src/shared/history'
// 零仓库启动 → 应用设置 → 真正 stdio → 新建仓库 → utilityProcess 收录与插件设置。
import sharp from 'sharp'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, dialog, type BrowserWindow } from 'electron'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport, type StdioServerParameters } from '@modelcontextprotocol/sdk/client/stdio.js'
import { openLibraries, allClosed, reloadLibrary } from '../../src/main/libraries'
import { callCore } from '../../src/main/core-client'
import type { ApplicationMcpSettings } from '../../src/plugins/mcp/settings'
import type { CreateLibraryReceipt } from '../../src/shared/application-access'
import type { ContentChunk, ItemDetails, LibraryDescription, OperationResult, SearchPageResult } from '../../src/shared/automation'
import type { IngestResult } from '../../src/plugin-api/operations'

const wait = (ms: number) => new Promise(r => setTimeout(r, ms))
const check = (value: unknown, label: string) => { if (!value) throw new Error(label) }
const until = async (fn: () => Promise<unknown>, label: string) => {
  for (let i = 0; i < 150; i++) { try { if (await fn()) return } catch { /* 加载中 */ } await wait(100) }
  throw new Error(label)
}
export async function runApplicationCapture(win: BrowserWindow, dir: string) {
  const js = (code: string) => win.webContents.executeJavaScript(code)
  const settingsJs = (code: string, owner = win) => settingsScript(owner, code)
  const shot = async (name: string, target = win) => { target.showInactive(); await wait(100); writeFileSync(join(dir, name), (await target.webContents.capturePage()).toPNG()) }
  const click = async (label: string, target = win) => {
    await until(() => target.webContents.executeJavaScript(`(() => {const b=[...document.querySelectorAll('button')].find(b=>b.getClientRects().length&&b.textContent.trim()===${JSON.stringify(label)});if(!b||b.disabled)return false;b.click();return true})()`), `按钮不可用 ${label}`)
    await wait(180)
  }
  const settings = (input?: unknown) => js(`window.bridge.application.service('mcp','settings',${JSON.stringify(input ?? {})})`) as Promise<ApplicationMcpSettings>
  let client: Client | undefined, transport: StdioClientTransport | undefined
  try {
    await until(() => js(`!!document.querySelector('.launcher')`), '仓库管理未加载')
    check(openLibraries().length === 0, '测试必须从零仓库开始')
    const resume = process.env.CAPTURE_FLOW === 'appmcpresume'
    if (!resume) {
      await click('设置…')
      await until(() => js("!!document.querySelector('#launcher-ai-mode')"), 'AI 托管配置页')
      const fresh = await settings()
      check(!fresh.enabled && !fresh.creation, '浏览开始页更改了授权')
      check(!await js("document.querySelector('.launcher-ai-development input').checked"), '默认选择了自主开发')
      const parent = join(dir, 'libraries'); mkdirSync(parent)
      const nativeDialog = dialog.showOpenDialog
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [parent] })) as typeof nativeDialog
      try { await click('选择目录…') } finally { dialog.showOpenDialog = nativeDialog }
      check(!(await settings()).creation, '选目录或切换权限提前写入')
      const bounds = win.getBounds()
      win.setSize(780, 540)
      await wait(100)
      check(await js("document.querySelector('.launcher-main').scrollWidth <= document.querySelector('.launcher-main').clientWidth"), '窄窗配置横向溢出')
      win.setBounds(bounds)
      await shot('launcher-ai-setup.png')
      await js(`(() => { const s=document.querySelector('#launcher-ai-mode'); s.value='organize'; s.dispatchEvent(new Event('change',{bubbles:true})) })()`)
      await click('保存并开启 AI 接入')
      await until(async () => (await settings()).creation?.mode === 'organize', '开始页选择的权限未保存')
      await js("document.querySelector('.launcher-ai-connect summary').click()")
      check(await js("document.querySelector('[aria-label=客户端配置]').value") === (await settings()).config, '配置与实际 stdio 参数不符')
      await js(`(() => { const s=document.querySelector('[aria-label=客户端配置格式]'); s.value='toml'; s.dispatchEvent(new Event('change',{bubbles:true})) })()`)
      check((await js("document.querySelector('[aria-label=客户端配置]').value")).includes('"ELECTRON_RUN_AS_NODE" = "1"'), 'Codex 配置缺少宿主环境')
      // 用内存代替系统剪贴板，保留运行者的剪贴板内容。
      await js("Object.defineProperty(navigator.clipboard,'writeText',{ configurable:true, value:async text=>{window.__copied=text} })")
      try {
        await click('复制接入配置')
        check(await js("window.__copied===document.querySelector('[aria-label=客户端配置]').value"), '复制内容与所选格式不符')
        await click('复制第一句指令')
        check(await js("window.__copied.includes('仓库') && !window.__copied.includes('[mcp_servers')"), '第一句指令复制错误')
      } finally { await js("delete navigator.clipboard.writeText; delete window.__copied") }
      await click('管理仓库与插件许可')
    } else {
      await click('设置'); await until(() => Promise.resolve(settingsSurface(win)), '设置窗口未打开'); await click('AI 接入 · MCP', settingsSurface(win))
    }
    await until(() => settingsJs(`!!document.querySelector('[aria-label="启用应用 MCP"]:not(:disabled)')`), '无仓库时不能打开应用设置')
    check(!await settingsJs("document.querySelector('.mcp-current-badge, .mcp-config')"), '开始页应无当前仓库，连接配置默认收起')
    if (!resume) {
      const ui = settingsSurface(win)
      await click('查看配置', ui)
      check(await settingsJs("document.querySelector('.mcp-config').value") === (await settings()).config, '设置页 JSON 与宿主回执不符')
      await settingsJs(`(() => { const s = document.querySelector('[aria-label="连接配置格式"]'); s.value = 'toml'; s.dispatchEvent(new Event('change', { bubbles: true })) })()`)
      check((await settingsJs("document.querySelector('.mcp-config').value")).startsWith('[mcp_servers.huoye]'), 'TOML 展示错误')
      await click('收起配置', ui)
      // 使用设置窗口自己的剪贴板替身，保留系统剪贴板。
      await settingsJs("Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: async text => { window.__copied = text } })")
      try {
        await click('复制配置', ui)
        check((await settingsJs('window.__copied'))?.includes('"ELECTRON_RUN_AS_NODE" = "1"'), '折叠后复制了错误格式')
      } finally { await settingsJs('delete navigator.clipboard.writeText; delete window.__copied') }
      check(await settingsJs("document.querySelector('select[aria-label=\"新建仓库的 MCP 权限\"]').value") === 'organize', '两个入口的建库授权不一致')
      await settingsJs(`(() => { const s=document.querySelector('select[aria-label="新建仓库的 MCP 权限"]'); s.value='admin'; s.dispatchEvent(new Event('change',{bubbles:true})) })()`)
      await until(async () => (await settings()).creation?.mode === 'admin', '托管权限未保存')
    }
    const config = await settings()
    check(config.enabled, '重启丢失应用开关')
    await shot(resume ? 'app-settings-resume.png' : 'app-settings-empty.png', settingsSurface(win))
    await settingsJs(`document.querySelector('[aria-label="关闭设置"]').click()`)
    await until(() => Promise.resolve(!findSettingsSurface(win)), '设置未关闭')
    if (!resume) {
      await until(() => js("document.querySelector('#launcher-ai-mode')?.value === 'admin'"), '开始页未读回高级设置')
      await click('← 返回')
    }
    const params = Object.values(JSON.parse(config.config).mcpServers)[0] as StdioServerParameters
    client = new Client({ name: 'application-regression', version: '1.0.0' })
    transport = new StdioClientTransport({ ...params, stderr: 'pipe' })
    await client.connect(transport)
    const call = async <T>(name: string, args: Record<string, unknown> = {}): Promise<T> => {
      const result = await client!.callTool({ name, arguments: args })
      check(!result.isError, `${name}: ${JSON.stringify(result.content)}`)
      return result.structuredContent as T
    }
    const denied = async (name: string, args: Record<string, unknown>, code: string) => {
      const result = await client!.callTool({ name, arguments: args })
      check(result.isError && JSON.stringify(result.content).includes(code), `未拒绝 ${name}: ${JSON.stringify(result)}`)
    }
    const catalog = await call<EcosystemCatalog>('list_ecosystem_catalog')
    check(catalog.creation?.mode === 'admin' && catalog.entries.some(e => e.id === 'file'), '零仓库能力目录或托管策略缺失')
    check(catalog.supported.creationWithPreset && catalog.supported.backgroundCreation && catalog.supported.pluginConfiguration && catalog.supported.packageInstallation && catalog.entries.every(e => e.runtime === 'not-checked'), '目录虚报未实现能力或运行状态')
    const tools = (await client.listTools()).tools
    check(tools.some(t => t.name === 'execute_operation') && !tools.some(t => t.name === 'create_text'), '未统一应用工具')
    const request = { name: 'AI 素材库', requestId: 'app-create-library' }
    if (resume) {
      const saved = JSON.parse(readFileSync(join(dir, 'app-mcp-state.json'), 'utf8'))
      const receipt = await call<CreateLibraryReceipt>('create_library', request)
      check(receipt.replayed && receipt.libraryId === saved.libraryId && openLibraries().length === 0, '重启回执重复创建或隐式打开了仓库')
      check((await call<EcosystemCatalog>('list_ecosystem_catalog', { libraryId: saved.libraryId })).target?.mode === 'admin', '重启丢失托管授权')
      await call('open_library', { libraryId: saved.libraryId })
      check((await call<ContentChunk>('read_content', { libraryId: saved.libraryId, id: saved.textId, kind: 'text', field: 'content' })).text.includes('应用级素材'), '重启内容丢失')
      check((await call<OperationResult>('execute_operation', saved.operation)).replayed, '重启丢失仓库操作回执')
      check((await call<HistoryPage>('list_history', { libraryId: saved.libraryId })).total === 0, '重启后公开了旧会话历史或回执重放产生新记录')
      writeFileSync(join(dir, 'app-mcp-resume-result.json'), JSON.stringify({ ok: true }))
      console.log('[capture] 应用 MCP 重启：零仓库连接、创建回执、打开原库、内容和写入回执通过')
      return
    }
    check((await call<{ libraries: unknown[] }>('list_libraries')).libraries.length === 0, '无仓库列表不为空')
    const [a, duplicate] = await Promise.all([call<CreateLibraryReceipt>('create_library', request), call<CreateLibraryReceipt>('create_library', request)])
    check(a.libraryId === duplicate.libraryId && a.replayed !== duplicate.replayed, '创建仓库并发重试不一致')
    const lib = openLibraries().find(l => l.id === a.libraryId)!
    await until(() => lib.win.webContents.executeJavaScript(`!!document.querySelector('.app') || !!document.querySelector('.sidebar')`), '新仓库界面未加载')
    const b = await call<CreateLibraryReceipt>('create_library', { name: '只读仓库', requestId: 'app-second-library' })
    await denied('create_library', { name: '拒绝提权', requestId: 'app-escalation', mode: 'admin' }, 'INVALID_INPUT')
    check((await call<EcosystemCatalog>('list_ecosystem_catalog', { libraryId: a.libraryId })).target?.permissions.structure, '托管库缺少管理授权')
    const grants = (await settings()).libraries
    // 从第二个仓库打开，确认排序取决于所属窗口，并实际修改其授权。
    const secondWindow = openLibraries().find(l => l.id === b.libraryId)!.win
    await call('show_library', { libraryId: b.libraryId })
    const repoSettings = await openLibraryMcpSettings(secondWindow)
    const repoJs = (code: string) => settingsJs(code, secondWindow)
    const secondGrant = grants.find(g => g.libraryId === b.libraryId)!
    await until(() => repoJs(`document.querySelector('.mcp-grant')?.dataset.libraryKey === ${JSON.stringify(secondGrant.key)}`), '当前仓库没有置顶')
    check(await repoJs("document.querySelectorAll('.mcp-current-badge').length === 1 && document.querySelectorAll('.mcp-grant').length === 2"), '仓库授权列表重复')
    check(!await repoJs("document.querySelector('.mcp-config')"), '仓库窗口配置默认应收起')
    await click('细项授权', repoSettings)
    await until(() => repoJs("!!document.querySelector('.mcp-grant.is-current .mcp-space-row')?.checkVisibility()"), '未读取当前仓库原件授权')
    const spaceToggle = '.mcp-grant.is-current .mcp-space-row input'
    await repoJs(`document.querySelector('${spaceToggle}').click()`)
    await until(async () => (await settings()).libraries.find(l => l.key === secondGrant.key)?.fileSpaces?.some(s => s.revise), '当前仓库原件更新许可未保存')
    await until(() => repoJs(`document.querySelector('${spaceToggle}').matches(':checked:enabled')`), '当前仓库原件许可回显未更新')
    await repoJs(`document.querySelector('${spaceToggle}').click()`)
    await until(async () => (await settings()).libraries.find(l => l.key === secondGrant.key)?.fileSpaces?.every(s => !s.revise), '当前仓库原件更新许可未撤销')
    await click('自主开发与验收', repoSettings)
    check(await repoJs("document.querySelectorAll('.mcp-grant:has(select)').length === 2 && !document.querySelector('.mcp-grant').checkVisibility()"), '开发页重复列出了仓库')
    await click('管理仓库授权', repoSettings)
    check(await repoJs("document.querySelector('.mcp-grant.is-current button').getAttribute('aria-expanded') === 'true'"), '切页丢失当前库抽屉')
    await repoJs(`(() => {const s=document.querySelector('.mcp-grant.is-current select');s.value='read';s.dispatchEvent(new Event('change',{bubbles:true}))})()`)
    await until(async () => (await settings()).libraries.find(l => l.key === secondGrant.key)?.mode === 'read', '仓库窗口授权未保存')
    check((await settings()).libraries.find(l => l.libraryId === a.libraryId)?.mode === 'admin', '影响了其他仓库的授权')
    await click('收起授权', repoSettings)
    await shot('mcp-settings-current.png', repoSettings)
    await click('插件包授信', repoSettings)
    await until(() => repoJs("document.querySelector('.mcp-versions')?.open === false"), '仓库窗口的版本列表默认应收起')
    repoSettings.close()
    await until(async () => !findSettingsSurface(secondWindow), '仓库设置不能关闭')
    await js('window.dispatchEvent(new Event("focus"))')
    const badge = (root: string) => js(`[...document.querySelectorAll('.vault-item')].find(row=>row.querySelector('.vault-path').textContent.slice(1)===${JSON.stringify(root)})?.querySelector('.launcher-ai-badge')?.textContent`)
    await until(async () => await badge(a.root) === 'AI 托管' && await badge(b.root) === 'AI 只读', '逐库授权标记')
    await shot('launcher-ai-badges.png')
    const readKey = grants.find(g => g.libraryId === b.libraryId)!.key
    for (const [mode, expected] of [['organize', 'AI 可整理'], ['off', undefined], ['read', 'AI 只读']] as const) {
      await settings({ grant: { key: readKey, mode } })
      await js('window.dispatchEvent(new Event("focus"))')
      await until(async () => await badge(b.root) === expected, '标记未反映 ' + mode + ' 权限')
    }
    const recentCount = await js("document.querySelectorAll('.vault-item').length")
    await click('连接与配置'); await click('暂停全部 AI 接入')
    await until(async () => !(await settings()).enabled && !await badge(a.root), '暂停后仍显示有效授权')
    check(await js("document.querySelectorAll('.vault-item').length") === recentCount, '暂停隐藏了最近仓库')
    await click('恢复 AI 接入')
    await until(async () => await badge(b.root) === 'AI 只读', '恢复连接改变了原授权')
    await click('← 返回')
    const description = await call<LibraryDescription>('describe_library', { libraryId: a.libraryId })
    check(description.operations.some(o => o.name === 'create_text'), '插件操作未发布')
    const operation = { libraryId: a.libraryId, operation: 'create_text', requestId: 'app-create-text', args: { content: '应用级素材 appmcpneedle' } }
    const textId = (await call<OperationResult>('execute_operation', operation)).result as { id: string }
    check((await call<SearchPageResult>('search_items', { libraryId: a.libraryId, query: { search: [{ kind: 'text', text: 'appmcpneedle' }] } })).items[0]?.id === textId.id, '文字未进入目标仓库')
    check((await call<SearchPageResult>('search_items', { libraryId: b.libraryId, query: {} })).items.length === 0, '跨库写入串库')
    check((await call<HistoryPage>('list_history', { libraryId: b.libraryId })).entries.length === 0, '只读仓库不能读取自己的历史')
    await denied('execute_operation', { ...operation, libraryId: b.libraryId }, 'READ_ONLY')
    await denied('describe_library', {}, 'INVALID_INPUT')
    await settings({ grant: { key: grants.find(g => g.libraryId === b.libraryId)!.key, mode: 'off' } })
    check((await call<{ libraries: { libraryId: string }[] }>('list_libraries')).libraries.every(l => l.libraryId !== b.libraryId), '未授权仓库泄露到列表')
    await denied('open_library', { libraryId: b.libraryId }, 'ACCESS_DENIED')
    await denied('list_ecosystem_catalog', { libraryId: b.libraryId }, 'ACCESS_DENIED')

    // 基础应用即可验收，不依赖外部业务包或特定插件管理布局。
    const txt = join(dir, 'new-document.txt'), png = join(dir, 'new-image.png')
    writeFileSync(txt, 'Native apptextneedle')
    await sharp({ create: { width: 32, height: 24, channels: 3, background: '#336699' } }).png().toFile(png)
    const imported = await call<OperationResult>('execute_operation', { libraryId: a.libraryId, operation: 'import_files', requestId: 'app-import', args: { paths: [png, txt] } })
    const files = imported.result as IngestResult
    check(files.items.length === 2 && files.errors.length === 0, '文件导入失败')
    const pngId = files.items.find(i => i.index === 0)!.id, txtId = files.items.find(i => i.index === 1)!.id
    await until(async () => (await call<ItemDetails>('read_item', { libraryId: a.libraryId, id: txtId })).fields.some(f => f.kind === 'body'), 'Electron 正文未完成加工')
    await until(async () => (await call<ItemDetails>('read_item', { libraryId: a.libraryId, id: pngId })).fields.some(f => f.kind === 'image'), 'Electron 图片未完成加工')
    check((await call<ContentChunk>('read_content', { libraryId: a.libraryId, id: txtId, kind: 'body', field: 'content' })).text.includes('apptextneedle'), '导入正文读取失败')
    check((await call<SearchPageResult>('search_items', { libraryId: a.libraryId, query: { text: 'apptextneedle' } })).items.some(i => i.id === txtId), '导入正文搜索失败')
    const storage = await callCore(lib.core, 'fileStorageInfo', pngId)
    check(storage.path && readFileSync(storage.path).equals(readFileSync(png)), '空间原件字节改变')
    const identified = await lib.win.webContents.executeJavaScript(`window.bridge.files.identify(${JSON.stringify([storage.path, png, storage.path])})`)
    check(JSON.stringify(identified) === JSON.stringify([pngId, null, pngId]), '真实路径桥回拖识别失败')
    const view = (await callCore(lib.core, 'get', [pngId]))[0]
    const resolved = await lib.win.webContents.executeJavaScript(`window.bridge.files.resolve(${JSON.stringify(view.blocks.file.data.path)})`)
    check(resolved === storage.path, '主进程与核心定位不一致')
    const disposable = { ...operation, requestId: 'app-undo-text', args: { content: '待撤销内容' } }
    const created = (await call<OperationResult>('execute_operation', disposable)).result as { id: string }
    const history = await call<HistoryPage>('list_history', { libraryId: a.libraryId, requestId: disposable.requestId })
    check(history.entries.length === 1 && history.entries[0].source === 'external' && history.entries[0].operation === 'create_text', '操作与请求未关联')
    const detail = await call<HistoryDetail>('read_history', { libraryId: a.libraryId, id: history.entries[0].id })
    check(detail.entities[0]?.id === created.id, '历史影响身份错误')
    lib.win.webContents.send('menu:command', 'history')
    await until(() => lib.win.webContents.executeJavaScript(`document.querySelectorAll('.history-row').length >= 3`), '历史菜单未打开记录面板')
    await lib.win.webContents.executeJavaScript(`document.querySelector('.history-row').click()`)
    await until(() => lib.win.webContents.executeJavaScript(`document.querySelector('.history-detail')?.textContent.includes('app-undo-text')`), '历史详情未显示请求')
    await shot('operation-history.png', lib.win)
    await click('撤销上一步', lib.win)
    await until(async () => (await call<HistoryPage>('list_history', { libraryId: a.libraryId, requestId: disposable.requestId })).entries[0]?.state === 'undone', '面板撤销未生效')
    await click('重做下一步', lib.win)
    await until(async () => !(await call<ItemDetails>('read_item', { libraryId: a.libraryId, id: created.id })).deletedAt, '面板重做未生效')
    await click('撤销上一步', lib.win)
    check((await call<ItemDetails>('read_item', { libraryId: a.libraryId, id: created.id })).deletedAt != null, '撤销创建未送入仓库回收站')
    check((await call<OperationResult>('execute_operation', disposable)).replayed, '撤销后重试重复创建')
    check(!(await call<SearchPageResult>('search_items', { libraryId: a.libraryId, query: {} })).items.some(i => i.id === created.id), '回执重放恢复了已撤销素材')
    const afterReplay = await call<HistoryPage>('list_history', { libraryId: a.libraryId, requestId: disposable.requestId })
    check(afterReplay.entries.length === 1 && afterReplay.entries[0].state === 'undone', '回执重试重复记录历史')
    const purge = await call<{ previewToken: string }>('preview_item_lifecycle', { libraryId: a.libraryId, action: 'purge', ids: [created.id] })
    await denied('apply_item_lifecycle', { libraryId: a.libraryId, action: 'purge', ids: [created.id], previewToken: purge.previewToken, requestId: 'app-denied-purge' }, 'IRREVERSIBLE_DENIED')
    const lifecycle = await call<{ previewToken: string }>('preview_item_lifecycle', { libraryId: a.libraryId, action: 'restore', ids: [created.id] })
    await call('apply_item_lifecycle', { libraryId: a.libraryId, action: 'restore', ids: [created.id], previewToken: lifecycle.previewToken, requestId: 'app-history-restore' })
    check((await call<HistoryPage>('list_history', { libraryId: a.libraryId, requestId: 'app-history-restore' })).entries[0]?.source === 'external', '共享生命周期入口未标记外部调用')
    const extra = join(dir, 'extra-document.txt'); writeFileSync(extra, '历史导入来源')
    await call('import_to_library', { libraryId: a.libraryId, files: [{ path: extra }], requestId: 'app-history-import' })
    check((await call<HistoryPage>('list_history', { libraryId: a.libraryId, requestId: 'app-history-import' })).entries[0]?.source === 'external', '共享导入入口未标记外部调用')
    await shot('app-created-library.png', lib.win)

    const beforeCompact = await callCore(lib.core, 'listHistory')
    lib.win.webContents.send('menu:command', 'settings')
    await until(() => Promise.resolve(findSettingsSurface(lib.win)), '仓库设置窗口未打开')
    await click('数据与维护', settingsSurface(lib.win))
    await until(() => settingsJs(`!!document.querySelector('.database-maintenance button:last-child:not(:disabled)')`, lib.win), '数据库维护入口未就绪')
    await settingsJs(`document.querySelector('.database-maintenance').scrollIntoView({block:'center'})`, lib.win)
    await click('整理数据库', settingsSurface(lib.win))
    await until(() => settingsJs(`document.querySelector('.database-maintenance [role="status"]')?.textContent === '数据库已整理。'`, lib.win), '数据库整理未完成')
    check(JSON.stringify(await callCore(lib.core, 'listHistory')) === JSON.stringify(beforeCompact), '整理改变了当前历史')
    check((await call<OperationResult>('execute_operation', operation)).replayed, '整理丢失请求回执')
    await shot('database-maintenance.png', settingsSurface(lib.win))

    // 插件启停改变业务声明；stdio 连接和固定工具无需刷新。
    const disabled = (await callCore(lib.core, 'info')).disabledPlugins
    await callCore(lib.core, 'setPlugins', [...disabled, 'text']); await reloadLibrary(lib)
    await until(() => lib.win.webContents.executeJavaScript(`!!document.querySelector('.app')`), '重载后的页面未就绪')
    check(!(await call<LibraryDescription>('describe_library', { libraryId: a.libraryId })).operations.some(o => o.name === 'create_text'), '停用插件未收回操作')
    await denied('execute_operation', { ...operation, requestId: 'app-disabled-text' }, 'UNAVAILABLE_OPERATION')
    check(JSON.stringify((await client.listTools()).tools) === JSON.stringify(tools), '插件启停改变了固定工具')
    await callCore(lib.core, 'setPlugins', disabled); await reloadLibrary(lib)
    await until(() => lib.win.webContents.executeJavaScript(`!!document.querySelector('.app')`), '重载后的页面未就绪')
    check((await call<LibraryDescription>('describe_library', { libraryId: a.libraryId })).operations.some(o => o.name === 'create_text'), '重载后操作未恢复')
    writeFileSync(join(dir, 'app-mcp-state.json'), JSON.stringify({ libraryId: a.libraryId, textId: textId.id, operation }))
    for (const l of openLibraries()) l.win.close()
    await until(() => Promise.resolve(openLibraries().length === 0), '仓库窗口未关闭')
    await allClosed()
    check((await call<{ libraries: { open: boolean }[] }>('list_libraries')).libraries.every(l => !l.open), '关闭仓库后应用入口失效或状态错误')
    await denied('describe_library', { libraryId: a.libraryId }, 'LIBRARY_OFFLINE')
    await call('open_library', { libraryId: a.libraryId })
    check((await call<ContentChunk>('read_content', { libraryId: a.libraryId, id: textId.id, kind: 'text', field: 'content' })).text.includes('应用级素材'), '重新打开不能读取')
    writeFileSync(join(dir, 'app-mcp-result.json'), JSON.stringify({ ok: true }))
    console.log('[capture] 应用 MCP：零仓库入口、并发新建、两库授权隔离、文字与文件导入加工、搜索读取、撤销与回执、插件重载、关库后连接及重开通过')
  } catch (error) { console.error('[capture] appmcp FAILED', error); await shot('app-failed.png').catch(() => {}); process.exitCode = 1 }
  finally { await client?.close(); await transport?.close(); app.quit() }
}
