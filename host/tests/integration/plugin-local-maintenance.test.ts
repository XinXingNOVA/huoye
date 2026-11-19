import { afterEach, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PluginLocalFiles, localNamespace } from '../../src/main/plugin-local-files'
import { PluginLocalMaintenance } from '../../src/main/plugin-local-maintenance'
import type { LocalCategory, LocalCleanupRequest } from '../../src/shared/plugin-local'

const dirs: string[] = []
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'rm-local-cleanup-')); dirs.push(dir)
  const files = new PluginLocalFiles(join(dir, 'data')), blocked = vi.fn((): string[] => [])
  const create = () => new PluginLocalMaintenance(files, join(dir, 'receipts'), blocked)
  const write = (category: LocalCategory, root?: string, plugin = 'demo') => {
    const file = files.file(plugin, localNamespace(root ? 'library' : 'application', root), category)
    files.write(file, { version: 1, values: { sample: 'private-test-value' } }); return file
  }
  const request = (categories: LocalCategory[], scope: 'application' | 'library' = 'application'): LocalCleanupRequest => ({ pluginId: 'demo', scope, categories })
  return { dir, files, blocked, create, write, request }
}

it('显式类别与作用域隔离；预览只列键，不读取密钥明文，清理不碰其他库和插件', () => {
  const f = fixture(), service = f.create()
  const global = f.write('settings'), secret = f.write('secrets'), a = f.write('settings', '/a'), b = f.write('settings', '/b'), other = f.write('settings', undefined, 'other')
  const request = f.request(['settings'], 'library'), plan = service.preview(request, '/a')
  expect(JSON.stringify(plan)).not.toContain('private-test-value')
  expect(plan.files[0].keys).toEqual(['sample'])
  expect(service.clean({ ...request, token: plan.token }, '/a').items[0].status).toBe('done')
  expect(existsSync(a)).toBe(false)
  for (const path of [global, secret, b, other]) expect(existsSync(path)).toBe(true)
  const appRequest = f.request(['secrets']), appPlan = service.preview(appRequest)
  expect(service.clean({ ...appRequest, token: appPlan.token }).items[0].status).toBe('done')
  expect(existsSync(global)).toBe(true)
  expect(existsSync(secret)).toBe(false)
  expect(() => service.list('library')).toThrow('仓库窗口')
})

it('运行中、预览过期、损坏记录与软链接均不清理；清理回执不能删除后来重建的相同值', () => {
  const f = fixture(), service = f.create(), file = f.write('settings'), request = f.request(['settings'])
  const plan = service.preview(request)
  f.blocked.mockReturnValue(['另一个仓库运行中'])
  expect(() => service.clean({ ...request, token: plan.token })).toThrow('LOCAL_DATA_BLOCKED')
  f.blocked.mockReturnValue([])
  f.files.write(file, { version: 1, values: { sample: 'changed' } })
  expect(() => service.clean({ ...request, token: plan.token })).toThrow('LOCAL_DATA_CHANGED')
  const current = service.preview(request), input = { ...request, token: current.token }
  service.clean(input); f.files.write(file, { version: 1, values: { sample: 'changed' } })
  service.clean(input)
  expect(f.files.read(file).values.sample).toBe('changed')
  expect(service.preview(request).token).not.toBe(current.token)
  writeFileSync(file, '{bad')
  expect(service.preview(request).blocked).not.toEqual([])
  expect(readFileSync(file, 'utf8')).toBe('{bad')
  rmSync(file); const target = join(f.dir, 'keep.json'); writeFileSync(target, '{"version":1,"values":{"x":1}}'); symlinkSync(target, file)
  expect(service.preview(request).blocked).not.toEqual([])
  expect(readFileSync(target, 'utf8')).toContain('"x":1')
})

it('部分失败保留持久回执，重启可接续；失败期间的新值保留，不重复删除已成功项', () => {
  const f = fixture(), service = f.create(), setting = f.write('settings'), state = f.write('state'), request = f.request(['settings', 'state'])
  const plan = service.preview(request), write = vi.spyOn(f.files, 'write').mockImplementationOnce(() => { throw Error('disk full') })
  const result = service.clean({ ...request, token: plan.token })
  expect(result.items.map(i => i.status)).toEqual(['done', 'pending'])
  expect(f.create().list('application')[0].pending).toBe(true)
  write.mockRestore()
  f.write('settings')
  const resumed = f.create().retry('demo', 'application')
  expect(resumed.items.every(i => i.status === 'done')).toBe(true)
  expect(f.files.read(state).values).toEqual({})
  expect(existsSync(setting)).toBe(true)
  // 下一次失败后，用户写入新值，恢复不能覆盖新设置。
  f.write('state'); const next = service.preview(request)
  vi.spyOn(f.files, 'write').mockImplementationOnce(() => { throw Error('disk full') })
  service.clean({ ...request, token: next.token }); vi.restoreAllMocks()
  f.files.write(state, { version: 1, values: { new: true } })
  expect(f.create().retry('demo', 'application').items[1].status).toBe('retained')
  expect(f.files.read(state).values.new).toBe(true)
})

it('旧状态只导入一次，优先保留新存储；重置保留无值迁移标记，其他仓库独立迁入', () => {
  const f = fixture(), store = (root: string, action: string, value?: string[]) => f.files.state('demo', 'library', root, action, 'collapsed', value)
  store('/a', 'set', ['current'])
  expect(store('/a', 'importOnce', ['old'])).toEqual(['current'])
  expect(store('/a', 'importOnce', ['another-old'])).toEqual(['current'])
  const request = f.request(['state'], 'library'), service = f.create(), plan = service.preview(request, '/a')
  service.clean({ ...request, token: plan.token }, '/a')
  expect(store('/a', 'importOnce', ['old'])).toBeUndefined()
  expect(store('/b', 'importOnce', ['old'])).toEqual(['old'])
  expect(service.list('library', '/a')).toEqual([])
  const file = f.files.file('demo', localNamespace('library', '/a'), 'state')
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ version: 1, values: {}, imports: ['collapsed'] })
})

it('无法先保存清理回执时不删除设置', () => {
  const f = fixture(), service = f.create(), file = f.write('settings'), request = f.request(['settings']), plan = service.preview(request)
  writeFileSync(join(f.dir, 'receipts'), 'blocked')
  expect(() => service.clean({ ...request, token: plan.token })).toThrow()
  expect(existsSync(file)).toBe(true)
})
