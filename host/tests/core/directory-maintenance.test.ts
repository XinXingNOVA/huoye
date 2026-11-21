import { expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import { join } from 'node:path'
import { openHost, tempDir } from '../helpers/helpers'
import { DirectorySpaces } from '../../src/storage/directory-spaces'
import { DirectoryMaintenance } from '../../src/storage/directory-maintenance'

it('全局维护核实成员和缺失清单，显式清理只影响本机追踪身份', async () => {
  const { host, cleanup } = openHost(), temp = tempDir(), home = join(temp, 'catalogs')
  vi.stubEnv('HUOYE_DIRECTORY_CATALOG', home)
  try {
    const api = new DirectoryMaintenance(home), spaces = new DirectorySpaces(home)
    const root = join(temp, '资料'), file = join(root, '文稿.md'), moved = join(temp, '外部.md')
    mkdirSync(root); writeFileSync(file, '原件')
    const { id } = spaces.attach(host.lib, root), catalog = join(home, id)
    const scan = () => spaces.refreshTree(host.lib, id, new AbortController().signal)
    await scan()
    const p = await host.api.previewDirectoryCollection(id, ['md'])
    await host.api.collectDirectoryFiles(id, ['md'], p.token)
    const [asset] = (await host.api.query({ has: ['file'] })).ids
    await host.api.put(asset, 'note', { text: '仓库笔记' })
    await host.scheduler.idle()
    expect(api.list()[0]).toMatchObject({ status: 'online', entries: 1, members: [{ available: true }] })
    expect(api.list()[0].bytes).toBeGreaterThan(0)
    expect(() => api.forget(id)).toThrow('仍有仓库')
    expect(() => api.removeMember(id, host.lib)).toThrow('仓库位置可用')
    renameSync(file, moved); await scan()
    expect(api.previewMissing(id, 30).count).toBe(0)
    const stale = api.previewMissing(id, 0)
    expect(stale.examples).toEqual(['文稿.md'])
    renameSync(moved, file); await scan()
    expect(() => api.cleanMissing(id, stale.cutoff, stale.token)).toThrow('清单已变化')
    renameSync(file, moved); await scan()
    const plan = api.previewMissing(id, 0)
    expect(api.cleanMissing(id, plan.cutoff, plan.token)).toBe(1)
    expect(api.list()[0].missing).toBe(0)
    renameSync(moved, file); await scan()
    expect((await host.api.previewDirectoryCollection(id, ['md'])).pending).toBe(1)
    spaces.unlink(host.lib, id)
    const staleMember = { id: 'old-library', root: join(temp, '已经移走的仓库') }
    spaces.attach(staleMember, root)
    expect(api.list()[0].members[0].available).toBe(false)
    api.removeMember(id, staleMember)
    const unknown = join(catalog, '单独保存的文件.txt')
    writeFileSync(unknown, 'keep')
    expect(() => api.forget(id)).toThrow('非登记簿文件')
    expect(readFileSync(unknown, 'utf8')).toBe('keep')
    renameSync(unknown, join(temp, '保留.txt'))
    api.forget(id); api.forget(id)
    expect(existsSync(catalog)).toBe(false)
    expect(api.list()).toEqual([])
    expect(readFileSync(file, 'utf8')).toBe('原件')
    expect(host.store.blocksOf(asset).note.data.text).toBe('仓库笔记')
    expect(spaces.connections(host.lib, await host.api.referencedDirectorySpaces())[0].state).toBe('missing')
  } finally { await host.scheduler.idle(); cleanup(); rmSync(temp,{ recursive: true, force: true }); vi.unstubAllEnvs() }
})

it('确认过的清理中断后可继续，移入清理目录前后均不会重新授予访问', () => {
  const temp = tempDir(), home = join(temp, 'catalogs'), root = join(temp, 'source')
  try {
    mkdirSync(root)
    const spaces = new DirectorySpaces(home), api = new DirectoryMaintenance(home)
    const member = { id: 'owner', root: join(temp,'library') }, { id } = spaces.attach(member, root)
    spaces.unlink(member,id)
    // 模拟已提交停止关联标记、尚未完成移除的两个重启点。
    const dir = join(home,id), db = new Database(join(dir,'catalog.sqlite'))
    try { db.exec("CREATE TRIGGER directory_retiring BEFORE INSERT ON members BEGIN SELECT RAISE(ABORT,'清理中'); END") }
    finally { db.close() }
    expect(api.list()[0].status).toBe('retiring')
    expect(() => spaces.attach(member,root,id)).toThrow('清理中')
    renameSync(dir,join(home,'.forget-' + id))
    expect(api.list()[0].status).toBe('retiring')
    api.forget(id)
    expect(api.list()).toEqual([])
    expect(existsSync(root)).toBe(true)
  } finally { rmSync(temp,{recursive:true,force:true}) }
})
