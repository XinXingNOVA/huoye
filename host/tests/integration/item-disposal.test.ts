import { afterEach, expect, it } from 'vitest'
import { basename, join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { openHost, saveTextFile } from '../helpers/helpers'
import { ItemDisposal, type ItemDisposalPorts } from '../../src/application/item-disposal'
import type { ItemDisposalSelection } from '../../src/shared/item-disposal'
import { SpaceDisposal } from '../../src/storage/space-disposal'
import type { CorePlugin } from '../../src/core/plugin'
import { legacyCorePlugins } from '../helpers/legacy-plugins'

const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })
async function fixture(extra: CorePlugin[] = []) {
  const f = openHost([...legacyCorePlugins, ...extra]); cleanups.push(f.cleanup)
  const { host, root } = f, bin = join(root, 'test-system-trash'); mkdirSync(bin)
  const sources = ['one.txt', 'two.txt'].map(name => join(root, name))
  sources.forEach((path, i) => writeFileSync(path, 'test-' + i))
  const ids = await host.api.ingest(sources.map(path => ({ type: 'file' as const, path })))
  await host.scheduler.idle()
  let failAt = 0, calls = 0
  const platform = { async trashDirectory(path: string) {
    calls++; if (calls === failAt) throw new Error('测试：系统暂时拒绝移动')
    renameSync(path, join(bin, basename(path)))
  } }
  const ports: ItemDisposalPorts = {
    snapshot: async ids => host.api.itemDisposalSnapshot(ids), bindings: async () => host.api.listFileSpaces(),
    receipt: async input => host.api.itemLifecycleReceipt(input), trash: async input => host.api.applyItemLifecycle(input), changed: async () => {}
  }
  const service = () => new ItemDisposal(root, host.lib.id, ports, platform)
  const execute = async (s: ItemDisposal, selection: ItemDisposalSelection) => {
    const preview = await s.preview(selection)
    return s.execute({ selection, previewToken: preview.previewToken, requestId: randomUUID() })
  }
  return { host, root, ids, bin, ports, platform, service, execute, fail(n: number) { failAt = n }, calls: () => calls }
}
it('两层组合：文件先处置，素材可撤销，空间记录保留，重复请求不再处置', async () => {
  const f = await fixture(), s = f.service(), selection = { ids: f.ids }
  const preview = await s.preview(selection)
  expect(preview.spaces[0].files).toHaveLength(2)
  const input = { selection, previewToken: preview.previewToken, requestId: randomUUID() }
  const result = await s.execute(input)
  expect(result).toMatchObject({ state: 'complete', library: 'done', originals: 2, completed: 2 })
  expect(f.ids.every(id => f.host.store.isTrashed(id))).toBe(true)
  expect(f.calls()).toBe(2)
  expect((await s.execute(input)).replayed).toBe(true)
  expect(f.calls()).toBe(2)
  const space = f.host.lib.files.bindings!.default().space
  expect(space.db.prepare('SELECT count(*) FROM files').pluck().get()).toBe(2)
  expect(space.db.prepare('SELECT count(*) FROM file_versions').pluck().get()).toBe(2)
  await f.host.api.undo()
  expect(f.ids.every(id => !f.host.store.isTrashed(id))).toBe(true)
  await s.execute(input)
  expect(f.ids.every(id => !f.host.store.isTrashed(id))).toBe(true)
  expect((await f.service().list())[0].state).toBe('complete')
})
it('部分文件失败不移除素材；新服务读记录后只重试剩余文件', async () => {
  const f = await fixture(); f.fail(2)
  const first = await f.execute(f.service(), { ids: f.ids })
  expect(first).toMatchObject({ state: 'pending', completed: 1, library: 'pending' })
  expect(f.ids.every(id => !f.host.store.isTrashed(id))).toBe(true)
  const restarted = f.service()
  expect((await restarted.list())[0].completed).toBe(1)
  const preview = await restarted.preview({ taskId: first.id })
  expect(preview.spaces[0].files).toHaveLength(1)
  expect((await f.execute(restarted, { taskId: first.id })).state).toBe('complete')
  expect(f.calls()).toBe(3)
})
it('原件成功但仓库步骤失败，可只接续仓库；丢失仓库响应由事务回执确认', async () => {
  const f = await fixture(), trash = f.ports.trash
  f.ports.trash = async () => { throw new Error('模拟仓库暂时离线') }
  const first = await f.execute(f.service(), { ids: f.ids })
  expect(first).toMatchObject({ completed: 2, library: 'pending' })
  f.ports.trash = async input => { await trash(input); throw new Error('模拟回执丢失') }
  const second = await f.execute(f.service(), { taskId: first.id })
  expect(second.library).toBe('pending')
  expect((await f.service().list())[0].library).toBe('done')
  expect(f.calls()).toBe(2)
})
it('预览后原始块变化拒绝执行；接续时不扩大已确认的文件范围', async () => {
  const f = await fixture(), s = f.service(), selection = { ids: [f.ids[0]] }
  const preview = await s.preview(selection)
  await f.host.api.put(f.ids[0], 'note', { text: '预览后改动' })
  await expect(s.execute({ selection, previewToken: preview.previewToken, requestId: randomUUID() })).rejects.toThrow('PREVIEW_CHANGED')
  expect(f.calls()).toBe(0)
  f.ports.trash = async () => { throw new Error('仓库未提交') }
  const first = await f.execute(s, selection)
  // 直接模拟底层原件引用变化；普通 file.put 不允许这么写。
  f.host.lib.db.prepare("UPDATE main.block SET data=? WHERE entity_id=? AND kind='file'").run(JSON.stringify(f.host.store.blocksOf(f.ids[1]).file.data), f.ids[0])
  await expect(s.preview({ taskId: first.id })).rejects.toThrow('TARGET_CHANGED')
})
it('已处置文件被还原时阻止接续；普通删除和 purge 不触碰原件', async () => {
  const f = await fixture(); f.fail(2)
  const first = await f.execute(f.service(), { ids: f.ids }), done = first.files.find(f => f.outcome === 'done')!
  const space = f.host.lib.files.bindings!.default().space
  const job = space.db.prepare('SELECT bundle FROM space_disposals WHERE file_id=?').get(done.id) as { bundle: string }
  renameSync(join(f.bin, basename(job.bundle)), join(space.root, job.bundle))
  expect((await f.service().preview({ taskId: first.id })).blocked.join()).toContain('恢复或状态变化')
  expect(f.calls()).toBe(2)
  const g = await fixture(), path = g.host.lib.files.readable(String(g.host.store.blocksOf(g.ids[0]).file.data.path))
  await g.host.api.trash([g.ids[0]]); await g.host.api.purge([g.ids[0]])
  expect(existsSync(path)).toBe(true)
})
it('同一原件去重，未选中引用只提示；纯文字批次不调用系统', async () => {
  const f = await fixture(), target = f.ids[0], original = f.host.store.blocksOf(target).file.data
  const duplicate = f.host.store.createEntity(); f.host.store.put(duplicate, 'file', original)
  const s = f.service(), one = await s.preview({ ids: [target] }), both = await s.preview({ ids: [target, duplicate] })
  expect(one.spaces[0].otherReferences).toBe(1)
  expect(both.spaces[0].files).toHaveLength(1)
  const text = f.host.store.createEntity(); f.host.store.put(text, 'note', { text: '纯文字' })
  expect((await f.execute(s, { ids: [text] })).state).toBe('complete')
  expect(f.calls()).toBe(0)
  await f.execute(s, { ids: [target] })
  expect(f.host.store.isTrashed(duplicate)).toBe(false)
})
it('空间执行成功后响应丢失，接续从空间回执跳过已完成文件', async () => {
  const f = await fixture(), original = SpaceDisposal.prototype.execute
  SpaceDisposal.prototype.execute = async function(input) { await original.call(this, input); throw new Error('响应丢失') }
  let first
  try { first = await f.execute(f.service(), { ids: f.ids }) } finally { SpaceDisposal.prototype.execute = original }
  const restarted = f.service(), preview = await restarted.preview({ taskId: first!.id })
  expect(preview.completed).toBe(2)
  expect(preview.spaces[0].files).toHaveLength(0)
  expect((await f.execute(restarted, { taskId: first!.id })).state).toBe('complete')
  expect(f.calls()).toBe(2)
})
it('请求 ID 冲突拒绝；日志跟随仓库保存且不包含可执行任意路径', async () => {
  const f = await fixture(), s = f.service(), first = await f.execute(s, { ids: [f.ids[0]] })
  const selection = { ids: [f.ids[1]] }, preview = await s.preview(selection)
  await expect(s.execute({ selection, previewToken: preview.previewToken, requestId: first.id })).rejects.toThrow('REQUEST_ID_CONFLICT')
  const data = JSON.parse(readFileSync(join(f.root, '.app-operations/item-disposals', first.id + '.json'), 'utf8'))
  expect(data.libraryId).toBe(f.host.lib.id)
  expect(JSON.stringify(data)).not.toContain(f.root)
})
it('文件字段列表、附属素材和休眠定义参与原件范围，普通 link 不扩展范围', async () => {
  const extra: CorePlugin = { id: 'bundle', version: 1, blocks: [{ id: 'bundle', plugin: 'bundle', version: 1, rebuildable: false, title: '附件', fields: {
    files: { type: 'text', title: '原件', file: true, list: true },
    parent: { type: 'ref', title: '依附', ref: 'attach' }, link: { type: 'ref', title: '链接', ref: 'link' }
  } }] }
  const f = await fixture([extra]), child = f.host.store.createEntity()
  const refs = f.ids.map(id => f.host.store.blocksOf(id).file.data.path)
  f.host.store.put(child, 'bundle', { parent: f.ids[0], files: [refs[0], refs[0]], link: f.ids[1] })
  const s = f.service(), p = await s.preview({ ids: [f.ids[0]] })
  expect(p.affected).toBe(2); expect(p.spaces[0].files).toHaveLength(1)
  await f.execute(s, { ids: [f.ids[0]] })
  expect(f.host.store.isTrashed(child)).toBe(true)
  expect(f.host.store.isTrashed(f.ids[1])).toBe(false)
  expect(f.calls()).toBe(1)
  // 休眠插件使用保存的定义，不按字符串猜测原件。
  const dormant = { ...extra.blocks![0], id: 'dormantAttachment' }
  f.host.reg.setDormant([dormant])
  f.host.lib.db.prepare('INSERT INTO main.block(entity_id,kind,data,seq,schema_ver,updated_at) VALUES (?,?,?,?,1,0)').run(f.ids[1], dormant.id, JSON.stringify({ files: [refs[1]] }), 99)
  expect((await s.preview({ ids: [f.ids[1]] })).spaces[0].files).toHaveLength(1)
})
it('共享空间预览关联数；只删除当前库记录，另一仓库保留身份和数据', async () => {
  const a = await fixture(), b = await fixture(), space = a.host.lib.files.bindings!.default().space
  space.changeMode('shared', space.info().revision)
  await b.host.api.linkFileSpace(space.root)
  const source = (await a.host.api.itemDisposalSnapshot([a.ids[0]])).files[0]
  const adopted = await b.host.api.adoptSpaceFiles({ spaceId: space.id, files: [{ id: source.fileId, revision: space.byId(source.fileId)!.revision }], requestId: randomUUID() })
  const id = (adopted.result as { items: { id: string }[] }).items[0].id
  await b.host.api.put(id, 'note', { text: 'B 的独立信息' })
  const s = a.service(), preview = await s.preview({ ids: [a.ids[0]] })
  expect(preview.spaces[0]).toMatchObject({ mode: 'shared', members: 2 })
  await a.execute(s, { ids: [a.ids[0]] })
  expect(b.host.store.isTrashed(id)).toBe(false)
  expect(b.host.store.blocksOf(id).note.data.text).toBe('B 的独立信息')
  expect((await b.host.api.fileStorageInfo(id)).lifecycle).toBe('disposed')
})
it('命令尚未封口但单文件成功已落库，重新确认后补回执，不再调用系统', async () => {
  const f = await fixture(); f.ports.trash = async () => { throw new Error('仓库尚未提交') }
  const first = await f.execute(f.service(), { ids: f.ids })
  const path = join(f.root, '.app-operations/item-disposals', first.id + '.json'), journal = JSON.parse(readFileSync(path, 'utf8'))
  const input = journal.attempts[0].spaces[0], space = f.host.lib.files.bindings!.default().space
  space.db.prepare('UPDATE space_disposal_commands SET finished=0,pid=0,items=? WHERE request_id=?').run('[]', input.requestId)
  space.db.prepare('UPDATE space_file_records SET busy_request=?').run(input.requestId)
  journal.files = []; writeFileSync(path, JSON.stringify(journal))
  const s = f.service(), p = await s.preview({ taskId: first.id })
  expect(p.blocked).toEqual([])
  f.ports.trash = async input => f.host.api.applyItemLifecycle(input)
  expect((await f.execute(s, { taskId: first.id })).state).toBe('complete')
  expect(f.calls()).toBe(2)
})
it('原件处置期间用户编辑笔记，停止仓库步骤；重新预览保留新笔记后继续', async () => {
  const f = await fixture(), move = f.platform.trashDirectory
  f.platform.trashDirectory = async path => { await move(path); await f.host.api.put(f.ids[0], 'note', { text: '处置期间的新笔记' }) }
  const first = await f.execute(f.service(), { ids: [f.ids[0]] })
  expect(first).toMatchObject({ completed: 1, library: 'pending' })
  expect(first.message).toContain('PREVIEW_CHANGED')
  expect(f.host.store.isTrashed(f.ids[0])).toBe(false)
  expect((await f.execute(f.service(), { taskId: first.id })).library).toBe('done')
  expect(f.host.store.blocksOf(f.ids[0]).note.data.text).toBe('处置期间的新笔记')
  expect(f.calls()).toBe(1)
})
it('同一文件不同版本的引用仍只处置一次，预览覆盖全部版本', async () => {
  const f = await fixture(), old = f.host.store.createEntity()
  f.host.store.put(old, 'file', f.host.store.blocksOf(f.ids[0]).file.data)
  await saveTextFile(f.host, f.ids[0], 'second version')
  const s = f.service(), preview = await s.preview({ ids: [old, f.ids[0]] })
  expect(preview.spaces[0].files).toHaveLength(1)
  expect(preview.spaces[0].files[0].versions).toBe(2)
  await f.execute(s, { ids: [old, f.ids[0]] })
  expect(f.calls()).toBe(1)
})
