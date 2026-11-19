import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const host = fileURLToPath(new URL('../..', import.meta.url))
let args
if (process.argv[2] === 'types') {
  const file = resolve(process.env.RM_PLUGIN_SOURCES ?? resolve(host, '.plugin-sources.local.json'))
  const sources = JSON.parse(readFileSync(file, 'utf8'))
  const base = JSON.parse(readFileSync(resolve(host, 'tsconfig.node.json'), 'utf8'))
  const suites = JSON.parse(readFileSync(resolve(host, 'tests/external-suites.json'), 'utf8'))
  const paths = Object.fromEntries(Object.entries(base.compilerOptions.paths).map(([key, values]) => [key, values.map(p => resolve(host, p))]))
  for (const [id, source] of Object.entries(sources)) paths[`@test-plugins/${id}/*`] = [resolve(dirname(file), source) + '/*']
  const config = {
    extends: '../tsconfig.node.json',
    compilerOptions: { lib: ['ES2023', 'DOM', 'DOM.Iterable'], paths },
    include: [...suites, 'src/plugins/**/*.d.ts', 'tests/electron/epub-prepare.ts', 'tests/electron/selection-prepare.ts'].map(p => resolve(host, p)),
    exclude: []
  }
  const output = resolve(host, '.local/tsconfig.plugins.json')
  mkdirSync(dirname(output), { recursive: true })
  writeFileSync(output, JSON.stringify(config, null, 2) + '\n')
  args = [resolve(host, 'node_modules/typescript/bin/tsc'), '--noEmit', '-p', output]
} else {
  args = [resolve(host, 'node_modules/vitest/vitest.mjs'), 'run', ...process.argv.slice(2)]
}
const result = spawnSync(process.execPath, args, { cwd: host, stdio: 'inherit', env: { ...process.env, RM_TEST_EXTERNAL: '1' } })
if (result.error) throw result.error
process.exitCode = result.status ?? 1
