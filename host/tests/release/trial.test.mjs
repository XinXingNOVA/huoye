import test from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, renameSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { unzipSync } from 'fflate'
import { pluginInventory, inventoryMarkdown } from '../../scripts/release/plugin-inventory.mjs'
import { runSteps, verifySource } from '../../scripts/release/build-trial.mjs'
import { releaseOptionalPlugins } from '../../scripts/release/optional-plugins.mjs'
const temporary = t => { const path = mkdtempSync(join(tmpdir(), 'rm-trial-test-')); t.after(() => rmSync(path, { recursive: true, force: true })); return path }
test('可选插件合集仅包含首版七个原包和安装说明，独立包与重复组装的 ZIP 字节一致', t => {
  const root = fileURLToPath(new URL('../..', import.meta.url))
  const first = releaseOptionalPlugins(root, temporary(t))
  const trial = releaseOptionalPlugins(root, temporary(t), 'optional-plugins')
  const archive = readFileSync(first.archive)
  assert.deepEqual(archive, readFileSync(trial.archive))
  const entries = unzipSync(archive)
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
  const prefix = `Huoye-${version}-plugins/`
  const files = ['epub', 'gallery', 'kanban', 'music', 'status', 'tag-tree', 'timeline'].map(id => id + '.hyplugin')
  assert.deepEqual(Object.keys(entries).sort(), [...files, '插件说明.md', 'LICENSE', 'THIRD-PARTY-NOTICES.md', 'OPTIONAL-PLUGIN-LICENSES.txt'].map(file => prefix + file).sort())
  for (const file of files) {
    const released = readFileSync(join(root, 'packaging/optional-plugins', file))
    assert.deepEqual(Buffer.from(entries[prefix + file]), released)
    assert.deepEqual(readFileSync(join(first.directory, file)), released)
  }
  assert.match(new TextDecoder().decode(entries[prefix + 'LICENSE']), /Apache License/)
  assert.match(new TextDecoder().decode(entries[prefix + 'OPTIONAL-PLUGIN-LICENSES.txt']), /@xmldom\/xmldom/)
  const mixed = temporary(t)
  cpSync(join(root, 'packaging'), join(mixed, 'packaging'), { recursive: true })
  cpSync(join(root, 'package.json'), join(mixed, 'package.json'))
  const legacy = join(mixed, 'packaging/optional-plugins/gallery.rmplugin')
  renameSync(join(mixed, 'packaging/optional-plugins/gallery.hyplugin'), legacy)
  assert.deepEqual(readFileSync(releaseOptionalPlugins(mixed, temporary(t)).archive), archive)
  cpSync(legacy, join(mixed, 'packaging/optional-plugins/gallery.hyplugin'))
  assert.throws(() => releaseOptionalPlugins(mixed, temporary(t)), /发行清单不一致/)

})
test('清单依据同一份发行策略生成，并阻止不完整的默认依赖组合', () => {
  const data = {
    'host/package.json': { version: '0.1.0' }, 'host/packaging/source-profile.json': { plugins: ['sample', 'other'] },
    'host/src/plugins/preview/plugin.json': { id: 'preview', title: '预览' },
    'host/src/plugins/preview/distribution.json': { defaultEnabled: true },
    'host/packaging/plugins/sample/plugin.json': { id: 'sample', title: '示例', requires: ['preview'] },
    'host/packaging/plugins/sample/distribution.json': { defaultEnabled: true },
    'plugins/sample/plugin.json': { id: 'sample', title: '示例', version: '1.2.3', requires: ['preview'], catalog: { usage: '右侧栏' } },
    'plugins/other/plugin.json': { id: 'other', title: '可选', version: '2.0.0' }
  }
  const read = path => data[path], paths = Object.keys(data), result = pluginInventory(read, paths)
  assert.equal(result.plugins.filter(p => p.bundled).length, 1)
  assert.match(inventoryMarkdown(result), /右侧栏/)
  data['host/src/plugins/preview/distribution.json'].defaultEnabled = false
  assert.throws(() => pluginInventory(read, paths), /默认组合/)
})
test('失败停在对应阶段、日志可定位，不继续打包；同一目录记录成功阶段', async t => {
  const dir = temporary(t), report = { status: 'running', steps: [] }, visited = []
  await assert.rejects(runSteps([{ id: 'install', name: '安装' }, { id: 'build', name: '构建' }, { id: 'package', name: '打包' }], dir, report, async (step, file) => {
    visited.push(step.id); writeFileSync(file, step.id)
    if (step.id === 'build') throw new Error('编译失败')
  }), /构建失败/)
  assert.deepEqual(visited, ['install', 'build'])
  const saved = JSON.parse(readFileSync(join(dir, 'build-result.json')))
  assert.equal(saved.status, 'failed'); assert.deepEqual(saved.steps.map(s => s.status), ['passed', 'failed'])
  assert.equal(readFileSync(join(dir, saved.steps[1].log), 'utf8'), 'build')
})
test('锁定源码被改动时，在安装和执行构建之前拒绝', t => {
  const dir = temporary(t), host = join(dir, 'host'); mkdirSync(host)
  const content = 'original'; writeFileSync(join(host, 'package.json'), content)
  writeFileSync(join(dir, 'source-manifest.json'), JSON.stringify({ files: [{ path: 'host/package.json', sha256: createHash('sha256').update(content).digest('hex') }] }))
  assert.equal(verifySource(host, {}).status, 'verified')
  writeFileSync(join(host, 'package.json'), 'changed')
  assert.throws(() => verifySource(host, {}), /交付清单不一致/)
})
