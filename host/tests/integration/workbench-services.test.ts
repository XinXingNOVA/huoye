import { describe, expect, it, vi } from 'vitest'
import { collectSettings } from '../../src/shared/settings-contributions'
import { validateUiContributions } from '../../src/shared/ui-contributions'
import { selectContributions } from '../../src/shared/plugin-plan'
import { SettingsController } from '../../src/renderer/src/settings-controller'
import { UiCommands, type RuntimeCommand } from '../../src/renderer/src/ui-command-service'
import { defaultWorkspace, extractLegacySettingsTarget, validWorkspace } from '../../src/renderer/src/workspace'
import type { UiHost } from '../../src/plugin-api/ui/contracts'
import type { CommandContext } from '../../src/plugin-api/ui/commands'

const deferred = <T>() => { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { resolve, promise } }
const catalog = () => [{ id: 'plugins', title: '插件', scope: 'library' as const }, { id: 'appearance', title: '外观', scope: 'application' as const }, { id: 'demo.model', title: '模型', scope: 'library' as const, storage: 'local' as const }]

describe('设置目录与导航', () => {
  it('旧贡献补齐来源与标题，新增元信息经过校验，可选协作仍按启用状态过滤', () => {
    const manifest = [{ id: 'demo', title: '示例插件', description: '', optional: ['other'] }, { id: 'other', title: '另一插件', description: '' }]
    const sections = [{ id: 'demo.old', scope: 'local', order: 1 }, { id: 'demo.new', scope: 'library', order: 2, title: '连接模型', keywords: ['API'], needs: ['other'] }]
    const commands = [{ id: 'demo.play', title: '播放', needs: ['other'], quickAction: { icon: 'music' as const }, run() {} }]
    const plugins = [{ id: 'demo', settingsSections: sections, commands }]
    expect(() => validateUiContributions(plugins, manifest)).not.toThrow()
    for (const invalid of [{ context: 'selection' as const }, { quickAction: { icon: 'custom-path' as any } }]) {
      expect(() => validateUiContributions([{ id: 'demo', commands: [{ ...commands[0], ...invalid }] }], manifest)).toThrow('快捷操作声明')
    }
    const selected = selectContributions(plugins, new Set(['demo']))
    expect(collectSettings(selected, manifest)).toEqual([expect.objectContaining({ id: 'demo.old', title: '示例插件', pluginId: 'demo', pluginTitle: '示例插件' })])
    expect(selected[0].commands).toEqual([])
    expect(() => validateUiContributions([{ id: 'demo', commands: [{ ...commands[0], id: 'other.play' }] }], manifest)).toThrow('命令声明')
    expect(() => validateUiContributions([{ id: 'demo', commands: [commands[0], commands[0]] }], manifest)).toThrow('重复')
    expect(() => validateUiContributions([{ id: 'demo', settingsSections: [{ ...sections[0], keywords: [''] }] }], manifest)).toThrow('关键词')
  })
  it('按目录定位、保留存储与页面范围，缺失目标不跳错页，拒绝离开保留原目标', async () => {
    const present = vi.fn(), service = new SettingsController(catalog, present)
    expect(service.getSnapshot()).toBe(service.getSnapshot())
    await service.open({ section: 'demo.model' })
    expect(present).toHaveBeenLastCalledWith({ scope: 'library', section: 'demo.model' })
    const before = service.getSnapshot().target
    let dirty = true
    const off = service.registerGuard('demo.model', { state: () => ({ dirty, message: '请保存模型' }) })
    expect(await service.open({ scope: 'application' })).toBe(false)
    expect(service.getSnapshot().target).toBe(before)
    expect(service.getSnapshot().blockedReason).toBe('请保存模型')
    await expect(service.open({ section: 'missing' })).rejects.toThrow('不可用')
    expect(present).toHaveBeenCalledTimes(1)
    dirty = false
    expect(await service.open({ section: 'appearance' })).toBe(true)
    off()
    const launcher = new SettingsController(() => catalog().filter(p => p.scope === 'application'), present, 'application')
    await expect(launcher.open({ scope: 'library' })).rejects.toThrow('不可用')
    expect(await launcher.open()).toBe(true)
  })
  it('异步保存串行、失败与取消不导航，窗口销毁后迟到确认不能重开设置', async () => {
    const present = vi.fn(), service = new SettingsController(catalog, present), waiting = deferred<boolean>()
    const off = service.registerGuard('draft', { state: () => ({ dirty: true }), beforeLeave: () => waiting.promise })
    const pending = service.open({ section: 'appearance' })
    expect(service.getSnapshot().busy).toBe(true)
    expect(await service.open()).toBe(false)
    service.dispose()
    await expect(pending).rejects.toThrow()
    waiting.resolve(true)
    expect(present).not.toHaveBeenCalled()
    off()
    const next = new SettingsController(catalog, present), cancel = new AbortController()
    next.registerGuard('draft', { state: () => ({ dirty: true }), beforeLeave: async () => { cancel.abort(); return true } })
    await expect(next.beforeLeave({ reason: 'close' }, cancel.signal)).rejects.toThrow()
    expect(next.getSnapshot().busy).toBe(false)
    const failed = new SettingsController(catalog, present)
    failed.registerGuard('failed', { state: () => ({ dirty: true }), beforeLeave: () => { throw new Error('写入失败') } })
    await expect(failed.open()).rejects.toThrow('写入失败')
    expect(failed.getSnapshot().target).toBeUndefined()
  })
  it('旧工作区中的 settings 标签页转为一次性打开目标并保留原内容标签', () => {
    const base = defaultWorkspace()
    const legacy = {
      ...base,
      tabs: [...base.tabs, { id: 'legacy-settings', type: 'settings', params: { scope: 'application', section: 'appearance' } }],
      active: 'legacy-settings'
    }
    expect(extractLegacySettingsTarget(legacy)).toEqual({ scope: 'application', section: 'appearance' })
    const restored = validWorkspace(legacy, type => type === 'collection')!
    expect(restored.tabs.map(t => t.type)).toEqual(['collection'])
    expect(restored.active).toBe(base.tabs[0].id)
  })
})

function commandsHarness() {
  const context: CommandContext = { page: { id: 'original', type: 'collection', query: { ids: ['a'] } }, ids: ['a'] }
  const host = {} as UiHost, run = vi.fn(), validate = vi.fn(async () => {})
  let allowed: boolean | string = true
  const rows: RuntimeCommand[] = [{ id: 'demo.run', title: '执行操作', category: '示例', keywords: ['test'], context: 'selection', enabled: () => allowed, run },
    { id: 'demo.hidden', title: '隐藏', when: () => false, run }]
  const collect = vi.fn(async () => rows)
  const service = new UiCommands(() => ({ context: structuredClone(context), host, validate, collect }))
  return { context, host, run, validate, rows, collect, service, allow: (value: boolean | string) => { allowed = value } }
}

describe('UI 命令会话', () => {
  it('定点会话只加载和执行指定命令，仍复核可用性', async () => {
    const h = commandsHarness(), ids = ['demo.run'], session = h.service.createSession({ ids })
    ids.push('demo.hidden')
    expect((await session.list()).map(c => c.id)).toEqual(['demo.run'])
    expect(h.collect).toHaveBeenCalledWith(['demo.run'])
    await expect(session.execute('demo.hidden')).rejects.toThrow('命令不存在')
    h.allow('暂不可用')
    await expect(session.execute('demo.run')).rejects.toThrow('暂不可用')
    h.allow(true); await session.execute('demo.run')
    expect(h.run).toHaveBeenCalledTimes(1)
    session.dispose()
  })
  it('固定来源与选择，搜索不重查仓库；执行复核可用性，失败后可以重试', async () => {
    const h = commandsHarness(), session = h.service.createSession()
    ;(h.context.ids as string[])[0] = 'b'
    expect(session.context.ids).toEqual(['a'])
    expect(Object.isFrozen(session.context.page?.query?.ids)).toBe(true)
    expect(await session.list('示例 TEST')).toHaveLength(1)
    expect(await session.list('隐藏')).toHaveLength(0)
    expect(h.collect).toHaveBeenCalledTimes(1)
    h.allow('原件不可用')
    await expect(session.execute('demo.run')).rejects.toThrow('原件不可用')
    expect(h.run).not.toHaveBeenCalled()
    h.allow(true); h.validate.mockRejectedValueOnce(new Error('来源已关闭'))
    await expect(session.execute('demo.run')).rejects.toThrow('来源已关闭')
    expect(h.run).not.toHaveBeenCalled()
    h.run.mockRejectedValueOnce(new Error('业务失败'))
    await expect(session.execute('demo.run')).rejects.toThrow('业务失败')
    await session.execute('demo.run')
    expect(h.run).toHaveBeenLastCalledWith(session.context, h.host)
    await session.refresh(); expect(h.collect).toHaveBeenCalledTimes(2)
  })
  it('并发点击只执行一次，取消或宿主销毁阻止迟到检查后的动作', async () => {
    const h = commandsHarness(), waiting = deferred<void>(), session = h.service.createSession()
    h.validate.mockImplementationOnce(() => waiting.promise)
    const first = session.execute('demo.run')
    await expect(h.service.createSession().execute('demo.run')).rejects.toThrow('正在执行')
    await Promise.resolve(); session.dispose(); waiting.resolve()
    await expect(first).rejects.toThrow('已结束')
    expect(h.run).not.toHaveBeenCalled()
    const next = h.service.createSession(); await next.list(); h.service.dispose()
    await expect(next.execute('demo.run')).rejects.toThrow('已结束')
  })
  it('读取失败可重试，重复 ID 拒绝歧义执行；状态回调失败只禁用该命令', async () => {
    const h = commandsHarness(), session = h.service.createSession()
    h.collect.mockRejectedValueOnce(new Error('查询失败'))
    await expect(session.list()).rejects.toThrow('查询失败')
    expect(await session.list()).toHaveLength(1)
    h.rows.push({ ...h.rows[0] })
    await expect(session.refresh()).rejects.toThrow('重复')
    h.rows.pop(); h.rows[0].enabled = () => { throw new Error('状态失败') }
    expect(await session.refresh()).toEqual([expect.objectContaining({ enabled: false, disabledReason: '命令状态检查失败' })])
  })
})
