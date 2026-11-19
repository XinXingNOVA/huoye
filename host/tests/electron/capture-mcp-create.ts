import { openLibraryMcpSettings } from './settings-surface'
import { captureMcpSettings, scopedMcpCall, availableMcpOperations } from './capture-settings'
// AI 收录回归：真正的 stdio 客户端，独立临时仓库，重启后检查持久回执。
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport, type StdioServerParameters } from '@modelcontextprotocol/sdk/client/stdio.js'
import { libraryOf, reloadLibrary } from '../../src/main/libraries'
import { callCore } from '../../src/main/core-client'
import type { CoreApi } from '../../src/shared/rpc'
import type { ContentChunk, ItemDetails, OperationResult, SearchPageResult } from '../../src/shared/automation'
import type { IngestResult } from '../../src/plugin-api/operations'

const wait = (ms: number) => new Promise(r => setTimeout(r, ms))
interface Tools {
  js(code: string): Promise<any>
  log(label: string, value: unknown): void
  shot(name: string): Promise<void>
  click(selector: string, text: string): Promise<boolean>
}
interface Saved {
  textRequest: Record<string, unknown>; fileRequest: Record<string, unknown>
  textId: string; pdfId: string; fileResult: OperationResult
}
export async function mcpCreateFlow(win: BrowserWindow, dir: string, { js, log, shot, click }: Tools) {
  const lib = libraryOf(win.webContents)!
  const core = <K extends keyof CoreApi>(method: K, ...args: Parameters<CoreApi[K]>) => callCore(lib.core, method, ...args)
  const check = (ok: unknown, message: string) => { if (!ok) throw new Error(message) }
  const mode = async (value: string) => {
    await captureMcpSettings(win, value as 'off' | 'read' | 'organize')
    await wait(250)
  }
  const ui = await openLibraryMcpSettings(win)
  const resume = process.env.CAPTURE_FLOW === 'mcpcreateresume'
  if (!resume) await mode('read')
  await ui.webContents.executeJavaScript(`[...document.querySelectorAll('.mcp-connection button')].find(b => b.textContent === '查看配置').click()`)
  const params = Object.values(JSON.parse(await ui.webContents.executeJavaScript(`document.querySelector('.mcp-config').value`)).mcpServers)[0] as StdioServerParameters
  ui.close()
  const client = new Client({ name: 'resource-manager-create-integration', version: '1.0.0' })
  const transport = new StdioClientTransport({ ...params, stderr: 'pipe' })
  let stderr = ''; transport.stderr?.on('data', data => { stderr += String(data) })
  const call = async <T>(name: string, args: Record<string, unknown> = {}): Promise<T> => {
    const result = await scopedMcpCall(client, lib.id, { name, arguments: args })
    check(!result.isError, JSON.stringify(result.content))
    return result.structuredContent as T
  }
  const error = async (name: string, args: Record<string, unknown>, code: string) => {
    const result = await scopedMcpCall(client, lib.id, { name, arguments: args })
    check(result.isError && JSON.stringify(result.content).includes(code), `未拒绝 ${name}: ${JSON.stringify(result)}`)
  }
  const stateFile = join(dir, 'mcp-create-state.json')
  try {
    await client.connect(transport)
    if (resume) {
      const state = JSON.parse(readFileSync(stateFile, 'utf8')) as Saved
      check((await call<OperationResult>('create_text', state.textRequest)).replayed, '文字重启丢失回执')
      const again = await call<OperationResult>('import_files', state.fileRequest)
      check(again.replayed && JSON.stringify(again.result) === JSON.stringify(state.fileResult.result), '文件重启丢失原回执')
      check((await call<ContentChunk>('read_content', { id: state.pdfId, kind: 'pdftext', field: 'content', page: 2 })).text.includes('aiimportneedle'), '重启后正文丢失')
      check((await call<ItemDetails>('read_item', { id: state.textId })).deletedAt, '重启重试把已撤销文字恢复了')
      check((await core('query', { has: ['file'] })).ids.length === 2, '重启后文件被重复收录')
      log('MCP 创建与收录：重启、持久回执、删除后不重建、PDF 正文通过', { stderr })
      return
    }
    check((await availableMcpOperations(client, lib.id)).length === 0, '只读连接暴露写操作')
    const textRequest = { requestId: 'capture-create-text', content: '# AI 收录演示\n\n这份摘要通过 MCP 直接保存。', tags: ['AI 创建', '资料'], source: { url: 'https://example.com/article', title: '示例来源' } }
    await error('create_text', textRequest, 'READ_ONLY')
    await error('import_files', { requestId: 'capture-denied-import', paths: [join(dir, 'not-read.txt')] }, 'READ_ONLY')
    await mode('organize')
    const names = (await availableMcpOperations(client, lib.id)).map(t => t.name)
    check(names.includes('create_text') && names.includes('import_files'), '没有发布创建／收录工具')
    const created = await call<OperationResult>('create_text', textRequest)
    const textId = (created.result as { id: string }).id
    check((await call<SearchPageResult>('search_items', { query: { search: [{ kind: 'text', text: '摘要' }] } })).items[0]?.id === textId, '新文字无法搜索')
    check((await call<ContentChunk>('read_content', { id: textId, kind: 'tags', field: 'values' })).text.includes('AI 创建'), '创建未保存标签')
    check((await call<ContentChunk>('read_content', { id: textId, kind: 'source', field: 'url' })).text === textRequest.source.url, '创建未保存来源')
    await error('create_text', { ...textRequest, content: '不能复用此 ID' }, 'REQUEST_ID_CONFLICT')
    await click('.sidebar .nav-item', '全部'); await wait(400)
    check(await js(`!!document.querySelector('[data-entity-id="${textId}"]')`), 'MCP 创建未自动出现在界面')
    await shot('mcp-create-1-text.png')
    check((await core('undo'))?.includes('外部 · 新建文字'), '文字创建没有撤销')
    check((await call<OperationResult>('create_text', textRequest)).replayed, '文字重试没有回执')
    check((await call<ItemDetails>('read_item', { id: textId })).deletedAt, '重试恢复了撤销的文字')
    check((await call<ContentChunk>('read_content', { id: textId, kind: 'text', field: 'content' })).text === textRequest.content, '撤销清空了回收站文字')
    await core('redo')

    const cups = ['/usr/sbin/cupsfilter', '/usr/bin/cupsfilter'].find(existsSync)
    check(cups, '缺少 PDF 测试生成器')
    const path = join(dir, 'AI 指定文本.txt'), pdf = join(dir, 'AI 指定文档.pdf')
    writeFileSync(path, 'First page\fSecond page aiimportneedle')
    writeFileSync(pdf, execFileSync(cups!, ['-m', 'application/pdf', path], { stdio: ['ignore', 'pipe', 'ignore'] }))
    const fileRequest = { requestId: 'capture-import-files', paths: [pdf, path, pdf, dir, join(dir, 'missing.pdf')] }
    const [fileResult, duplicate] = await Promise.all([call<OperationResult>('import_files', fileRequest), call<OperationResult>('import_files', fileRequest)])
    check(fileResult.replayed !== duplicate.replayed && JSON.stringify(fileResult.result) === JSON.stringify(duplicate.result), '并发重试不一致')
    const result = fileResult.result as IngestResult
    check(result.items.length === 3 && result.errors.length === 2 && result.items[2].outcome === 'existing', '逐项结果错误')
    const pdfId = result.items[0].id
    for (let i = 0; i < 100; i++) {
      const item = await call<ItemDetails>('read_item', { id: pdfId })
      check(!Object.keys(item.failures).length, `新 PDF 加工失败：${JSON.stringify(item.failures)}`)
      if (item.processing === 'idle' && item.fields.some(f => f.kind === 'pdftext')) break
      await wait(150)
    }
    check((await call<ContentChunk>('read_content', { id: pdfId, kind: 'pdftext', field: 'content', page: 2 })).text.includes('aiimportneedle'), '真实 Electron PDF 正文提取／按页读取失败')
    check((await call<SearchPageResult>('search_items', { query: { search: [{ kind: 'pdftext', text: 'aiimportneedle' }] } })).items[0]?.id === pdfId, '新 PDF 正文不可搜索')
    const view = (await core('get', [pdfId]))[0]
    check(readFileSync(join(lib.root, String(view.blocks.file.data.path))).equals(readFileSync(pdf)), '收录改变原文件字节')
    await wait(300)
    check(await js(`!!document.querySelector('[data-entity-id="${pdfId}"]')`), 'MCP 导入未刷新界面')
    await shot('mcp-create-2-files.png')
    check((await core('undo'))?.includes('外部 · 收录'), '未记录批量导入撤销')
    check((await call<ItemDetails>('read_item', { id: pdfId })).deletedAt, '撤销未覆盖导入')
    check((await core('get', [pdfId]))[0].blocks.file, '撤销丢失原文件索引')
    check((await call<OperationResult>('import_files', fileRequest)).replayed, '撤销后重试未复用回执')
    check((await call<ItemDetails>('read_item', { id: pdfId })).deletedAt, '重试复活了撤销的文件')
    await core('redo')
    const restored = await call<OperationResult>('import_files', { requestId: 'capture-existing', paths: [pdf] })
    check((restored.result as IngestResult).items[0].outcome === 'existing', '新请求没有按内容去重')
    await call<OperationResult>('update_tags', { requestId: 'capture-new-file-tags', ids: [pdfId], add: ['AI 收录'] })
    check((await call<ContentChunk>('read_content', { id: pdfId, kind: 'tags', field: 'values' })).text.includes('AI 收录'), '新导入不能打标签')
    log('MCP 创建与收录：权限、并发重试、逐项失败、撤销、界面同步、新 PDF 加工与搜索通过', { pdfId, result })

    // 把文字删除作为最终状态：重启回执不能把它重新创建。
    await core('trash', [textId])
    await core('setPlugins', ['text'])
    await reloadLibrary(lib); await wait(700)
    check(!(await availableMcpOperations(client, lib.id)).some(t => t.name === 'create_text'), '停用文字未收回工具')
    await error('create_text', { requestId: 'capture-disabled-text', content: '拒绝' }, 'UNAVAILABLE_OPERATION')
    check((await availableMcpOperations(client, lib.id)).some(t => t.name === 'import_files'), '停用文字影响基础文件导入')
    await core('setPlugins', [])
    await reloadLibrary(lib); await wait(700)
    writeFileSync(stateFile, JSON.stringify({ textRequest, fileRequest, textId, pdfId, fileResult } satisfies Saved))
    const settingsWindow = await openLibraryMcpSettings(win)
    settingsWindow.setSize(960, 720); await wait(300)
    writeFileSync(join(dir, 'mcp-create-3-settings.png'), (await settingsWindow.webContents.capturePage()).toPNG())
    log('MCP 创建与收录：插件启停与设置通过', { tools: (await availableMcpOperations(client, lib.id)).map(t => t.name), stderr })
  } finally { await client.close(); await transport.close() }
}
