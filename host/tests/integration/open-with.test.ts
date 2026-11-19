import { afterEach, expect, it, vi } from 'vitest'
import { mkdirSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { collectOpeners, openerChoices, openerType, readOpenerPreference, resolveOpener, saveOpenerPreference } from '../../src/renderer/src/openers'
import { validateUiContributions } from '../../src/shared/ui-contributions'
import { canOpenCopy } from '../../src/shared/open-copy'
import type { EntityView } from '../../src/shared/blocks'
import type { UiPlugin } from '../../src/plugin-api/ui/contracts'
import { pruneViewingCopies, ViewingCopies } from '../../src/main/viewing-copy'
import { sharedVersionFile, versionHost } from '../helpers/version-files'
import { saveTextFile } from '../helpers/helpers'

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).reverse().forEach(f => f()))
const view = (name = '测试.MD'): EntityView => ({ id: 'test', createdAt: 0, deletedAt: null, blocks: { file: { ver: 1, seq: 1, data: { name } } }, failures: {} })
const named = { id: 'reader.open', title: '阅读', priority: 10, match: () => true, open: () => {} }
const manifest = [{ id: 'reader', title: '阅读器', description: '' }]
const plugins: UiPlugin[] = [{ id: 'reader', opens: [named, { priority: 1, match: () => true, tab: 'reader.legacy', params: () => ({}) }] }]

it('多种打开器按优先级排列；显式选择、默认回退、旧无名贡献的边界', () => {
  const available = collectOpeners(plugins, [])
  const choices = openerChoices(view(), available)
  expect(available.map(o => o.id)).toEqual(['legacy:reader:1', 'reader.open'])
  expect(resolveOpener(choices, undefined, 'reader.open')).toBe('reader.open')
  expect(resolveOpener(choices, 'host.auto', 'reader.open')).toBe('host.auto')
  expect(resolveOpener(openerChoices(view(), []), undefined, 'reader.open')).toBe('host.auto')
  expect(() => resolveOpener(openerChoices(view(), []), 'reader.open')).toThrow('不可用')
  expect(available[0].remember).toBe(false)
  expect(choices.some(o => o.id === 'host.system')).toBe(true)
  expect(openerChoices({ ...view(), deletedAt: 1 }, []).some(o => o.id === 'host.system')).toBe(false)
})

it('偏好按本机仓库与扩展名隔离；清除恢复自动；同名 ID 与不完整声明被拒绝', () => {
  const values = new Map<string, string>()
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) } }
  const choices = openerChoices(view(), collectOpeners(plugins, []))
  expect(openerType(view())).toBe('md')
  expect(openerType({ ...view(), blocks: {} })).toBeUndefined()
  saveOpenerPreference(storage, 'one', 'md', choices.find(o => o.id === named.id)!)
  expect(readOpenerPreference(storage, 'one', 'md')).toBe(named.id)
  expect(readOpenerPreference(storage, 'two', 'md')).toBeUndefined()
  expect(readOpenerPreference(storage, 'one', 'pdf')).toBeUndefined()
  expect(() => saveOpenerPreference(storage, 'one', 'md', choices[1])).toThrow('稳定 ID')
  saveOpenerPreference(storage, 'one', 'md', choices[0])
  expect(values.size).toBe(0)
  expect(() => validateUiContributions(plugins, manifest)).not.toThrow()
  for (const opens of [[named, named], [{ ...named, title: undefined }], [{ ...named, id: 'other.open' }]]) {
    expect(() => validateUiContributions([{ id: 'reader', opens }], manifest)).toThrow('打开方式')
  }
})

it('外部副本只读本库接纳版本，改副本不影响空间；下一次打开重新复制', async () => {
  const { a, b, ai, bi, dir } = await sharedVersionFile(cleanups, '旧版', '测试.md')
  await saveTextFile(a, ai, '新版本')
  const copies = new ViewingCopies(join(dir, 'copies')), launch = vi.fn(async () => '')
  const snapshot = (await b.api.get([bi]))[0]
  const first = await copies.open(b.lib.root, snapshot, launch)
  expect(readFileSync(first, 'utf8')).toBe('旧版')
  const original = b.lib.files.readable(String(snapshot.blocks.file.data.path))
  expect(statSync(first).ino).not.toBe(statSync(original).ino)
  writeFileSync(first, '外部修改')
  const second = await copies.open(b.lib.root, (await b.api.get([bi]))[0], launch)
  expect(second).not.toBe(first)
  expect(readFileSync(second, 'utf8')).toBe('旧版')
  expect(readFileSync(original, 'utf8')).toBe('旧版')
  expect(readFileSync(a.lib.files.readable(String((await a.api.get([ai]))[0].blocks.file.data.path)), 'utf8')).toBe('新版本')
  expect(launch).toHaveBeenNthCalledWith(2, second)
  // 启动失败只清理本次副本，已成功交给外部应用的副本仍可读取。
  await expect(copies.open(b.lib.root, snapshot, async () => '没有关联应用')).rejects.toThrow('没有关联应用')
  expect(readdirSync(join(dir, 'copies'))).toHaveLength(2)
})

it('拒绝不可用原件、路径越界、已回收项、程序类型；关闭仓库期间不启动外部应用', async () => {
  const host = versionHost(cleanups), root = host.lib.root, launch = vi.fn(async () => '')
  const source = join(root, 'input.md'); writeFileSync(source, 'hello')
  const [id] = await host.api.ingest([{ type: 'file', path: source }]), snapshot = (await host.api.get([id]))[0]
  const copies = new ViewingCopies(join(root, 'copies'))
  for (const name of ['program.exe', 'run.command', 'run.sh', 'link.lnk', 'page.url', 'unknown.xyz', 'no-extension']) expect(canOpenCopy(name)).toBe(false)
  const withFile = (fields: Record<string, unknown>) => ({ ...snapshot, blocks: { file: { ...snapshot.blocks.file, data: { ...snapshot.blocks.file.data, ...fields } } } })
  await expect(copies.open(root, withFile({ name: 'run.exe' }), launch)).rejects.toThrow('不启动')
  await expect(copies.open(root, withFile({ path: '../outside.md' }), launch)).rejects.toThrow()
  await expect(copies.open(root, withFile({ path: 'cache/missing.md' }), launch)).rejects.toThrow()
  await expect(copies.open(root, { ...snapshot, deletedAt: 1 }, launch)).rejects.toThrow('已回收')
  await expect(copies.open(root, snapshot, launch, () => { throw new Error('仓库已关闭') })).rejects.toThrow('仓库已关闭')
  expect(launch).not.toHaveBeenCalled()
  expect(readdirSync(join(root, 'copies'))).toEqual([])
})

it('延迟清理仅处理过期的本功能副本，不立即删除仍供外部应用查看的文件', async () => {
  const host = versionHost(cleanups), root = join(host.lib.root, 'copies')
  for (const dir of ['view-expired', 'view-recent', 'user-files']) mkdirSync(join(root, dir), { recursive: true })
  const old = new Date(Date.now() - 8 * 86400000)
  utimesSync(join(root, 'view-expired'), old, old); utimesSync(join(root, 'user-files'), old, old)
  await pruneViewingCopies(root)
  expect(readdirSync(root).sort()).toEqual(['user-files', 'view-recent'])
})
