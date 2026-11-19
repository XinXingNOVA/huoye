import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { cpSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'rm-development-directory-')))
const source = join(dir, 'sources', 'demo'); mkdirSync(join(dir, 'sources')); cpSync('examples/local-plugin', source, { recursive: true })
execFileSync(process.execPath, ['scripts/plugins/pack.ts', source, join(dir, 'formal.rmplugin')], { stdio: 'inherit' })
const ui = join(source, 'ui.tsx'); writeFileSync(ui, readFileSync(ui, 'utf8').replace('独立插件验证', '目录开发一'))
const other = join(dir, 'sources', 'other'); mkdirSync(other)
writeFileSync(join(other, 'plugin.json'), JSON.stringify({ id: 'demo-other', title: '第二个开发插件', description: '批量启停验证', author: 'test', version: '1.0.0', apiVersion: 1, entries: { ui: './ui.tsx' } }))
writeFileSync(join(other, 'ui.tsx'), "export const plugin={id:'demo-other'}")
console.log('临时目录：' + dir)
for (const flow of ['developmentdirectory', 'developmentdirectoryresume']) {
  if (flow.endsWith('resume')) writeFileSync(ui, readFileSync(ui, 'utf8').replace('目录开发二', '目录开发三'))
  const env = { ...process.env, LIBRARY_PATH: join(dir, 'A.library'), RM_USER_DATA: join(dir, 'user-data'), CAPTURE_DIR: dir, CAPTURE_FLOW: flow }
  delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
  const child = spawn(resolve('node_modules/.bin/electron'), ['.'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  const logPath = join(dir, flow + '.log'), log = createWriteStream(logPath)
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false })
  const timer = setTimeout(() => child.kill('SIGTERM'), 180000)
  const [code] = await once(child, 'close'); clearTimeout(timer); await new Promise(resolve => log.end(resolve))
  assert.equal(code, 0, readFileSync(logPath, 'utf8'))
  assert(existsSync(join(dir, flow + '-result.json')), readFileSync(logPath, 'utf8'))
}
console.log('目录开发模式真实界面及重启验证通过：' + dir)
