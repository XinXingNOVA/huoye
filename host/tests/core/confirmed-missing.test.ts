import { afterEach, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DirectorySpaces } from '../../src/storage/directory-spaces'
import { SpaceDisk } from '../../src/storage/space-disk'
import { sharedVersionFile, prepareVersionEdit } from '../helpers/version-files'
import { openHost, tempDir } from '../helpers/helpers'

const cleanups: (() => void)[] = []
afterEach(() => { for (const f of cleanups.splice(0).reverse()) f(); vi.unstubAllEnvs() })
const query = (spaceId: string) => ({ spaceId, group: 'primary' as const, missingOnly: true as const, offset: 0 })
const selection = (space: string, ids: string[]) => ({ primarySpaceId: space, action: 'trash' as const, missingOnly: true as const, ids })

it('原地目录只接纳完整核对；找回、改名、无权枚举、掉盘及撤下成员均使缺失预览失效', async () => {
  const { host, cleanup } = openHost(), tmp = tempDir()
  cleanups.push(() => rmSync(tmp, { recursive: true, force: true }), cleanup)
  const home = join(tmp, 'catalogs'), root = join(tmp, 'source'), shelf = join(root, '子目录')
  vi.stubEnv('HUOYE_DIRECTORY_CATALOG', home)
  mkdirSync(shelf, { recursive: true })
  for (const name of ['A.md','B.md','C.md']) writeFileSync(join(root, name), name)
  const spaces = new DirectorySpaces(home), { id } = spaces.attach(host.lib, root)
  const scan = (signal = new AbortController().signal) => spaces.refreshTree(host.lib, id, signal)
  const page = () => host.api.listSpaceItems(query(id))
  await scan()
  const plan = await host.api.previewDirectoryCollection(id, ['md'])
  await host.api.collectDirectoryFiles(id, ['md'], plan.token)
  await host.scheduler.idle()
  renameSync(join(root, 'A.md'), join(tmp, 'a'))
  renameSync(join(root, 'B.md'), join(tmp, 'b'))
  renameSync(join(root, 'C.md'), join(shelf, '改名.md'))
  const cancelled = new AbortController(); cancelled.abort()
  expect((await scan(cancelled.signal)).cancelled).toBe(true)
  expect(await page()).toMatchObject({ selectable: 0, missingIssue: expect.stringContaining('未完成') })
  if (process.platform !== 'win32' && process.getuid?.() !== 0) {
    chmodSync(shelf, 0)
    try {
      expect((await scan()).failed).toBeGreaterThan(0)
      expect((await page()).selectable).toBe(0)
    } finally { chmodSync(shelf, 0o700) }
  }
  await scan()
  const candidates = await page()
  expect(candidates.items.map(item => item.missingPath).sort()).toEqual(['A.md','B.md'])
  const input = selection(id, candidates.batchIds), preview = await host.api.previewItemLifecycle(input)
  const apply = () => host.api.applyItemLifecycle({ ...input, previewToken: preview.previewToken, requestId: randomUUID() })
  renameSync(join(tmp, 'a'), join(shelf, '找回.md'))
  expect(apply).toThrow('PREVIEW_CHANGED')
  expect(candidates.batchIds.every(key => !host.store.isTrashed(key))).toBe(true)
  await scan()
  expect((await page()).items.map(item => item.missingPath)).toEqual(['B.md'])
  renameSync(root, join(tmp, 'offline'))
  try { expect(await page()).toMatchObject({ selectable: 0, missingIssue: expect.any(String) }) }
  finally { renameSync(join(tmp, 'offline'), root) }
  await scan(); spaces.unlink(host.lib, id)
  expect((await page()).missingIssue).toContain('关联')
})

it('托管空间按版本核对，两阶段之间找回会拦住整笔回收，旧版本缺失不影响有新版的素材', async () => {
  const { a, ai, b, bi, versions, fileId, spaceId, source, dir } = await sharedVersionFile(cleanups)
  const disk = new SpaceDisk(versions.space), old = versions.read(fileId, versions.head(fileId)), outside = join(dir,'away')
  const check = (signal?: AbortSignal) => disk.check({ spaceId, requestId: randomUUID() }, signal)
  const page = () => b.api.listSpaceItems(query(spaceId))
  renameSync(old, outside)
  expect((await page()).selectable).toBe(0)
  await check()
  expect((await page()).batchIds).toEqual([bi])
  const input = selection(spaceId, [bi]), preview = await b.api.previewItemLifecycle(input)
  const apply = { ...input, previewToken: preview.previewToken, requestId: randomUUID() }
  renameSync(outside, old)
  expect(() => b.api.applyItemLifecycle(apply)).toThrow('PREVIEW_CHANGED')
  expect((await page()).batchIds).toEqual([])
  renameSync(old, outside)
  const controller = new AbortController(); controller.abort()
  expect((await check(controller.signal)).cancelled).toBe(true)
  expect(await page()).toMatchObject({ selectable: 0, missingIssue: expect.stringContaining('未完成') })
  await check()
  // 本轮检查跳过了处置中的文件，即使旧核对报过缺失，也需要重新检查。
  const catalog = versions.space.db
  catalog.prepare('INSERT OR REPLACE INTO space_file_records(file_id,busy_request) VALUES (?,?)').run(fileId, 'disposal')
  await check()
  catalog.prepare('UPDATE space_file_records SET busy_request=NULL WHERE file_id=?').run(fileId)
  expect((await page()).selectable).toBe(0)
  await check()
  const fresh = await b.api.previewItemLifecycle(input)
  const accepted = { ...apply, previewToken: fresh.previewToken }
  await b.api.applyItemLifecycle(accepted)
  expect((await b.api.applyItemLifecycle(accepted)).replayed).toBe(true)
  expect(b.store.isTrashed(bi)).toBe(true); expect(a.store.isTrashed(ai)).toBe(false)
  await b.api.restore([bi])
  renameSync(outside, old); await check()
  writeFileSync(source, '第二版')
  await a.api.commitFileEdit(await prepareVersionEdit(a, ai, source))
  renameSync(old, outside); await check()
  expect((await page()).selectable).toBe(0)
  expect((await a.api.listSpaceItems(query(spaceId))).selectable).toBe(0)
  await Promise.all([a.scheduler.idle(), b.scheduler.idle()])
})
