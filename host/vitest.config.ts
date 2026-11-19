import { generatePlugins } from './scripts/plugins/generate'
import { defineConfig } from 'vitest/config'
import { existsSync, readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import external from './tests/external-suites.json'
import { sdkSources } from './scripts/plugins/sdk'

// better-sqlite3 与 sharp 都是 N-API 模块，普通 Node 与 Electron 共用同一份二进制，
// 核心测试直接在 Node 中运行。
generatePlugins()

const selected = process.env.RM_TEST_EXTERNAL === '1'
const file = resolve(process.env.RM_PLUGIN_SOURCES ?? '.plugin-sources.local.json')
const sources = selected && existsSync(file) ? JSON.parse(readFileSync(file,'utf8')) as Record<string,string> : {}
export default defineConfig({
  resolve: { alias: { ...sdkSources(process.cwd()), ...Object.fromEntries(Object.entries(sources).map(([id,path])=>[`@test-plugins/${id}`,resolve(dirname(file),path)])) } },
  test: {
    include: selected ? external : ['tests/**/*.test.ts'],
    exclude: selected ? [] : external,
    environment: 'node',
    pool: 'forks',
    testTimeout: 60_000
  }
})
