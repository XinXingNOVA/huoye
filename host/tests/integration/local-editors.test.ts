import { afterEach, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { LocalEditors, editorLaunchSpec } from '../../src/main/local-editors'
import { createFileEditingService } from '../../src/renderer/src/file-editing-service'
import type { FileEditingBridge } from '../../src/shared/file-editing'

const cleanup: (() => void)[] = []
afterEach(() => cleanup.splice(0).reverse().forEach(fn => fn()))
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'rm-editors-')); cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'local-editors.json'), app = join(dir, 'Editor with space.app')
  mkdirSync(join(app, 'Contents'), { recursive: true }); writeFileSync(join(app, 'Contents', 'Info.plist'), '')
  return { dir, file, app, editors: new LocalEditors(file, 'darwin') }
}

it('本机编辑器登记及按仓库格式偏好可重开；丢失不静默回退，移除清偏好不删应用', () => {
  const { file, app, editors } = setup(), editor = editors.register(app)
  expect(editors.register(app).id).toBe(editor.id)
  editors.remember('A', 'md', editor.id); editors.remember('B', 'md', 'system')
  const reopened = new LocalEditors(file, 'darwin')
  expect(reopened.preferred('A', 'md')).toBe(editor.id)
  expect(reopened.preferred('B', 'md')).toBe('system')
  expect(reopened.preferred('A', 'txt')).toBeUndefined()
  expect(() => reopened.remember('A', '', editor.id)).toThrow('无扩展名')
  const config = readFileSync(file, 'utf8')
  // 不覆盖坏配置，也不能继续用旧内存副本伪装读取成功。
  writeFileSync(file, '损坏配置')
  expect(() => reopened.remove(editor.id)).toThrow('未重置或覆盖')
  expect(readFileSync(file, 'utf8')).toBe('损坏配置'); writeFileSync(file, config)
  reopened.remove(editor.id)
  expect(reopened.preferred('A', 'md')).toBeUndefined(); expect(reopened.preferred('B', 'md')).toBe('system')
  expect(readFileSync(join(app, 'Contents', 'Info.plist'), 'utf8')).toBe('')
  const next = reopened.register(app); rmSync(app, { recursive: true })
  expect(() => reopened.resolve(next.id)).toThrow('EDITOR_MISSING')
})

it('所选程序和文件各为独立参数，Windows 不登记脚本／快捷方式，取消未知 ID 不落入系统关联', () => {
  const { file, dir } = setup(), path = join(dir, 'Editor & other.exe')
  writeFileSync(path, '')
  const editors = new LocalEditors(file, 'win32'), editor = editors.register(path)
  const work = join(dir, '编辑-$(touch danger) & name.blend')
  expect(editorLaunchSpec(editor, work, 'win32')).toEqual({ command: editor.path, args: [work] })
  expect(editorLaunchSpec(editor, work, 'darwin')).toEqual({ command: '/usr/bin/open', args: ['-a', editor.path, work] })
  const script = join(dir, 'editor.cmd'); writeFileSync(script, '')
  expect(() => editors.register(script)).toThrow('不支持脚本或快捷方式')
  expect(() => editors.resolve('00000000-0000-4000-8000-000000000001')).toThrow('EDITOR_MISSING')
})

it('公共工作副本服务不转发私有替换路径；状态订阅可释放且复用同一后端', async () => {
  const listeners = new Set<() => void>(), inputs: unknown[] = []
  const bridge: Pick<FileEditingBridge, 'start' | 'list' | 'onChanged'> = {
    start: async input => { inputs.push(input); return { id: 'same-task', itemId: input.id, name: 'asset', createdAt: 0, updatedAt: 0, ended: false, baseReference: '', canOpen: false, format: '', phase: 'editing' } }, list: async () => [],
    onChanged: fn => { listeners.add(fn); return () => { listeners.delete(fn) } }
  }
  const service = createFileEditingService(bridge as FileEditingBridge)
  const input = { id: 'asset', source: '/private/not-a-public-input' }
  await service.start(input); expect(inputs).toEqual([{ id: 'asset' }])
  let n = 0; const off = service.onChanged(() => n++)
  listeners.forEach(fn => fn()); expect(n).toBe(1)
  off(); listeners.forEach(fn => fn()); expect(n).toBe(1)
  expect(await service.list()).toEqual([])
})
