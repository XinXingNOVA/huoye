import { afterEach, expect, it } from 'vitest'
import { rmSync } from 'node:fs'
import { openHost, tempDir } from '../helpers/helpers'
import { readDisabled } from '../../src/core/external-plugins'
import { packageManifestSchema, type ExternalBinding, type PackageRow } from '../../src/shared/external-plugins'
import { choosePackage, enableRequiredPlugins, packageChanges, previewPluginSettings, withoutUninstalled } from '../../src/renderer/src/plugin-settings'
import { encodePackage } from '../../src/plugin-packages/archive'
import { PackageManager } from '../../src/plugin-packages/manager'

const cleanup: (() => void)[] = []
afterEach(() => cleanup.splice(0).forEach(fn => fn()))
function binding(id: string, hash = 'a', version = '1.0.0'): ExternalBinding {
  return { hash: hash.repeat(64), enabled: true, manifest: packageManifestSchema.parse({
    id, title: id, description: '', author: 'test', version, formatVersion: 1, apiVersion: 1, entries: { ui: 'ui.mjs' }
  }) }
}
const row = (b: ExternalBinding): PackageRow => ({ ...b, selected: true, installed: true, running: true })

it('版本选择互斥，修改多个包只提交最终选择，取消新包不产生无效停用绑定', () => {
  const a = binding('demo-a'), b = binding('demo-b', 'b'), newer = binding('demo-a', 'c', '2.0.0')
  const saved = [a, b]
  let draft = choosePackage(saved, saved, newer, true)
  draft = choosePackage(draft, saved, b, false)
  expect(draft.filter(b => b.manifest.id === 'demo-a')).toEqual([newer])
  expect(packageChanges(saved, draft, new Set())).toEqual([{ hash: newer.hash, enabled: true }, { hash: b.hash, enabled: false }])
  draft = choosePackage(draft, saved, a, true)
  draft = choosePackage(draft, saved, b, true)
  expect(packageChanges(saved, draft, new Set())).toEqual([])
  expect(choosePackage([a], [], a, false)).toEqual([])
  expect(choosePackage([newer], [a], newer, false)).toEqual([{ ...a, enabled: false }])
})

it('重试可以排入同一批；卸载待选版本恢复原选择，不丢其他草稿', () => {
  const a = binding('demo-a'), b = binding('demo-b', 'b'), newer = binding('demo-a', 'c', '2.0.0')
  expect(packageChanges([a], [a], new Set([a.hash]))).toEqual([{ hash: a.hash, enabled: true }])
  expect(packageChanges([a], [{ ...a, enabled: false }], new Set([a.hash]))).toEqual([{ hash: a.hash, enabled: false }])
  expect(withoutUninstalled([newer, b], [a], newer.hash)).toEqual([a, b])
})

it('同一预演包含内外依赖；坏包依赖环不会阻断设置页', () => {
  const a = binding('demo-a'), b = binding('demo-b', 'b')
  a.manifest.requires = ['note']
  const builtin = [{ id: 'note', title: '笔记', description: '' }]
  expect(previewPluginSettings(new Set(['note']), builtin, [a], [row(a)]).off.get('demo-a')).toBe('需要「笔记」')
  a.manifest.requires = ['demo-b']; b.manifest.requires = ['demo-a']
  const plan = previewPluginSettings(new Set(), builtin, [a, b], [row(a), row(b)])
  expect(plan.off.get('demo-a')).toContain('依赖成环')
  expect(plan.enabled.has('note')).toBe(true)
})

it('补齐依赖只改草稿，保留原版本、其他选择和可选依赖的停用状态', () => {
  const a = binding('demo-a'), b = binding('demo-b', 'b'), newer = binding('demo-b', 'c', '2.0.0')
  a.manifest.requires = ['demo-b']; b.manifest.requires = ['preview']; b.manifest.optional = ['text']
  const draft = [a, { ...b, enabled: false }], disabled = new Set(['preview', 'text'])
  const builtin = [{ id: 'preview', title: '预览', description: '' }, { id: 'text', title: '文字', description: '' }]
  const next = enableRequiredPlugins('demo-a', disabled, builtin, draft, [row(a), row(b), row(newer)])
  expect(next.disabled).toEqual(new Set(['text']))
  expect(next.draft).toEqual([a, b])
  expect(draft[1].enabled).toBe(false)
  expect(disabled).toEqual(new Set(['preview', 'text']))
  expect(previewPluginSettings(next.disabled, builtin, next.draft, [row(a), row(b), row(newer)]).enabled).toEqual(new Set(['preview', 'demo-a', 'demo-b']))
})

it('未选依赖仅有一个安装版本时可补齐；多个版本、缺包、依赖环都不留下半批更改', () => {
  const a = binding('demo-a'), b = binding('demo-b', 'b'), newer = binding('demo-b', 'c', '2.0.0')
  a.manifest.requires = ['preview', 'demo-b']
  const builtin = [{ id: 'preview', title: '预览', description: '' }], disabled = new Set(['preview']), draft = [a]
  expect(enableRequiredPlugins('demo-a', disabled, builtin, draft, [row(a), row(b)]).draft).toEqual([a, b])
  expect(() => enableRequiredPlugins('demo-a', disabled, builtin, draft, [row(a), row(b), row(newer)])).toThrow('多个版本')
  expect(() => enableRequiredPlugins('demo-a', disabled, builtin, draft, [row(a)])).toThrow('缺少依赖')
  expect(() => enableRequiredPlugins('demo-a', disabled, builtin, [a, b], [row(a), row(newer)])).toThrow('未安装')
  b.manifest.requires = ['demo-a']
  expect(() => enableRequiredPlugins('demo-a', disabled, builtin, draft, [row(a), row(b)])).toThrow('成环')
  expect(draft).toEqual([a]); expect(disabled).toEqual(new Set(['preview']))
})

it('内置和多个外部绑定原子提交；后一个绑定无效则整批回滚，保存不改变运行中装配', () => {
  const h = openHost(); cleanup.push(h.cleanup)
  const a = binding('demo-a'), b = binding('demo-b', 'b')
  h.host.api.setExternalPlugin(a)
  const before = h.host.lib.db.prepare('SELECT * FROM main.config ORDER BY key').all()
  expect(() => h.host.api.setPluginSettings(['preview'], [{ ...a, enabled: false }, binding('file', 'c')])).toThrow('内置')
  expect(h.host.lib.db.prepare('SELECT * FROM main.config ORDER BY key').all()).toEqual(before)
  expect(() => h.host.api.setPluginSettings(['preview'], [a, { ...a, hash: 'd'.repeat(64) }])).toThrow('一个版本')
  h.host.api.setPluginSettings(['preview', 'file'], [{ ...a, enabled: false }, b])
  expect(readDisabled(h.host.lib)).toEqual(['preview'])
  expect(h.host.api.externalPlugins()).toEqual([{ ...a, enabled: false }, b])
  expect(h.host.plan.enabled.has('preview')).toBe(true)
})

it('一批授权先核对所有包；缺失版本不会提前授权或清除其他包的失败记录', () => {
  const dir = tempDir(); cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const manager = new PackageManager(dir, [])
  const a = manager.install(encodePackage(binding('demo-a').manifest, new Map([['ui.mjs', Buffer.from('export const plugin={id:"demo-a"}')]])))
  manager.block(dir, a.hash, '上次失败')
  expect(() => manager.grantMany(dir, [a.hash, 'f'.repeat(64)])).toThrow('未安装')
  expect(manager.begin(dir)[0].problem).toContain('尚未')
  manager.ready(dir); manager.grantMany(dir, [a.hash])
  expect(manager.begin(dir)[0].problem).toBeUndefined()
  manager.ready(dir)
})
