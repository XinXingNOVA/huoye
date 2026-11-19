import { afterEach, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { basename, join } from 'node:path'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { openHost } from '../helpers/helpers'
import { filePlugin } from '../../src/plugins/file/core'
import { FileSpace } from '../../src/storage/file-space'
import { parseSpaceReference } from '../../src/storage/space-reference'
import { SpaceDisposal } from '../../src/storage/space-disposal'
import type { CorePlugin } from '../../src/core/plugin'
import type { DisposalAction } from '../../src/shared/space-disposal'
import { SpaceVersions, setVersionPermission } from '../../src/storage/space-versions'

const cleanups: (() => void)[] = []
afterEach(() => { for (const fn of cleanups.splice(0).reverse()) fn() })
async function fixture(beforeRead?: (id: string) => Promise<void> | undefined) {
  const runs = new Map<string, number>()
  const probe: CorePlugin = { id: 'probe', version: 1, blocks: [{ id: 'probe', title: '读取结果', plugin: 'probe', version: 1, rebuildable: true,
    fields: { text: { type: 'text', title: '文字' } } }], systems: [{ id: 'probe.read', priority: 25, concurrency: 1, has: ['file'], outputs: ['probe'], async run(ctx, id, b) {
      if (beforeRead) await beforeRead(id)
      runs.set(id, (runs.get(id) ?? 0) + 1)
      return { probe: { text: readFileSync(ctx.abs(String(b.file.data.path)), 'utf8') } }
    } }] }
  const h = openHost([filePlugin, probe]); cleanups.push(h.cleanup)
  const { host, root } = h, paths = ['保留.md', '处置.md'].map(name => join(root, name))
  paths.forEach((path, i) => writeFileSync(path, `# text ${i}`))
  const [kept, target] = await host.api.ingest(paths.map(path => ({ type: 'file' as const, path })))
  await host.scheduler.idle()
  const space = host.lib.files.bindings!.default().space, trash = join(root, 'simulated-trash'); mkdirSync(trash)
  const service = new SpaceDisposal(space, { async trashDirectory(path) { renameSync(path, join(trash, basename(path))) } })
  const file = (await host.api.listSpaceFiles({ spaceId: space.id })).items.find(f => f.collected === target)!
  const apply = async (action: DisposalAction) => {
    const selection = { spaceId: space.id, action, files: [{ id: file.id, revision: space.byId(file.id)!.revision }] }
    const result = await service.execute({ ...selection, previewToken: service.preview(selection).previewToken, requestId: randomUUID() })
    expect(result.items[0].outcome).toBe('done')
    await host.api.refreshFileSpace(space.id); await host.scheduler.idle()
  }
  return { host, kept, target, space, file, trash, apply, runs, events: h.events }
}
it('刷新只在需要接续加工时访问原件，并向引用该文件的休眠块和文件卡发送通知', async () => {
  const { host, kept, target, space, file, events } = await fixture()
  const ref = String(host.store.blocksOf(target).file.data.path)
  const dormant = host.store.createEntity()
  // 旧 JSON 中反斜线分隔的嵌套引用，即使身份用 Unicode 转义保存也应命中。
  const data = JSON.stringify({ attachments: [{ source: ref.replaceAll('/', '\\') }] }).replace(file.id, Array.from(file.id, ch => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0')).join(''))
  host.lib.db.prepare('INSERT INTO main.block VALUES (?,?,?,1,1,0)').run(dormant, 'dormant', data)
  await host.scheduler.idle()
  const readable = vi.spyOn(host.lib.files, 'readable')
  try {
    events.length = 0
    await host.api.refreshFileSpace(space.id, [file.id])
    const changed = events.filter(e => e.event === 'changed').map(e => (e.payload as { ids: string[] }).ids.toSorted())
    expect(changed).toEqual([[target, dormant].toSorted()])
    events.length = 0
    await host.api.refreshFileSpace(space.id)
    expect(events).toContainEqual({ event: 'changed', payload: { ids: expect.arrayContaining([kept, target, dormant]) } })
    expect(readable).not.toHaveBeenCalled()
  } finally { readable.mockRestore() }
})
it('处置和清理空间记录不重新加工其他文件，保留成功派生数据', async () => {
  const f = await fixture(), before = f.host.store.blocksOf(f.kept)
  f.host.api.trash([f.target]); f.host.api.purge([f.target])
  await f.apply('trash'); await f.apply('clean')
  expect(f.runs.get(f.kept)).toBe(1)
  expect(f.host.store.blocksOf(f.kept)).toEqual(before)
  expect((await f.host.api.listSpaceFiles({ spaceId: f.space.id, scope: 'records', recordScope: 'archived' })).items[0].cleanedAt).toBeTruthy()
})
it('原件短暂离线取消排队任务，恢复时即使没有失败回执也能接续', async () => {
  let hold: ((id: string) => Promise<void>) | undefined
  const { host, space, kept, target, runs } = await fixture(id => hold?.(id))
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const first = new Promise<string>(resolve => { hold = async id => { resolve(id); await gate } })
  try {
    await host.api.regenerate([kept, target])
    const queued = (await first) === kept ? target : kept
    const reference = String(host.store.blocksOf(queued).file.data.path)
    const path = host.lib.files.readable(reference), fileId = parseSpaceReference(reference)!.fileId
    renameSync(path, path + '.offline')
    try {
      await host.api.refreshFileSpace(space.id, [fileId])
      expect(host.scheduler.processingSummary().queued).toBe(0)
    } finally { renameSync(path + '.offline', path) }
    await host.api.refreshFileSpace(space.id)
    release()
    await host.scheduler.idle()
    expect(runs.get(queued)).toBe(2)
  } finally { hold = undefined; release() }
})
it('核验还原只重试失败项；未失效的成功加工不重跑', async () => {
  const f = await fixture()
  await f.apply('trash')
  // 模拟文件不可用时用户显式请求重新加工。
  f.host.api.regenerate([f.target]); await f.host.scheduler.idle()
  expect(f.host.lib.db.prepare("SELECT status FROM derived.derivation WHERE entity_id=? AND system='probe.read'").pluck().get(f.target)).toBe('failed')
  const job = f.space.db.prepare('SELECT bundle FROM space_disposals WHERE file_id=?').get(f.file.id) as { bundle: string }
  renameSync(join(f.trash, basename(job.bundle)), join(f.space.root, job.bundle))
  await f.apply('verify')
  expect(f.host.lib.db.prepare("SELECT status FROM derived.derivation WHERE entity_id=? AND system='probe.read'").pluck().get(f.target)).toBe('ok')
  expect(f.runs.get(f.target)).toBe(3)
  expect(f.runs.get(f.kept)).toBe(1)
  await f.apply('archive'); await f.apply('unarchive')
  expect(f.runs.get(f.target)).toBe(3)
})

it.each(['ui', 'external'] as const)('%s 空间回收、恢复及回执重放保留成功加工，只在恢复时重试失败项', async entry => {
  const f = await fixture(), { host, space, file, target } = f
  setVersionPermission(space, host.lib.id, 'recycle', true, space.info().revision)
  const request = (action: 'recycle' | 'restore') => ({ spaceId: space.id, action, files: [{ id: file.id, revision: space.byId(file.id)!.revision }], version: space.info().revision, requestId: randomUUID() })
  const mutate = (input: ReturnType<typeof request>) => entry === 'ui' ? host.api.mutateSpaceFiles(input) : host.api.externalFileAction({ action: 'applyLifecycle', input })
  const initial = host.store.blocksOf(target).probe
  await mutate(request('recycle')); await host.scheduler.idle()
  expect(f.runs.get(target)).toBe(1)
  expect(host.store.get([target])[0].failures).toEqual({})
  const restore = request('restore')
  await mutate(restore); await host.scheduler.idle()
  await mutate(restore); await host.scheduler.idle()
  expect(f.runs.get(target)).toBe(1)
  expect(host.store.blocksOf(target).probe).toEqual(initial)
  await mutate(request('recycle'))
  host.api.regenerate([target]); await host.scheduler.idle()
  expect(host.store.get([target])[0].failures['probe.read']).toBeTruthy()
  await mutate(request('restore')); await host.scheduler.idle()
  expect(host.store.get([target])[0].failures).toEqual({})
  expect(f.runs.get(target)).toBe(3)
  expect(f.runs.get(f.kept)).toBe(1)
})


async function multiSpace() {
  const h = openHost([filePlugin]); cleanups.push(h.cleanup)
  const a = h.host.lib.files.bindings!.default().space, info = FileSpace.create(join(h.root, 'shared'), 'shared')
  h.host.api.linkFileSpace(info.root)
  const b = h.host.lib.files.bindings!.open(info.id)
  setVersionPermission(b, h.host.lib.id, 'revise', true, b.info().revision)
  const inputs = await Promise.all([a, b].map(space => h.host.api.importToLibrary([{ type: 'bytes', name: 'original.txt', bytes: Buffer.from('original') }], { spaceId: space.id, requestId: randomUUID() })))
  const ids = inputs.map(r => r.items[0].id)
  return { ...h, a, b, ids }
}

it('单空间通知只收录和接纳目标空间；全量扫描处理其他空间，旧引用仍能重新发现', async () => {
  const { host, root, a, b, ids } = await multiSpace()
  const rules = [a, b].map(s => ({ spaceId: s.id, automatic: true, updates: 'automatic' as const }))
  host.api.setImportSettings({ defaultSpaceId: a.id, collect: true, spaces: rules })
  expect(await host.api.scanSpaceImports()).toMatchObject({ collected: 0, updated: 0, updatesPending: 0 })
  const original = host.store.blocksOf(ids[0]).file.data
  for (const [index, space] of [a, b].entries()) {
    const service = new SpaceVersions(space), fileId = parseSpaceReference(String(host.store.blocksOf(ids[index]).file.data.path))!.fileId
    const source = join(root, `update-${index}.txt`); writeFileSync(source, `updated-${index}`)
    const draft = await service.stage({ spaceId: space.id, source, requestId: randomUUID(), target: { fileId, revision: space.byId(fileId)!.revision } })
    await service.commit({ spaceId: space.id, draftId: draft.draft.id, previewToken: service.preview(draft.draft.id).previewToken, requestId: randomUUID() })
    writeFileSync(source, `candidate-${index}`)
    const candidate = await service.stage({ spaceId: space.id, source, requestId: randomUUID() })
    await service.commit({ spaceId: space.id, draftId: candidate.draft.id, previewToken: service.preview(candidate.draft.id).previewToken, requestId: randomUUID() })
  }
  const untouched = vi.spyOn(b.db, 'prepare')
  // 通知只有原文件 ID，同时发现漏掉通知的新文件。
  try { await host.api.refreshFileSpace(a.id, [parseSpaceReference(String(original.path))!.fileId]); expect(untouched).not.toHaveBeenCalled() } finally { untouched.mockRestore() }
  const content = (id: string) => readFileSync(host.lib.files.readable(String(host.store.blocksOf(id).file.data.path)), 'utf8')
  expect(content(ids[0])).toBe('updated-0'); expect(content(ids[1])).toBe('original')
  expect((await host.api.query({ has: ['file'] })).ids).toHaveLength(3)
  expect(await host.api.scanSpaceImports()).toMatchObject({ collected: 1, updated: 1, updatesPending: 0 })
  expect(content(ids[1])).toBe('updated-1')
  // 没有新空间事件时，本库引用变化仍需重新比对，不以游标跳过。
  host.api.setImportSettings({ defaultSpaceId: a.id, collect: true, spaces: rules.map(r => ({ ...r, updates: 'manual' })) })
  host.store.put(ids[0], 'file', original)
  expect(await host.api.scanSpaceImports()).toMatchObject({ updated: 0, updatesPending: 1 })
  expect(content(ids[0])).toBe('original')
})

it.each(['local', 'external'] as const)('%s 已发布编辑按空间恢复；未发布意图不提交，其他空间可由全量检查接续', async owner => {
  const { host, a, b, ids } = await multiSpace()
  const prepare = (id: string) => {
    const input = { id, destination: { mode: 'publish' as const }, content: { type: 'text' as const, text: 'recovered' }, requestId: randomUUID() }
    return owner === 'local' ? host.api.prepareFileEdit(input) : host.api.externalFileAction({ action: 'prepare', input }) as ReturnType<typeof host.api.prepareFileEdit>
  }
  const drafts = await Promise.all(ids.map(prepare))
  // 同库另一个未发布意图不能因恢复扫描被提交。
  await prepare(ids[1])
  host.lib.db.exec("CREATE TRIGGER block_edit BEFORE UPDATE ON block WHEN NEW.kind='file' BEGIN SELECT RAISE(ABORT,'retry adoption'); END")
  for (const draft of drafts) {
    const input = { editId: draft.editId, previewToken: draft.previewToken, requestId: randomUUID() }
    const result = owner === 'local' ? await host.api.commitFileEdit(input) : await host.api.externalFileAction({ action: 'commit', input })
    expect(result).toMatchObject({ library: { state: 'pending' } })
  }
  host.lib.db.exec('DROP TRIGGER block_edit')
  const count = () => [a, b].map(s => s.db.prepare('SELECT count(*) FROM file_versions').pluck().get())
  expect(count()).toEqual([2, 2])
  const content = (id: string) => readFileSync(host.lib.files.readable(String(host.store.blocksOf(id).file.data.path)), 'utf8')
  await host.api.refreshFileSpace(a.id)
  expect(content(ids[0])).toBe('recovered'); expect(content(ids[1])).toBe('original')
  await host.api.scanSpaceImports()
  expect(content(ids[1])).toBe('recovered'); expect(count()).toEqual([2, 2])
})
