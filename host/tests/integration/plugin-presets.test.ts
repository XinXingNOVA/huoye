import { afterEach, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { PluginPresetCatalog, applyPresetSelection } from '../../src/plugin-packages/presets'
import { capturePluginSelection, planPluginPreset, selectionIssues, validateSelection, type PresetEnvironment } from '../../src/shared/plugin-preset-plan'
import { packageManifestSchema, type ExternalBinding } from '../../src/shared/external-plugins'
import { packageInfo } from '../../src/shared/package-info'
import type { PluginPreset, PluginSelection } from '../../src/shared/plugin-presets'

vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>()
  return { ...actual, renameSync: vi.fn(actual.renameSync) }
})
const dirs: string[] = []
afterEach(() => { vi.restoreAllMocks(); dirs.splice(0).forEach(p => fs.rmSync(p, { recursive: true, force: true })) })
const binding = (id: string, hash = 'a', requires: string[] = [], version = '1.0.0'): ExternalBinding => ({
  hash: hash.repeat(64), enabled: true,
  manifest: packageManifestSchema.parse({ formatVersion: 1, apiVersion: 1, id, title: id, description: '', author: 'test', version, requires, entries: { ui: 'ui.mjs' } })
})
const env = (): PresetEnvironment => ({ plugins: [
  { id: 'file', title: '文件', description: '', required: true },
  { id: 'text', title: '文字', description: '' }, { id: 'audio', title: '音频', description: '' }
], bindings: [], installed: [], development: [] })
const preset = (...ids: string[]): PluginPreset => ({ id: randomUUID(), revision: randomUUID(), title: '精读', plugins: ids.map(id => ({ id, title: id })) })
const selection = (bindings: ExternalBinding[] = [], disabled: string[] = []): PluginSelection => ({ disabled, external: bindings.map(p => ({ id: p.manifest.id, hash: p.hash, enabled: p.enabled })) })

it('本机目录跨实例读取，修改校验修订号；坏文件和写失败不重置或覆盖', () => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'rm-plugin-presets-')); dirs.push(dir)
  const file = join(dir, 'presets.json'), catalog = new PluginPresetCatalog(file)
  const p = catalog.save(' 阅读 ', preset('text').plugins)
  expect(new PluginPresetCatalog(file).list()[0].title).toBe('阅读')
  const renamed = catalog.rename(p.id, p.revision, '精读')
  expect(() => catalog.change(p.id, p.revision)).toThrow('修改或删除')
  const bytes = fs.readFileSync(file)
  vi.mocked(fs.renameSync).mockImplementationOnce(() => { throw new Error('disk failure') })
  expect(() => catalog.rename(renamed.id, renamed.revision, '不能保存')).toThrow('disk failure')
  expect(fs.readFileSync(file)).toEqual(bytes)
  expect(fs.readdirSync(dir)).toEqual(['presets.json'])
  catalog.change(renamed.id, renamed.revision); expect(catalog.list()).toEqual([])
  fs.writeFileSync(file, '{bad json')
  expect(() => catalog.save('不得重置', [])).toThrow('未重置')
  expect(fs.readFileSync(file, 'utf8')).toBe('{bad json')
})

it('捕获用户选择而非运行状态，保留缺包意图；开发与核心不写入组合', () => {
  const e = env(), a = binding('reader'), dev = binding('dev', 'd')
  e.bindings = [a, dev]; e.development = [packageInfo(dev)]
  expect(capturePluginSelection(selection(e.bindings, ['audio']), e).map(p => p.id)).toEqual(['reader', 'text'])
  expect(() => validateSelection(selection(e.bindings, ['file']), e)).toThrow('核心')
  expect(() => validateSelection(selection([{ ...dev, enabled: false }, a]), e)).toThrow('开发模式')
  expect(() => validateSelection(selection([a, a]), e)).toThrow('重复')
})

it('补充与替换共用依赖计划，沿用已选版本和草稿，不自动启用可选协作', () => {
  const e = env(), a = binding('reader', 'a', ['note']), b = binding('note', 'b', ['text']), newer = binding('note', 'c', [], '2.0.0')
  b.manifest.optional = ['audio']; e.bindings = [{ ...b, enabled: false }]; e.installed = [a, b, newer]
  const input = selection(e.bindings), p = preset('reader')
  const add = planPluginPreset(p, 'add', input, e, 'current')
  expect(add.issues).toEqual([])
  expect(add.selection.disabled).toEqual([])
  expect(add.selection.external.find(p => p.id === 'note')?.hash).toBe(b.hash)
  expect(add.changes.find(p => p.id === 'note')?.dependency).toBe(true)
  const replace = planPluginPreset(p, 'replace', input, e, 'current')
  expect(replace.selection.disabled).toEqual(['audio'])
  expect(replace.issues).toEqual([])
  expect(input).toEqual(selection(e.bindings))
  expect(capturePluginSelection(replace.selection, e).map(p => p.id)).toEqual(['note', 'reader', 'text'])
})

it('缺包、多版本、循环和开发冲突可见；显式选择版本才消歧，不根据版本提示自动升级', () => {
  const e = env(), a = binding('reader'), newer = binding('reader', 'b', [], '2.0.0'), p = preset('reader')
  p.plugins[0].version = '2.0.0'
  expect(planPluginPreset(p, 'add', selection(), e, '').issues.join()).toContain('缺少插件')
  e.installed = [a, newer]
  expect(planPluginPreset(p, 'add', selection(), e, '').issues.join()).toContain('多个已安装版本')
  const plan = planPluginPreset(p, 'add', selection([a]), e, '')
  expect(plan.issues).toEqual([]); expect(plan.warnings[0]).toContain('预选 1.0.0')
  e.bindings = [a]; e.installed = [newer]
  expect(planPluginPreset(p, 'add', selection([a]), e, '').issues.join()).toContain('未安装')
  e.installed = [a]; a.manifest.requires = ['reader']
  expect(planPluginPreset(p, 'add', selection([a]), e, '').issues.join()).toMatch(/成环|自身/)
  a.manifest.requires = ['text']; e.development = [packageInfo(a)]
  expect(planPluginPreset(p, 'add', selection([a]), e, '').issues.join()).toContain('开发模式')
  const replace = planPluginPreset(preset(), 'replace', selection([a]), e, '')
  expect(replace.issues).toEqual([]); expect(replace.selection.disabled).toEqual(['audio'])
  expect(replace.selection.external).toEqual(selection([a]).external)
  expect(selectionIssues(selection([a], ['text']), e).join()).toContain('文字')
})

it('提交在页面准备之后，再检查旧预览；失败不保存，提交后重载失败可明确续接', async () => {
  const order: string[] = []
  const steps = {
    check: vi.fn(async () => { order.push('check') }), prepare: vi.fn(async () => { order.push('prepare') }),
    save: vi.fn(async () => { order.push('save') }), reload: vi.fn(async () => { order.push('reload') }), resume: vi.fn()
  }
  steps.prepare.mockRejectedValueOnce(Error('草稿无法保存'))
  await expect(applyPresetSelection(steps)).rejects.toThrow('草稿无法保存')
  expect(steps.save).not.toHaveBeenCalled(); expect(steps.reload).not.toHaveBeenCalled()
  steps.check.mockResolvedValueOnce(undefined).mockRejectedValueOnce(Error('旧预览'))
  await expect(applyPresetSelection(steps)).rejects.toThrow('旧预览'); expect(steps.save).not.toHaveBeenCalled()
  steps.save.mockRejectedValueOnce(Error('事务失败'))
  await expect(applyPresetSelection(steps)).rejects.toThrow('事务失败'); expect(steps.reload).not.toHaveBeenCalled()
  steps.reload.mockRejectedValueOnce(Error('加载失败'))
  await expect(applyPresetSelection(steps)).rejects.toThrow('[PLUGIN_PRESET_RELOAD]')
  expect(steps.resume).toHaveBeenCalledTimes(3)
  order.length = 0; await applyPresetSelection(steps)
  expect(order).toEqual(['check', 'prepare', 'check', 'save', 'reload'])
})
