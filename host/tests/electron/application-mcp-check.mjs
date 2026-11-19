// npm run build 后运行；只使用临时仓库、文件空间和独立应用配置，不要求业务插件包。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createWriteStream, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const dir = mkdtempSync(join(tmpdir(), 'rm-application-mcp-'))
console.log(dir)
const config = join(dir, 'offline.json')
const connection = { libraryId: 'old-library', mode: 'organize', token: 'test'.repeat(10), endpoint: process.platform === 'win32' ? `\\\\.\\pipe\\rm-missing-${process.pid}` : join(dir, 'missing.sock') }
const save = value => writeFileSync(config, JSON.stringify(value))
save(connection)
const client = new Client({ name: 'offline-protocol-check', version: '1.0.0' })
const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('out/main/mcp.js'), '--config', config], stderr: 'pipe' })
try {
  await client.connect(transport)
  const tools = (await client.listTools()).tools
  assert(tools.some(t => t.name === 'execute_operation'))
  assert(!tools.some(t => t.name === 'create_text'))
  for (const tool of tools) if (!['request_package_installation', 'get_package_installation', 'install_packages', 'list_allowed_file_spaces', 'list_libraries', 'create_library', 'list_ecosystem_catalog', 'preview_library_creation', 'get_library_creation', 'resume_library_creation', 'cancel_library_creation'].includes(tool.name)) assert(tool.inputSchema.required.includes('libraryId'), tool.name)
  assert(!client.getServerCapabilities().tools.listChanged)
  for (const [value, code] of [[connection, 'CONFIG_RETIRED'], [{ ...connection, libraryId: 'application', mode: 'off' }, 'ACCESS_DISABLED'], [{ ...connection, libraryId: 'application' }, 'LIBRARY_OFFLINE'], [{}, 'CONFIG_UNAVAILABLE']]) {
    save(value)
    const result = await client.callTool({ name: 'list_libraries', arguments: {} })
    assert(result.isError && JSON.stringify(result.content).includes(code), JSON.stringify(result))
    assert.deepEqual((await client.listTools()).tools, tools)
  }
} finally { await client.close(); await transport.close() }
console.log('stdio：离线工具发现、旧配置诊断、逐次读取配置通过')

for (const flow of ['appmcp', 'appmcpresume']) {
  const env = { ...process.env, RM_USER_DATA: join(dir, 'user-data'), CAPTURE_DIR: dir, CAPTURE_FLOW: flow }
  for (const key of ['LIBRARY_PATH', 'ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL']) delete env[key]
  const child = spawn(resolve('node_modules/.bin/electron'), ['.'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  const logFile = join(dir, `${flow}.log`), log = createWriteStream(logFile)
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false })
  const timer = setTimeout(() => child.kill('SIGTERM'), 120000)
  const [code] = await once(child, 'close'); clearTimeout(timer)
  log.end(); await once(log, 'finish')
  assert.equal(code, 0, readFileSync(logFile, 'utf8'))
  const resultFile = flow === 'appmcp' ? 'app-mcp-result.json' : 'app-mcp-resume-result.json'
  assert(existsSync(join(dir, resultFile)), readFileSync(logFile, 'utf8'))
  assert.equal(JSON.parse(readFileSync(join(dir, resultFile), 'utf8')).ok, true)
}
console.log('应用 MCP 与重启接续通过：' + dir)
