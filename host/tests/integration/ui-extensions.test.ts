import { describe, expect, it, vi } from 'vitest'
import { UiExtensionRegistry, validateUiExtensionDeclarations, type UiExtensionDeclarations } from '../../src/shared/ui-extensions'
import type { PluginInfo } from '../../src/shared/plugin-plan'

const manifest: PluginInfo[] = [
  { id: 'reader', title: '阅读器', description: '' },
  { id: 'cards', title: '卡片', description: '', optional: ['reader', 'extra'] }
]
const enabled = new Set(['reader', 'cards'])
const point = { id: 'reader.actions', version: 1, validate: (value: unknown) => typeof value === 'function' ? undefined : '需要函数' }
const provider: UiExtensionDeclarations = { id: 'reader', extensionPoints: [point] }
const extension = { id: 'cards.one', point: point.id, version: 1, value: vi.fn(() => 42) }
const contributor: UiExtensionDeclarations = { id: 'cards', extensions: [extension] }

describe('插件自定义 UI 贡献', () => {
  it('两阶段解析不依赖包顺序，内置与外部同层；快照稳定且不提前执行贡献', async () => {
    const a = new UiExtensionRegistry([contributor, provider], manifest, enabled)
    const b = new UiExtensionRegistry([provider, contributor], manifest, enabled)
    expect(a.list(point.id, 1)).toEqual(b.list(point.id, 1))
    expect(a.list(point.id, 1)).toBe(a.list(point.id, 1))
    expect(a.list('missing', 1)).toBe(a.list('missing', 1))
    expect(extension.value).not.toHaveBeenCalled()
    const hostPoint = { ...point, id: 'host.actions' }
    const own = new UiExtensionRegistry([{ id: 'host', extensionPoints: [hostPoint] }, { id: 'cards', extensions: [{ ...extension, point: hostPoint.id }] }], manifest, new Set(['cards']))
    expect(own.list(hostPoint.id, 1)).toHaveLength(1)
    await expect(a.invoke(a.list<() => number>(point.id, 1)[0], fn => fn())).resolves.toBe(42)
    expect(Object.isFrozen(a.list(point.id, 1))).toBe(true)
  })
  it('检查命名空间、重复、版本与依赖；预检不要求提供方先加载', () => {
    expect(() => validateUiExtensionDeclarations([contributor], manifest)).not.toThrow()
    expect(() => validateUiExtensionDeclarations([contributor], manifest.map(m => ({ ...m, optional: [] })))).toThrow('未声明')
    expect(() => validateUiExtensionDeclarations([{ id: 'cards', extensionPoints: [point] }], manifest)).toThrow('扩展点声明无效')
    expect(() => validateUiExtensionDeclarations([{ ...provider, extensionPoints: [point, point] }], manifest)).toThrow('重复')
    expect(() => validateUiExtensionDeclarations([{ ...contributor, extensions: [extension, extension] }], manifest)).toThrow('重复')
    expect(() => validateUiExtensionDeclarations([{ ...contributor, extensions: [{ ...extension, version: 0 }] }], manifest)).toThrow('声明无效')
    expect(() => validateUiExtensionDeclarations([{ ...provider, extensionPoints: [point, { ...point, version: 2 }] }], manifest)).not.toThrow()
  })
  it('可选提供方退出只撤下协作；不匹配与非法载荷归因贡献方，校验器故障归因提供方', () => {
    const missing = new UiExtensionRegistry([provider, contributor], manifest, new Set(['cards']))
    expect(missing.list(point.id, 1)).toEqual([])
    expect(missing.diagnostics()).toEqual([])
    const invalid: UiExtensionDeclarations = { id: 'cards', extensions: [extension, { ...extension, id: 'cards.newer', version: 2 }, { ...extension, id: 'cards.invalid', value: 0 }] }
    const registry = new UiExtensionRegistry([provider, invalid], manifest, enabled)
    expect(registry.list(point.id, 1).map(c => c.id)).toEqual(['cards.one'])
    expect(registry.diagnostics().map(d => [d.pluginId, d.phase])).toEqual([['cards', 'resolve'], ['cards', 'validate']])
    const broken = new UiExtensionRegistry([{ ...provider, extensionPoints: [{ ...point, validate() { throw new Error('故障') } }] }, contributor], manifest, enabled)
    expect(broken.list(point.id, 1)).toEqual([])
    expect(broken.diagnostics()[0]).toMatchObject({ pluginId: 'reader', phase: 'validate' })
    // 模拟不经过 TypeScript 的第三方包，错误异步校验不得造成未处理 Promise。
    const asyncValidator = (() => Promise.reject(new Error('异步校验'))) as unknown as typeof point.validate
    const asynchronous = new UiExtensionRegistry([{ ...provider, extensionPoints: [{ ...point, validate: asyncValidator }] }, contributor], manifest, enabled)
    expect(asynchronous.list(point.id, 1)).toEqual([])
    expect(asynchronous.diagnostics()[0]).toMatchObject({ pluginId: 'reader', message: expect.stringContaining('必须同步') })
  })
  it('稳定排序和契约版本隔离，needs 停用不污染原声明', () => {
    const cs = [extension, { ...extension, id: 'cards.early', order: -1 }, { ...extension, id: 'cards.hidden', needs: ['extra'] }]
    const registry = new UiExtensionRegistry([provider, { id: 'cards', extensions: cs }], manifest, enabled)
    expect(registry.list(point.id, 1).map(c => c.id)).toEqual(['cards.early', 'cards.one'])
    expect(cs.map(c => c.id)).toEqual(['cards.one', 'cards.early', 'cards.hidden'])
    expect(registry.list(point.id, 2)).toEqual([])
  })
  it('同步／异步错误有来源，诊断有界去重；窗口间句柄不能误用', async () => {
    const a = new UiExtensionRegistry([provider, contributor], manifest, enabled)
    const b = new UiExtensionRegistry([provider, contributor], manifest, enabled)
    const entry = a.list(point.id, 1)[0], listener = vi.fn(), off = a.subscribe(listener)
    await expect(a.invoke(entry, () => { throw new Error('同步失败') })).rejects.toThrow('同步失败')
    await expect(a.invoke(entry, async () => { throw new Error('异步失败') })).rejects.toThrow('异步失败')
    a.reportFailure(entry, new Error('同步失败'), 'action')
    expect(listener).toHaveBeenCalledTimes(2)
    await expect(b.invoke(entry, () => 1)).rejects.toThrow('当前窗口')
    expect(b.diagnostics()).toEqual([])
    off()
    for (let i = 0; i < 110; i++) a.reportFailure(entry, new Error(`错误 ${i}`), 'render')
    expect(a.diagnostics()).toHaveLength(100)
    expect(a.diagnostics().every(d => d.pluginId === 'cards')).toBe(true)
    expect(listener).toHaveBeenCalledTimes(2)
  })
})
