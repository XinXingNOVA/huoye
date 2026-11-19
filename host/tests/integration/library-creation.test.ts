import { afterEach, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { PresetCatalog } from '../../src/plugin-packages/preset-catalog'
import { SuiteCatalog } from '../../src/plugin-packages/suites'
import { encodePackage, decodePackage } from '../../src/plugin-packages/archive'
import { packageManifestSchema } from '../../src/shared/external-plugins'
import { suiteManifestSchema } from '../../src/shared/plugin-suites'
import { openLibrary } from '../../src/core/library'
import { initializeCreatedLibrary } from '../../src/core/library-initialization'
import { readBindings, readDisabled, setPluginSettings } from '../../src/core/external-plugins'
import { LibraryCreations } from '../../src/main/library-creation-state'
import type { PluginInfo } from '../../src/shared/plugin-plan'
import type { PluginDistribution } from '../../src/shared/plugin-distribution'

const dirs: string[] = []
const temp = () => { const dir = realpathSync(mkdtempSync(join(tmpdir(), 'rm-create-test-'))); dirs.push(dir); return dir }
afterEach(() => dirs.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })))
const builtin: PluginInfo[] = [{ id: 'file', title: '文件', description: '', required: true }, { id: 'text', title: '文字', description: '' }]
const distribution: PluginDistribution[] = [{ id: 'text', title: '文字', group: 'base', origin: 'builtin', defaultEnabled: true }, { id: 'reader', title: '阅读', group: 'common', origin: 'bundled', defaultEnabled: true }]
const pack = (id: string, version = '1.0.0', requires: string[] = []) => {
  const p = decodePackage(encodePackage(packageManifestSchema.parse({ formatVersion: 1, apiVersion: 1, id, title: id, version, author: 'test', description: '', requires, entries: { ui: 'ui.mjs' } }), new Map([['ui.mjs', Buffer.from('throw new Error("must not execute")')]])))
  return { manifest: p.manifest, hash: p.hash }
}
it('创建前预演共用套件与用户方案，核对修订和版本，显式方案不叠加发行默认', () => {
  const dir = temp(), catalog = new PresetCatalog(dir), a = pack('reader'), b = pack('reader','2.0.0'), other = pack('unrelated')
  const user = catalog.users.save('阅读', [{ id: 'reader', title: '阅读' }])
  const input = { id: user.id, revision: user.revision }
  const ambiguous = catalog.previewNew(input, builtin, distribution, [a,b,other], [a])
  expect(ambiguous.issues.join()).toContain('多个已安装版本')
  expect(ambiguous.versions[0].choices).toHaveLength(2)
  const selected = catalog.previewNew({ ...input, versions: [{ id: 'reader', hash: b.hash, enabled: true }] }, builtin, distribution, [a,b,other], [a])
  expect(selected.issues).toEqual([])
  expect(selected.selection).toEqual({ disabled: ['text'], external: [{ id: 'reader', hash: b.hash, enabled: true }] })
  expect(() => catalog.previewNew({ ...input, versions: [{ id: 'unrelated', hash: other.hash, enabled: true }] }, builtin, distribution, [a,b,other], [a])).toThrow('之外')
  expect(catalog.previewNew(undefined,builtin,distribution,[a,b], [a]).selection.external[0].hash).toBe(a.hash)
  const exact = suiteManifestSchema.parse({ formatVersion: 1, id: 'study', title: '学习', description: '', version: '1.0.0', packages: [{ file: 'reader.rmplugin', id: 'reader', version: '1.0.0', hash: a.hash }], presets: [{ id: 'read', title: '读', plugins: [{ id: 'reader', title: '阅读', hash: a.hash }] }] })
  new SuiteCatalog(join(dir, 'plugin-suites.json')).install({ manifest: exact, hash: 'a'.repeat(64) })
  const suite = catalog.get('suite:study:read')
  expect(catalog.previewNew({ id: suite.id, revision: suite.revision }, builtin, distribution,[a,b],[]).selection.external[0].hash).toBe(a.hash)
  catalog.users.rename(user.id,user.revision,'改名')
  expect(() => catalog.previewNew(input,builtin,distribution,[a,b],[])).toThrow('变化')
})
it('明确组合不叠加发行默认，固定指定摘要并补依赖；缺摘要与歧义不擅自替换', () => {
  const catalog = new PresetCatalog(temp()), a = pack('reader', '1.0.0', ['text']), b = pack('reader', '2.0.0', ['text'])
  const preview = (plugins: { id: string; hash?: string }[]) => catalog.previewNew(undefined, builtin, distribution, [a, b], [a], plugins)
  expect(preview([]).selection).toEqual({ disabled: ['text'], external: [] })
  expect(preview([{ id: 'reader', hash: b.hash }]).selection).toEqual({ disabled: [], external: [{ id: 'reader', hash: b.hash, enabled: true }] })
  expect(preview([{ id: 'reader' }]).issues.join()).toContain('多个已安装版本')
  expect(() => preview([{ id: 'reader', hash: 'a'.repeat(64) }])).toThrow('摘要未安装')
  expect(() => preview([{ id: 'text', hash: b.hash }])).toThrow('摘要未安装')
})
it('初始选择早于装配且只写一次；默认交接、身份和用户后续更改不被重试覆盖', () => {
  const root = join(temp(),'library'), id = randomUUID(), initId = randomUUID(), bundled = pack('reader')
  let lib = openLibrary(root, undefined, id)
  const initial = { id: initId, libraryId: id, settings: { disabled: ['text'], external: [] } }
  initializeCreatedLibrary(lib, initial, builtin, [bundled], distribution)
  expect(readBindings(lib)).toEqual([])
  expect(readDisabled(lib)).toEqual(['text'])
  setPluginSettings(lib, [], [{ ...bundled, enabled: true }], builtin)
  lib.close(); lib = openLibrary(root, undefined, id)
  try {
    initializeCreatedLibrary(lib, initial, builtin, [bundled], distribution)
    expect(readBindings(lib)[0].enabled).toBe(true); expect(readDisabled(lib)).toEqual([])
    expect(() => initializeCreatedLibrary(lib, { ...initial, id: randomUUID() }, builtin, [bundled], distribution)).toThrow('已初始化')
  } finally { lib.close() }
  const before = readFileSync(join(root,'library.db'))
  expect(() => openLibrary(root, undefined, randomUUID())).toThrow('身份')
  expect(readFileSync(join(root,'library.db'))).toEqual(before)
})
it('SQLite 已建空文件或初始配置事务失败时可重试，不留下半份插件选择', () => {
  const root = join(temp(),'library'); mkdirSync(root); new Database(join(root,'library.db')).close()
  const id = randomUUID(), lib = openLibrary(root, undefined, id), a = pack('reader')
  try {
    const initial = { id: randomUUID(), libraryId: id, settings: { disabled: [], external: [{ ...a, enabled: true }, { ...a, enabled: true }] } }
    expect(() => initializeCreatedLibrary(lib, initial, builtin, [a], distribution)).toThrow('只能选择')
    expect(lib.db.prepare("SELECT 1 FROM meta WHERE key='plugin_defaults_pending'").get()).toBeTruthy()
    expect(readBindings(lib)).toEqual([])
    initializeCreatedLibrary(lib, { ...initial, settings: { disabled: [], external: [{ ...a, enabled: true }] } }, builtin, [a], distribution)
    expect(readBindings(lib)).toHaveLength(1)
  } finally { lib.close() }
})
it('创建记录按任务和仓库身份认领目录，重开接续；不能接管已有内容，取消保留数据', () => {
  const dir = temp(), jobs = new LibraryCreations(join(dir,'jobs'))
  const job = jobs.write({ id: randomUUID(), libraryId: randomUUID(), root: join(dir,'library'), name: '测试', selection: { disabled: [], external: [] } })
  jobs.claim(job)
  writeFileSync(join(job.root,'important.txt'),'保留')
  const reopened = new LibraryCreations(join(dir,'jobs'))
  reopened.claim(reopened.read(job.id))
  expect(() => reopened.claim({ ...job, id: randomUUID() })).toThrow('另一项')
  reopened.finish(job)
  expect(readFileSync(join(job.root,'important.txt'),'utf8')).toBe('保留')
  expect(existsSync(join(job.root,'.creation.json'))).toBe(false)
  expect(() => jobs.claim(job)).toThrow('已有内容')
})

it('外部创建在意图、认领与初始化处中断后固定同一身份和配置，终态保留但退出待接续列表', () => {
  const dir = temp(), jobs = new LibraryCreations(join(dir, 'jobs'))
  const job = jobs.write({ id: randomUUID(), libraryId: randomUUID(), root: join(dir, 'library'), name: '恢复',
    selection: { disabled: ['text'], external: [] }, settings: { disabled: ['text'], external: [] },
    external: { namespace: 'mcp', requestId: 'stable-create', signature: 'a'.repeat(64), mode: 'admin', background: true } })
  const restarted = () => new LibraryCreations(join(dir, 'jobs'))
  expect(existsSync(job.root)).toBe(false)
  restarted().claim(restarted().read(job.id))
  restarted().claim(restarted().read(job.id))
  let lib = openLibrary(job.root, undefined, job.libraryId)
  const initial = { id: job.id, libraryId: job.libraryId, settings: job.settings }
  initializeCreatedLibrary(lib, initial, builtin, [], distribution)
  setPluginSettings(lib, [], [], builtin); lib.close()
  lib = openLibrary(job.root, undefined, job.libraryId)
  try {
    const recovered = restarted().read(job.id)
    initializeCreatedLibrary(lib, { id: recovered.id, libraryId: recovered.libraryId, settings: recovered.settings }, builtin, [], distribution)
    expect(readDisabled(lib)).toEqual([]) // 不回写已经被用户改变的初始选择。
  } finally { lib.close() }
  restarted().finish(job)
  expect(restarted().list()).toEqual([])
  expect(restarted().list(true)).toHaveLength(1)
  expect(restarted().read(job.id)).toMatchObject({ state: 'completed', libraryId: job.libraryId, settings: job.settings })
})
