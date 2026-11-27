/** 独立插件工程入口；只生成本机 SDK 路径，不引入宿主私有模块。 */
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { packPlugin } from './pack.ts'
import { startPluginDevelopment } from './dev.ts'
import { sdkSources } from './sdk.ts'

const [action, directory] = process.argv.slice(2)
if (!directory || !['configure', 'check', 'pack', 'dev'].includes(action)) throw new Error('用法：project.ts <configure|check|pack|dev> <插件目录>')
const root = resolve(directory), host = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const id = JSON.parse(readFileSync(join(root, 'plugin.json'), 'utf8')).id
if (typeof id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(id)) throw new Error('无效插件 ID')
const paths = {
  '@huoye/provider-sdk': [join(host, 'packages/provider-sdk/index.d.ts')],
  ...Object.fromEntries(Object.entries(sdkSources(host)).map(([name, path]) => [name, [path]])),
  react: [join(host, 'node_modules/@types/react/index.d.ts')],
  'react/*': [join(host, 'node_modules/@types/react/*')],
  'react-dom': [join(host, 'node_modules/@types/react-dom/index.d.ts')],
  zod: [join(host, 'node_modules/zod/index.d.cts')]
}
writeFileSync(join(root, '.rm-sdk.json'), JSON.stringify({ compilerOptions: { paths } }, null, 2) + '\n')
if (action === 'configure') console.log(`${id} 编辑器 SDK 已配置`)
else if (action === 'check') {
  const temp = mkdtempSync(join(tmpdir(), 'rm-plugin-check-'))
  try { await packPlugin(root, join(temp, 'check.hyplugin')); console.log(`${id} 检查通过`) }
  finally { rmSync(temp, { recursive: true, force: true }) }
} else if (action === 'pack') console.log(await packPlugin(root, join(root, 'artifacts', `${id}.hyplugin`)))
else {
  const watcher = await startPluginDevelopment(root, join(root, '.build-cache', `${id}.hyplugin`))
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void watcher.close() })
}
