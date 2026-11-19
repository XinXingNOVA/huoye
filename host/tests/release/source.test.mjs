import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { exportSources, lockSources, validateFiles } from '../../scripts/release/source.mjs'

const tool = fileURLToPath(new URL('../../scripts/release/source.mjs', import.meta.url))
const sha = data => createHash('sha256').update(data).digest('hex')
function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), 'rm-source-test-'))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const git = (dir, ...args) => execFileSync('git', ['-C', join(base, dir), ...args], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' } }).trim()
  const write = (path, data) => { mkdirSync(dirname(join(base, path)), { recursive: true }); writeFileSync(join(base, path), typeof data === 'string' ? data : JSON.stringify(data)) }
  for (const dir of ['host', 'plug']) { mkdirSync(join(base, dir)); git(dir, 'init', '-q') }
  write('host/package.json', { name: 'host', version: '0.1.0', license: 'Apache-2.0' })
  write('host/packaging/source-profile.json', { version: 1, license: 'Apache-2.0', plugins: ['sample'], hostExclude: ['private.md'] })
  write('host/packaging/source-public/README.md', '# Public\n\n[Host](host/package.json)\n')
  write('host/packaging/source-public/LICENSE', readFileSync(new URL('../../LICENSE', import.meta.url), 'utf8'))
  write('host/private.md', 'internal only')
  write('host/.local/config.json', 'personal setting')
  write('host/package-lock.json', { packages: { 'node_modules/a': { version: '1.0.0', integrity: 'test', resolved: 'https://registry.npmmirror.com/a/-/a-1.0.0.tgz' } } })
  write('host/scripts/release/source.mjs', readFileSync(tool, 'utf8'))
  write('host/scripts/release/plugin-inventory.mjs', readFileSync(new URL('../../scripts/release/plugin-inventory.mjs', import.meta.url), 'utf8'))
  write('plug/plugin.json', { id: 'sample', version: '1.0.0' })
  write('plug/core.ts', 'export const value = 1\n')
  write('plug/vendor/contract-1.0.0.tgz', 'synthetic package bytes')
  write('plug/package-lock.json', { packages: { 'node_modules/contract': { resolved: 'file:vendor/contract-1.0.0.tgz', integrity: 'sha512-' + createHash('sha512').update('synthetic package bytes').digest('base64') } } })
  for (const dir of ['host', 'plug']) { git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'fixture') }
  write('sources.json', { host: { path: './host' }, plugins: { sample: { path: './plug' } } })
  return { base, git, write, lock: join(base, 'lock.json') }
}
test('固定提交、公开改写、清单和 ZIP 可重建，不读取后来的工作区修改', t => {
  const f = fixture(t), lock = lockSources(join(f.base, 'sources.json'), f.lock)
  f.write('plug/core.ts', 'not committed'); f.write('host/.env', 'untracked private setting')
  const one = join(f.base, 'one'), two = join(f.base, 'two')
  exportSources(f.lock, one); exportSources(f.lock, two)
  assert.equal(sha(readFileSync(join(one, 'source.zip'))), sha(readFileSync(join(two, 'source.zip'))))
  const manifest = JSON.parse(readFileSync(join(one, 'source-manifest.json')))
  assert.equal(manifest.license, 'Apache-2.0')
  assert.equal(manifest.status, 'source-snapshot')
  assert.equal(readFileSync(join(one, 'source/plugins/sample/LICENSE'), 'utf8'), readFileSync(join(one, 'source/LICENSE'), 'utf8'))
  assert.equal(manifest.plugins[0].commit, lock.plugins[0].commit)
  assert(!JSON.stringify(manifest).includes(f.base))
  for (const file of manifest.files) assert.equal(sha(readFileSync(join(one, 'source', file.path))), file.sha256)
  for (const path of ['host/.local', 'host/private.md', 'host/.env', 'host/.git']) assert(!existsSync(join(one, 'source', path)))
  assert.equal(readFileSync(join(one, 'source/plugins/sample/core.ts'), 'utf8'), 'export const value = 1\n')
  assert.equal(readFileSync(join(one, 'source/host/scripts/release/source.mjs'), 'utf8'), readFileSync(tool, 'utf8'))
  const pkg = JSON.parse(readFileSync(join(one, 'source/host/package-lock.json'))).packages['node_modules/a']
  assert.equal(pkg.resolved, 'https://registry.npmjs.org/a/-/a-1.0.0.tgz'); assert.equal(pkg.integrity, 'test')
  assert.throws(() => exportSources(f.lock, one), /已存在/)
  assert.throws(() => lockSources(join(f.base, 'sources.json'), join(f.base, 'new-lock.json')), /未提交/)
})
test('有问题的已提交来源拒绝输出，既有产物与来源保持不变', t => {
  const f = fixture(t)
  f.write('plug/leak.md', '/Users/' + 'private-name/document')
  f.git('plug', 'add', '.'); f.git('plug', 'commit', '-qm', 'bad source')
  lockSources(join(f.base, 'sources.json'), f.lock)
  const out = join(f.base, 'blocked')
  assert.throws(() => exportSources(f.lock, out), /个人路径/)
  assert(!existsSync(out)); assert(existsSync(join(f.base, 'plug/leak.md')))
  const lock = JSON.parse(readFileSync(f.lock)); lock.toolHash = '0'.repeat(64); f.write('tampered.json', lock)
  assert.throws(() => exportSources(join(f.base, 'tampered.json'), out), /锁定宿主/)
})
test('拒绝失效链接、大小写冲突及跨平台危险路径', () => {
  const files = paths => new Map(paths.map(([path, text]) => [path, { data: Buffer.from(text), mode: '100644' }]))
  assert.throws(() => validateFiles(files([['README.md', '[lost](missing.md)']])), /失效/)
  assert.doesNotThrow(() => validateFiles(files([['README.md', '[examples](host/examples/)'], ['host/examples/demo.ts', '']])) )
  assert.throws(() => validateFiles(files([['README.md', '<picture><source srcset="missing.svg" /></picture>']])), /失效/)
  assert.throws(() => validateFiles(files([['a.ts', ''], ['A.ts', '']])), /冲突/)
  assert.throws(() => validateFiles(files([['../escape', '']])), /不可移植/)
  assert.throws(() => validateFiles(files([['con.txt', '']])), /不可移植/)
})

test('本地类型归档必须随工程输出且与锁文件一致，不允许外部文件路径', () => {
  const make = resolved => new Map([['plugins/example/package-lock.json', { mode: '100644', data: Buffer.from(JSON.stringify({ packages: { dep: { resolved, integrity: 'sha512-bad' } } })) }]])
  assert.throws(() => validateFiles(make('file:../other.tgz')), /工程内/)
  assert.throws(() => validateFiles(make('file:vendor/missing.tgz')), /归档缺失/)
  const wrong = make('file:vendor/wrong.tgz')
  wrong.set('plugins/example/vendor/wrong.tgz', { mode: '100644', data: Buffer.from('wrong') })
  assert.throws(() => validateFiles(wrong), /完整性不匹配/)
})
