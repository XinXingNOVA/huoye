import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { encodePackage, digest } from '../../src/plugin-packages/archive'
import { decodeSuite, encodeSuite, SuiteCatalog } from '../../src/plugin-packages/suites'
import { PackageManager } from '../../src/plugin-packages/manager'
import { PackageInstallations, suiteMissingPlugins } from '../../src/plugin-packages/installations'
import { PluginPresetCatalog } from '../../src/plugin-packages/presets'
import { PresetApplications, samePluginSelection } from '../../src/plugin-packages/preset-applications'
import { resumePresetArrangement } from '../../src/renderer/src/preset-arrangement-resume'
import { packageManifestSchema } from '../../src/shared/external-plugins'
import { suiteManifestSchema } from '../../src/shared/plugin-suites'
import { planPluginPreset } from '../../src/shared/plugin-preset-plan'
import type { WorkbenchLayout } from '../../src/shared/workbench-layout'
import { packSuite } from '../../scripts/plugins/suite-entry'
import { readReleaseBundle } from '../../scripts/release/bundled-suites'
import { DISTRIBUTION } from '../../src/plugins/generated/distribution'

const dirs: string[] = []
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'rm-suite-test-')); dirs.push(dir); return dir }
afterEach(() => { vi.restoreAllMocks(); dirs.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })) })
const layout: WorkbenchLayout = { version: 1, root: { type: 'group', id: 'main' }, primary: 'main', panels: { sidebar: true, inspector: false } }
const selection = { disabled: ['audio'], external: [] }
const pack = (id: string, version = '1.0.0') => encodePackage(packageManifestSchema.parse({ formatVersion: 1, apiVersion: 1, id, title: id, author: 'test', description: '', version, entries: { ui: 'ui.mjs' } }), new Map([['ui.mjs', Buffer.from('throw new Error("must not run during install")')]]))
function suite(id = 'study', version = '1.0.0', files = new Map([['reader.rmplugin', pack('reader')], ['notes.rmplugin', pack('notes')]])) {
  const packages = [...files].map(([file, bytes]) => ({ file, id: file.replace('.rmplugin',''), version: '1.0.0', hash: digest(bytes) }))
  const manifest = suiteManifestSchema.parse({ formatVersion: 1, id, version, title: '学习', description: '', packages, presets: [{ id: 'read', title: '阅读', plugins: packages.map(({ id, hash, version }) => ({ id, hash, title: id, version })), layout }] })
  return { manifest, files, bytes: encodeSuite(manifest, files) }
}

it('本地打包保留精确包摘要；拒绝篡改、未知执行字段、重复成员和路径越界', () => {
  const dir = temp(), a = suite(), source = join(dir, 'suite.json'), output = join(dir, 'study.hysuite')
  for (const [file, data] of a.files) writeFileSync(join(dir, file), data)
  writeFileSync(source, JSON.stringify({ ...a.manifest, packages: [...a.files.keys()], presets: [{ id: 'read', title: '阅读', plugins: ['reader', 'notes'], layout }] }))
  packSuite(source, output)
  expect(decodeSuite(readFileSync(output)).manifest).toEqual({ ...a.manifest,
    packages: a.manifest.packages.map(p => ({ ...p, file: p.id + '.hyplugin' }))
  })
  expect(decodeSuite(a.bytes).manifest).toEqual(a.manifest)
  const raw = { manifest: a.manifest, packages: [...a.files].map(([file, data]) => ({ file, content: data.toString('base64') })) }
  raw.packages[0].content = pack('reader', '2.0.0').toString('base64')
  expect(() => decodeSuite(Buffer.concat([Buffer.from('RMSUITE1\n'), gzipSync(Buffer.from(JSON.stringify(raw)))]))).toThrow('摘要')
  expect(() => suiteManifestSchema.parse({ ...a.manifest, script: 'run()' })).toThrow()
  expect(() => suiteManifestSchema.parse({ ...a.manifest, packages: [{ ...a.manifest.packages[0], file: '../a.rmplugin' }] })).toThrow()
  expect(() => suiteManifestSchema.parse({ ...a.manifest, presets: [{ ...a.manifest.presets[0], plugins: [a.manifest.presets[0].plugins[0], a.manifest.presets[0].plugins[0]] }] })).toThrow('重复')
})

it('安装仅登记包；部分失败登记待补齐方案，使用预览字节重试，重复安装与目录移除不动包', () => {
  const dir = temp(), manager = new PackageManager(dir, []), catalog = new SuiteCatalog(join(dir, 'suites.json')), batches = new PackageInstallations(() => manager, () => catalog)
  const a = suite(), file = join(dir, 'study.rmsuite'); writeFileSync(file, a.bytes)
  const preview = batches.preview(1, [file])!
  expect(suiteMissingPlugins({...a.manifest,presets:[{...a.manifest.presets[0],plugins:[{id:'no-payload',title:'未附带'}]}]},manager)).toEqual(['no-payload'])
  expect(preview.suites?.[0].presets).toEqual([{ id: 'suite:study:read', title: '阅读' }])
  expect(catalog.list()).toEqual([]); expect(manager.list()).toEqual([])
  writeFileSync(file, 'source changed')
  const original = manager.install.bind(manager)
  vi.spyOn(manager, 'install').mockImplementationOnce(() => { throw new Error('disk full') }).mockImplementation(original)
  const first = batches.install(1, preview.token)
  expect(first.items.map(p => p.status)).toEqual(['failed', 'installed'])
  expect(first.suites?.[0].status).toBe('incomplete'); expect(first.suites?.[0].missing).toEqual(['reader']); expect(catalog.list()).toHaveLength(1)
  const second = batches.install(1, preview.token)
  expect(second.suites?.[0].status).toBe('installed'); expect(manager.list()).toHaveLength(2)
  expect(batches.install(1, preview.token).suites?.[0].status).toBe('installed')
  catalog.remove(a.manifest.id, digest(a.bytes)); expect(catalog.list()).toEqual([]); expect(manager.list()).toHaveLength(2)
})

it('套件目录写入失败可独立重试；同批多版本套件拒绝；原版副本保留布局且不受目录更新影响', () => {
  const dir = temp(), manager = new PackageManager(dir, []), catalog = new SuiteCatalog(join(dir, 'suites.json')), batches = new PackageInstallations(() => manager, () => catalog)
  const a = suite(), file = join(dir, 'study.rmsuite'); writeFileSync(file, a.bytes)
  const preview = batches.preview(1, [file])!
  vi.spyOn(catalog, 'install').mockImplementationOnce(() => { throw new Error('registry failed') })
  expect(batches.install(1, preview.token).suites?.[0].status).toBe('failed')
  expect(manager.list()).toHaveLength(2)
  expect(batches.install(1, preview.token).suites?.[0].status).toBe('installed')
  const user = new PluginPresetCatalog(join(dir, 'user.json')), original = catalog.presets()[0]
  const copy = user.save('我的阅读', original.plugins, { layout: original.layout })
  expect(user.rename(copy.id, copy.revision, '新名字').layout).toEqual(layout)
  const v2 = suite('study', '2.0.0'), file2 = join(dir, 'v2.rmsuite'); writeFileSync(file2, v2.bytes)
  expect(() => batches.preview(1, [file, file2])).toThrow('同一套件')
  catalog.install(decodeSuite(v2.bytes)); expect(user.list()[0].layout).toEqual(layout)
  expect(() => catalog.install(decodeSuite(a.bytes))).toThrow('降级')
  const changed = suite(); changed.manifest.title = '不同内容'
  expect(() => catalog.install(decodeSuite(encodeSuite({ ...changed.manifest, version: '2.0.0' }, changed.files)))).toThrow('不同内容')
})

it('套件推荐版本只用于首次选择，多版本不猜最新，已有选择保留并告知差异', () => {
  const a = suite(), catalog = new SuiteCatalog(join(temp(), 'suites.json')); catalog.install(decodeSuite(a.bytes))
  const manager = new PackageManager(temp(), []); for (const bytes of a.files.values()) manager.install(bytes)
  const newer = manager.install(pack('reader', '2.0.0'))
  const env = { plugins: [], bindings: [], installed: manager.list(), development: [] }
  const first = planPluginPreset(catalog.presets()[0], 'add', { disabled: [], external: [] }, env, '')
  expect(first.issues).toEqual([]); expect(first.selection.external.find(p => p.id === 'reader')?.hash).toBe(a.manifest.packages[0].hash)
  const kept = planPluginPreset(catalog.presets()[0], 'add', { disabled: [], external: [{ id: 'reader', hash: newer.hash, enabled: true }] }, env, '')
  expect(kept.selection.external.find(p => p.id === 'reader')?.hash).toBe(newer.hash)
  expect(kept.warnings).toEqual(['reader：预选 2.0.0，套件推荐 1.0.0'])
  expect(samePluginSelection(selection, { disabled: ['audio'], external: [] })).toBe(true)
  expect(samePluginSelection(selection, { disabled: [], external: [] })).toBe(false)
})

it('接续记录跨重启；保存失败保留意图，已保存回执避免重复套用；身份不符与旧完成请求拒绝', async () => {
  const dir = temp(), jobs = new PresetApplications(dir), job = jobs.start('/test', 'library', selection, { title: '阅读', layout })
  expect(new PresetApplications(dir).read('/test', 'library')?.id).toBe(job.id)
  expect(() => jobs.read('/test', 'different')).toThrow('身份')
  expect(() => jobs.start('/test', 'library', selection, { title: '重复', layout })).toThrow('未完成')
  let receipt: string | undefined
  const api = { pending: async () => jobs.read('/test', 'library'), finish: async (id: string) => jobs.finish('/test', 'library', id, receipt) }
  const actions = { alive: () => true, receipt: () => receipt, inspect: () => [] as string[], apply: vi.fn((_layout: WorkbenchLayout, id: string) => { receipt = id; return true }), checkpoint: vi.fn(async () => {}) }
  actions.checkpoint.mockRejectedValueOnce(Error('disk full'))
  await expect(resumePresetArrangement(api, actions)).rejects.toThrow('disk full')
  expect(jobs.read('/test', 'library')).toBeDefined()
  expect(() => jobs.finish('/test', 'library', job.id, undefined)).toThrow('尚未保存')
  await resumePresetArrangement(api, actions)
  expect(actions.apply).toHaveBeenCalledTimes(1); expect(jobs.read('/test', 'library')).toBeUndefined()
  const next = jobs.start('/test', 'library', selection, { title: '下一方案', layout })
  expect(() => jobs.cancel('/test', 'library', job.id)).toThrow('已改变')
  const blocked = { ...actions, inspect: () => ['缺少工具'] }
  await expect(resumePresetArrangement(api, blocked)).rejects.toThrow('缺少工具')
  expect(jobs.read('/test', 'library')?.id).toBe(next.id); expect(actions.apply).toHaveBeenCalledTimes(1)
})


it('缺少推荐包时按 ID 复用；同版不同构建不覆盖，允许跳过和重试，普通包仍拒绝冲突', () => {
  const dir=temp(), manager=new PackageManager(dir,[]), catalog=new SuiteCatalog(join(dir,'suites.json')), batches=new PackageInstallations(()=>manager,()=>catalog)
  const different=encodePackage(packageManifestSchema.parse({formatVersion:1,apiVersion:1,id:'reader',title:'reader',version:'1.0.0',author:'test',description:'',entries:{ui:'ui.mjs'}}),new Map([['ui.mjs',Buffer.from('export const plugin={id:"reader"}')]]))
  const local=manager.install(different), a=suite(), file=join(dir,'suite.rmsuite');writeFileSync(file,a.bytes)
  const preview=batches.preview(1,[file])!
  expect(preview.items[0].reuseHash).toBe(local.hash)
  const first=batches.install(1,preview.token,[{index:1,hash:null}])
  expect(first.items.map(p=>p.status)).toEqual(['reused','skipped']);expect(first.suites?.[0].status).toBe('incomplete')
  expect(manager.list()).toEqual([local])
  expect(batches.install(1,preview.token).suites?.[0].status).toBe('incomplete')
  expect(batches.install(1,preview.token,[{index:1,hash:a.manifest.packages[1].hash}]).suites?.[0].status).toBe('installed')
  const env={plugins:[],installed:manager.list(),bindings:[],development:[]}
  const result=planPluginPreset(catalog.presets()[0],'add',{disabled:[],external:[]},env,'')
  expect(result.issues).toEqual([]);expect(result.selection.external.find(p=>p.id==='reader')?.hash).toBe(local.hash)
  expect(result.warnings).toEqual(['reader：预选 1.0.0，与套件推荐的安装包构建不同'])
  const plain=join(dir,'reader.rmplugin');writeFileSync(plain,a.files.get('reader.rmplugin')!)
  expect(batches.preview(2,[plain])!.items[0].status).toBe('invalid')
  const b=manager.install(pack('reader','2.0.0'))
  expect(planPluginPreset(catalog.presets()[0],'add',{disabled:[],external:[]},{...env,installed:manager.list()},'').issues.join()).toContain('多个')
  const chosen=planPluginPreset(catalog.presets()[0],'add',{disabled:[],external:[]},{...env,installed:manager.list()},'', [{id:'reader',hash:b.hash,enabled:true}])
  expect(chosen.issues).toEqual([]);expect(chosen.changes.find(p=>p.id==='reader')?.version).toBe('2.0.0')
  expect(()=>batches.install(1,preview.token,[{index:0,hash:'a'.repeat(64)}])).toThrow('预览范围')
})

it('同 ID 更新预览差异，拒绝目标错误和过期确认；已有副本与未完成任务保持原快照', () => {
  const dir=temp(), manager=new PackageManager(dir,[]), catalog=new SuiteCatalog(join(dir,'suites.json')), batches=new PackageInstallations(()=>manager,()=>catalog)
  const a=suite(), file=join(dir,'suite.rmsuite');catalog.install(decodeSuite(a.bytes))
  const user=new PluginPresetCatalog(join(dir,'users.json')), copy=user.save('副本',catalog.presets()[0].plugins,{layout})
  const jobs=new PresetApplications(join(dir,'jobs')), job=jobs.start('/library','id',selection,{title:'原布局',layout})
  const v2=suite('study','2.0.0');v2.manifest.presets[0].layout={...layout,panels:{sidebar:false,inspector:true}}
  writeFileSync(file,encodeSuite(v2.manifest,v2.files))
  const preview=batches.preview(1,[file],'study')!
  expect(preview.suites?.[0].previousVersion).toBe('1.0.0');expect(preview.suites?.[0].changes?.join()).toContain('工作台')
  expect(batches.preview(2,[file],'wrong')!.suites).toBeUndefined()
  const r=batches.install(1,preview.token)
  expect(r.suites?.[0].status).toBe('installed');expect(catalog.list()[0].manifest.version).toBe('2.0.0')
  expect(user.list()[0]).toEqual(copy);expect(new PresetApplications(join(dir,'jobs')).read('/library','id')).toEqual(job)
  const v3=suite('study','3.0.0');writeFileSync(file,v3.bytes)
  const stale=batches.preview(1,[file],'study')!
  catalog.remove('study',catalog.list()[0].hash)
  expect(()=>batches.install(1,stale.token)).toThrow('登记已变化')
})

it('普通发行去重套件共享包，自定义发行只提供确切摘要全匹配的方案', () => {
  const { suites, packages } = readReleaseBundle('packaging/starters')
  expect(suites.map(s => s.manifest.id)).toEqual(['visual-library', 'reference-library'])
  expect([...packages.keys()].sort()).toEqual(DISTRIBUTION.filter(p => p.origin === 'bundled').map(p => p.id).sort())
  const dir = temp(), visual = suites[0]
  const rows = visual.manifest.packages.map(p => {
    writeFileSync(join(dir, p.file), packages.get(p.id)!.bytes)
    return { file: p.file, hash: p.hash }
  })
  writeFileSync(join(dir, 'catalog.json'), JSON.stringify(rows))
  expect(readReleaseBundle('packaging/starters', dir).suites).toEqual([visual])
  writeFileSync(join(dir, 'catalog.json'), '[]')
  expect(readReleaseBundle('packaging/starters', dir).suites).toEqual([])
})

it('随附方案升级只替换仍在使用的发行版本，移除和手工更新跨重启保留', () => {
  const file = join(temp(), 'registry.json'), catalog = new SuiteCatalog(file)
  const release = (id: string, version: string) => {
    const s = suite(id, version)
    return { manifest: s.manifest, hash: digest(s.bytes) }
  }
  const a = release('visual', '1.0.0'), b = release('table', '1.0.0'), c = release('other', '1.0.0')
  catalog.provisionBundled([a, b, c])
  expect(catalog.list().map(v => v.bundled)).toEqual([true, true, true])
  catalog.remove(b.manifest.id, b.hash)
  const custom = release('other', '2.1.0')
  catalog.install(custom)
  const reopened = new SuiteCatalog(file), next = release('visual', '1.1.0')
  reopened.provisionBundled([next, release('table', '1.1.0'), release('other', '2.0.0')])
  expect(reopened.list()).toEqual([{ ...next, bundled: true }, custom])
  const before = readFileSync(file)
  reopened.provisionBundled([next, release('table', '1.1.0'), release('other', '2.0.0')])
  expect(readFileSync(file)).toEqual(before)
})
