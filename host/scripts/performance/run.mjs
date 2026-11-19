// 可重复的应用基准。只创建新临时库；不接受用户仓库路径。
import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { cpus, totalmem, tmpdir, homedir, release } from 'node:os'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { summarize, markdown, timingSamples } from './report.mjs'

assert.equal(process.platform, 'darwin', '此轮应用基准包含真实废纸篓测量，当前仅支持 macOS；Windows 待实现测试包的精确清理')
const { values } = parseArgs({ options: { counts: { type: 'string', default: '1000,10000' }, spaces: { type: 'string', default: '1,3' },
  'startup-runs': { type: 'string', default: '3' }, samples: { type: 'string', default: '5' }, daily: { type: 'boolean', default: false }, 'clear-search': { type: 'boolean', default: false }, 'skip-build': { type: 'boolean', default: false } } })
assert(!(values.daily && values['clear-search']), '日用与清空搜索是两个独立场景')
const phaseName = values.daily ? 'daily' : values['clear-search'] ? 'clear-search' : 'operations'
const integers = (s, allowed) => s.split(',').map(Number).map(n => { assert(Number.isInteger(n) && allowed(n), '无效基准参数'); return n })
const counts = integers(values.counts, n => n >= 40 && n <= 100000), spaces = integers(values.spaces, n => [1, 3].includes(n))
const scalar = value => { const list = integers(value, n => n >= 1 && n <= 20); assert.equal(list.length, 1, '重复次数只接受单个整数'); return list[0] }
const startupRuns = scalar(values['startup-runs']), samples = scalar(values.samples)
assert.equal(new Set(counts).size, counts.length, '规模不能重复'); assert.equal(new Set(spaces).size, spaces.length, '空间数不能重复')
const temp = mkdtempSync(join(tmpdir(), 'rm-performance-'))
const parent = resolve('artifacts/performance'); mkdirSync(parent, { recursive: true })
const output = mkdtempSync(join(parent, new Date().toISOString().replace(/[:.]/g, '-') + '-'))
console.log('结果目录：' + output); console.log('临时仓库：' + temp)
const run = async (command, args, env, logPath, timeout = 900000) => {
  const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] }), log = createWriteStream(logPath)
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false }); child.stdout.pipe(process.stdout)
  let forceTimer
  const timer = setTimeout(() => { child.kill('SIGTERM'); forceTimer = setTimeout(() => child.kill('SIGKILL'), 5000) }, timeout)
  try {
    const [code] = await once(child, 'close')
    await new Promise(resolve => log.end(resolve))
    assert.equal(code, 0, readFileSync(logPath, 'utf8').slice(-5000))
  } finally { clearTimeout(timer); clearTimeout(forceTimer); log.end() }
}
let buildMs = null
if (!values['skip-build']) {
  const start = performance.now()
  await run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], process.env, join(output, 'build.log'))
  buildMs = performance.now() - start
}
assert(existsSync(resolve('out/main/index.js')), '请先 npm run build')
const digest = createHash('sha256')
for (const dir of ['out/main', 'out/preload', 'out/renderer']) {
  const walk = p => { for (const e of readdirSync(p, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(p, e.name); if (e.isDirectory()) walk(path); else { digest.update(path); digest.update(readFileSync(path)) }
  } }; walk(dir)
}
const report = { format: 1, harness: values.daily ? 'daily-1' : values['clear-search'] ? 'clear-search-1' : 1, complete: false, createdAt: new Date().toISOString(), buildMs, temp,
  source: { commit: execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim(), dirty: !!execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim(), buildHash: digest.digest('hex') },
  environment: { platform: process.platform, arch: process.arch, os: release(), cpu: cpus()[0].model, logicalCpus: cpus().length, memoryGB: totalmem() / 1024 ** 3, node: process.version },
  options: { counts, spaces, startupRuns, ...(values.daily ? { imported: 50 } : { samples }) }, cases: [] }
writeFileSync(join(output, 'run.json'), JSON.stringify(report, null, 2))
const helper = resolve('artifacts/checks/performance-prepare.cjs'); mkdirSync(resolve('artifacts/checks'), { recursive: true })
await build({ entryPoints: ['tests/performance/fixture.ts'], outfile: helper, bundle: true, platform: 'node', format: 'cjs', target: 'node24', packages: 'external', define: { 'import.meta.url': JSON.stringify(pathToFileURL(helper).href) } })
const recoverOwnPackages = fixture => {
  if (process.platform !== 'darwin') return
  for (const info of fixture.spaces) {
    const db = new Database(join(info.root, '.file-space.db'), { readonly: true, fileMustExist: true })
    try {
      assert.equal(db.prepare('SELECT id FROM space').pluck().get(), info.id)
      for (const job of db.prepare('SELECT file_id,bundle FROM space_disposals').all()) {
        const source = join(homedir(), '.Trash', basename(job.bundle))
        if (!existsSync(source)) continue
        const manifest = JSON.parse(readFileSync(join(source, 'file-space-recovery.json'), 'utf8'))
        assert.equal(manifest.fileId, job.file_id); assert.equal(manifest.spaceId, info.id)
        renameSync(source, join(temp, 'recovered-' + basename(job.bundle)))
      }
    } finally { db.close() }
  }
}
for (const count of counts) for (const spaceCount of spaces) {
  const dir = join(temp, `${count}-${spaceCount}`); mkdirSync(dir)
  writeFileSync(join(dir, 'benchmark-owned.json'), JSON.stringify({ count, spaces: spaceCount }))
  console.log(`[benchmark] prepare ${count} items / ${spaceCount} spaces`)
  await run(process.execPath, [helper, dir, String(count), String(spaceCount)], process.env, join(output, `${count}-${spaceCount}-prepare.log`), 1800000)
  const fixture = JSON.parse(readFileSync(join(dir, 'fixture.json'), 'utf8')), runs = []
  try {
    for (const [index, phase] of [...Array(startupRuns).fill('startup'), phaseName].entries()) {
      const resultPath = join(output, `${count}-${spaceCount}-${phase}-${index}.json`), log = resultPath + '.log'
      const env = { ...process.env, LIBRARY_PATH: fixture.root, RM_USER_DATA: fixture.userData, CAPTURE_DIR: dir, CAPTURE_FLOW: 'performance',
        RM_BENCH_FIXTURE: join(dir, 'fixture.json'), RM_BENCH_PHASE: phase, RM_BENCH_RESULT: resultPath, RM_BENCH_SAMPLES: String(samples), RM_BENCH_SPAWN_MS: String(Date.now()) }
      delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
      await run(resolve('node_modules/.bin/electron' + (process.platform === 'win32' ? '.cmd' : '')), ['.'], env, log)
      assert(existsSync(resultPath), existsSync(resultPath + '.error') ? readFileSync(resultPath + '.error', 'utf8') : readFileSync(log, 'utf8'))
      const value = JSON.parse(readFileSync(resultPath, 'utf8')); assert.equal(value.count, count); assert(value.launchToFirstGridMs > 0)
      runs.push(value); console.log(`[benchmark] ${count}/${spaceCount} ${phase}: first grid ${value.launchToFirstGridMs} ms`)
    }
  } finally { if (phaseName === 'operations') recoverOwnPackages(fixture) }
  report.cases.push({ count, spaces: spaceCount, setupMs: fixture.setupMs, originalBytes: fixture.uniqueBytes, plugins: fixture.pluginVersions,
    runtime: { electron: runs[0].electron, chrome: runs[0].chrome }, enabledPlugins: runs[0].plugins.filter(p => p.enabled).map(p => p.id),
    metrics: summarize(runs), timingSamples: timingSamples(runs), memory: runs.flatMap((r, runIndex) => r.memory.map(m => ({ phase: r.phase, runIndex, ...m }))),
    ...(values.daily ? { daily: runs.at(-1).daily } : {}), ...(values['clear-search'] ? { clearSearch: runs.at(-1).clearSearch } : {}) })
  writeFileSync(join(output, 'summary.json'), JSON.stringify(report, null, 2))
  if (phaseName === 'operations') writeFileSync(join(output, 'report.md'), markdown(report))
}
report.complete = true
writeFileSync(join(output, 'summary.json'), JSON.stringify(report, null, 2))
console.log('基准完成：' + join(output, phaseName === 'operations' ? 'report.md' : 'summary.json'))
