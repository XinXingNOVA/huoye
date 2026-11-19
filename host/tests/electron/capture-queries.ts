// 独立包 → Electron utilityProcess → 应用 MCP 真正 stdio；只使用临时仓库运行。
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport, type StdioServerParameters } from '@modelcontextprotocol/sdk/client/stdio.js'
import { libraryOf, reloadLibrary } from '../../src/main/libraries'
import { callCore } from '../../src/main/core-client'
import { selectCapturePackage } from '../../src/main/plugin-packages'
import { captureMcpSettings } from './capture-settings'
import type { PackagePreview } from '../../src/shared/external-plugins'
import type { QueryResponse } from '../../src/shared/business-queries'
import type { LibraryDescription } from '../../src/shared/automation'

export async function queriesFlow(win: BrowserWindow, dir: string) {
  const js = (code: string) => win.webContents.executeJavaScript(code)
  const lib = () => libraryOf(win.webContents)!
  const check = (ok: unknown, message: string) => { if (!ok) throw new Error(message) }
  const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
  const until = async (fn: () => Promise<unknown>, label: string) => {
    for (let i = 0; i < 150; i++) { if (await fn()) return; await wait(100) }
    throw new Error(label)
  }
  if (!process.env.PLUGIN_PACKAGE) throw new Error('需要 PLUGIN_PACKAGE 指向独立查询示例包')
  selectCapturePackage(process.env.PLUGIN_PACKAGE)
  const preview = await js('window.bridge.packages.pick()') as PackagePreview
  check(preview.items[0].manifest?.id === 'demo-query', '示例包不正确')
  await js(`window.bridge.packages.install(${JSON.stringify(preview.token)})`)
  const disabled = (await callCore(lib().core, 'plugins')).filter(p => !p.external && p.chosen).map(p => p.id)
  const apply = async (enabled: boolean) => {
    await js(`window.bridge.packages.apply(${JSON.stringify({ disabled, changes: [{ hash: preview.items[0].hash, enabled }] })})`)
    await reloadLibrary(lib())
    await until(() => js(`!!document.querySelector('.app-titlebar')`), '重载失败')
  }
  await apply(true)
  const path = join(dir, '查询验证.txt'); writeFileSync(path, '查询框架的真实导入正文')
  const [id] = await callCore(lib().core, 'ingest', [{ type: 'file', path }])
  const other = join(dir, '查询验证.md'); writeFileSync(other, '# 第二种格式')
  const [otherId] = await callCore(lib().core, 'ingest', [{ type: 'file', path: other }])
  await until(async () => !!(await callCore(lib().core, 'get', [id]))[0]?.blocks.body, '新文件正文未加工')
  await until(async () => (await callCore(lib().core, 'readItem', { id })).processing === 'idle' && (await callCore(lib().core, 'readItem', { id: otherId })).processing === 'idle', '新文件仍在加工')
  const config = await captureMcpSettings(win, 'read')
  const params = Object.values(JSON.parse(config.config).mcpServers)[0] as StdioServerParameters
  const client = new Client({ name: 'query-regression', version: '1.0.0' })
  const transport = new StdioClientTransport({ ...params, stderr: 'pipe' })
  try {
    await client.connect(transport)
    const call = async <T>(name: string, args: Record<string, unknown> = {}): Promise<T> => {
      const result = await client.callTool({ name, arguments: { libraryId: lib().id, ...args } })
      check(!result.isError, JSON.stringify(result.content)); return result.structuredContent as T
    }
    const denied = async (name: string, args: Record<string, unknown>, code: string) => {
      const result = await client.callTool({ name, arguments: { libraryId: lib().id, ...args } })
      check(result.isError && JSON.stringify(result.content).includes(code), `预期 ${code}: ${JSON.stringify(result)}`)
    }
    check((await client.listTools()).tools.some(t => t.name === 'execute_query' && t.annotations?.readOnlyHint), '没有只读工具')
    const description = await call<LibraryDescription>('describe_library')
    check(description.queries.some(q => q.name === 'demo-query.file_formats' && q.outputSchema && q.paginated), '查询契约缺失')
    check(description.operations.length === 0, '只读权限发布了写操作')
    const overview = await call<QueryResponse>('execute_query', { query: 'demo-query.overview' })
    check(overview.result.files === 2, '文件统计不正确')
    const first = await call<QueryResponse>('execute_query', { query: 'demo-query.file_formats', limit: 1 })
    check(first.result.total === 2 && first.result.nextCursor, '首屏分页不正确')
    const second = await call<QueryResponse>('execute_query', { query: 'demo-query.file_formats', limit: 1, cursor: first.result.nextCursor })
    check(second.result.nextCursor === null, '续页不正确')
    await denied('execute_operation', { operation: 'create_text', args: { text: '不该写入' }, requestId: 'query-read-only' }, 'READ_ONLY')
    await denied('execute_query', { query: 'demo-query.overview', args: { unexpected: true } }, 'INVALID_INPUT')
    await denied('execute_query', { libraryId: 'not-granted', query: 'demo-query.overview' }, 'ACCESS_DENIED')
    const third = join(dir, '第三个.txt'); writeFileSync(third, '变更让游标失效')
    await callCore(lib().core, 'ingest', [{ type: 'file', path: third }])
    await denied('execute_query', { query: 'demo-query.file_formats', limit: 1, cursor: first.result.nextCursor }, 'STALE_CURSOR')
    await apply(false)
    check((await call<LibraryDescription>('describe_library')).queries.length === 0, '停用后查询还在')
    await denied('execute_query', { query: 'demo-query.overview' }, 'UNAVAILABLE_QUERY')
    const content = await call<{ text: string }>('read_content', { id, kind: 'body', field: 'content' })
    check(content.text.includes('真实导入'), '停用后通用读失败')
    await captureMcpSettings(win, 'off')
    await denied('execute_query', { query: 'demo-query.overview' }, 'ACCESS_DENIED')
    writeFileSync(join(dir, 'query-result.json'), JSON.stringify({ passed: true, libraryId: lib().id, id, overview, first, second, checks: ['独立包安装与重载', '真实新文件加工', '发现契约', '只读查询与分页', '写入拒绝', '未授权拒绝', '游标失效', '停用撤下查询并保留通用读', '撤销授权'] }, null, 2))
    console.log('[capture] 业务只读查询与真实 stdio 验证通过')
  } finally { await client.close(); await transport.close() }
}
