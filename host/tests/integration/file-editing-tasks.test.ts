import { afterEach, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { FileEditingTasks, type EditingContext } from '../../src/main/file-editing-tasks'
import { sharedVersionFile, prepareVersionEdit } from '../helpers/version-files'
import type { Host } from '../../src/core/host'
import { setVersionPermission } from '../../src/storage/space-versions'

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).reverse().forEach(f => f()))
function context(host: Host): EditingContext {
  return { id: host.lib.id, root: host.lib.root, assertCurrent() {}, api: {
    get: async ids => host.api.get(ids), fileStorageInfo: async id => host.api.fileStorageInfo(id),
    fileEditCapabilities: async id => host.api.fileEditCapabilities(id), prepareFileEdit: async input => await host.api.prepareFileEdit(input),
    commitFileEdit: async input => await host.api.commitFileEdit(input), discardFileEdit: async input => { host.api.discardFileEdit(input) }
  } }
}
async function setup() {
  const f = await sharedVersionFile(cleanups), folder = join(f.dir, 'editing')
  return { ...f, folder, tasks: new FileEditingTasks(folder), ctx: context(f.a), other: context(f.b) }
}
async function work(tasks: FileEditingTasks, ctx: EditingContext, id: string) {
  let path = ''; await tasks.reveal(ctx, id, value => { path = value }); return path
}
const publish = { mode: 'publish' as const }
const count = (f: Awaited<ReturnType<typeof setup>>) => Number(f.versions.space.db.prepare('SELECT count(*) FROM file_versions').pluck().get())

it('未知格式和无扩展名保持真实格式、复用副本、拒绝系统关联；显式编辑后可恢复保存清理', async () => {
  for (const name of ['drawing.blend', 'README']) {
    const f = await sharedVersionFile(cleanups, '原内容', name), ctx = context(f.a), directory = join(f.dir, 'editing')
    const tasks = new FileEditingTasks(directory), task = await tasks.start(ctx, { id: f.ai }), path = await work(tasks, ctx, task.id)
    expect(task.canOpen).toBe(false)
    expect(path.endsWith(name.endsWith('.blend') ? '.blend' : '编辑-README')).toBe(true)
    await expect(tasks.open(ctx, task.id, async () => { throw new Error('不应使用系统关联') })).rejects.toThrow('EDITOR_REQUIRED')
    await expect(tasks.open(ctx, task.id, async () => '选中的程序已移动', true)).rejects.toThrow('任务和工作副本保留')
    writeFileSync(path, '编辑后的内容')
    const resumed = new FileEditingTasks(directory)
    expect((await resumed.start(ctx, { id: f.ai })).id).toBe(task.id)
    await resumed.open(ctx, task.id, async actual => { expect(actual).toBe(path); return '' }, true)
    expect((await resumed.check(ctx, { taskId: task.id, destination: publish })).unchanged).toBe(false)
    expect(await resumed.finish(ctx, { taskId: task.id })).toBeNull()
    expect(existsSync(path)).toBe(false)
    const file = f.a.store.blocksOf(f.ai).file.data
    expect(file.ext).toBe(task.format)
    expect(readFileSync(f.a.lib.files.readable(String(file.path)), 'utf8')).toBe('编辑后的内容')
    expect(readFileSync(f.b.lib.files.readable(String(f.b.store.blocksOf(f.bi).file.data.path)), 'utf8')).toBe('原内容')
  }
})

it('受控副本可复用、连续保存和重启；无变化不发版，其他仓库独立接纳，保留附加数据', async () => {
  const f = await setup(), { tasks, ctx, a, ai, b, bi, versions } = f
  a.api.patch(ai, 'file', { name: '没有扩展名的显示标题' }); a.api.put(ai, 'note', { text: '用户笔记' })
  const task = await tasks.start(ctx, { id: ai }), path = await work(tasks, ctx, task.id)
  expect(task.format).toBe('md'); expect(task.canOpen).toBe(true)
  expect((await tasks.start(ctx, { id: ai })).id).toBe(task.id)
  expect((await tasks.check(ctx, { taskId: task.id, destination: publish })).unchanged).toBe(true)
  expect(count(f)).toBe(1)
  await expect(tasks.open(ctx, task.id, async () => '模拟没有关联应用')).rejects.toThrow('任务和工作副本保留')
  await tasks.open(ctx, task.id, async value => { expect(value).toBe(path); return '' })
  writeFileSync(path, '# 新内容')
  const original = a.lib.files.readable(String(a.store.blocksOf(ai).file.data.path))
  expect(readFileSync(original, 'utf8')).toBe('# version-one')
  const checked = await tasks.check(ctx, { taskId: task.id, destination: publish })
  expect(checked.task.prepared?.sample).toBe('# 新内容')
  const request = checked.task.prepared!.reference.split('/').at(-1)!
  expect(readFileSync(await tasks.previewPath(ctx.id, task.id, request), 'utf8')).toBe('# 新内容')
  const resumed = new FileEditingTasks(f.folder)
  expect((await resumed.list(ctx))[0].phase).toBe('ready'); expect(count(f)).toBe(1)
  const saved = await resumed.commit(ctx, task.id, checked.task.prepared!.token)
  expect(saved.lastResult?.library.state).toBe('accepted'); expect(count(f)).toBe(2)
  expect(a.store.blocksOf(ai).note.data.text).toBe('用户笔记')
  expect(a.store.blocksOf(ai).file.data.name).toBe('没有扩展名的显示标题')
  expect(readFileSync(b.lib.files.readable(String(b.store.blocksOf(bi).file.data.path)), 'utf8')).toBe('# version-one')
  const next = await b.api.previewFileUpdate(bi)
  await b.api.acceptFileUpdate({ id: bi, expectedPath: next.expectedPath, contentVersion: next.current.id, revision: next.revision, requestId: randomUUID() })
  expect(readFileSync(b.lib.files.readable(String(b.store.blocksOf(bi).file.data.path)), 'utf8')).toBe('# 新内容')
  // 常见编辑器的原子替换保存也能检查；再次保存推进同一文件的基线。
  writeFileSync(path + '.new', '# 第二次保存'); renameSync(path + '.new', path)
  const second = await resumed.check(ctx, { taskId: task.id, destination: publish })
  await resumed.commit(ctx, task.id, second.task.prepared!.token)
  expect(versions.space.byId(f.fileId)?.id).toBe(f.fileId); expect(count(f)).toBe(3)
  expect((await resumed.check(ctx, { taskId: task.id, destination: publish })).unchanged).toBe(true)
})

it('预览过期拒绝；并行仓库发布拒绝旧基线，副本可显式改用独享空间', async () => {
  const f = await setup(), { tasks, ctx, other, a, b, ai, bi } = f
  setVersionPermission(f.versions.space, b.lib.id, 'revise', true, f.versions.space.info().revision)
  const one = await tasks.start(ctx, { id: ai }), two = await tasks.start(other, { id: bi })
  const path = await work(tasks, ctx, one.id), otherPath = await work(tasks, other, two.id)
  writeFileSync(path, '第一次检查'); const stale = await tasks.check(ctx, { taskId: one.id, destination: publish })
  writeFileSync(path, '检查后继续修改')
  await expect(tasks.commit(ctx, one.id, stale.task.prepared!.token)).rejects.toThrow('EDIT_CHANGED')
  expect(count(f)).toBe(1); await tasks.discardPrepared(ctx, one.id)
  const ready = await tasks.check(ctx, { taskId: one.id, destination: publish })
  writeFileSync(otherPath, '另一个仓库的修改'); const theirs = await tasks.check(other, { taskId: two.id, destination: publish })
  await tasks.commit(other, two.id, theirs.task.prepared!.token)
  await expect(tasks.commit(ctx, one.id, ready.task.prepared!.token)).rejects.toThrow('VERSION_CONFLICT')
  await tasks.discardPrepared(ctx, one.id)
  const preview = await a.api.previewFileUpdate(ai)
  await a.api.acceptFileUpdate({ id: ai, expectedPath: preview.expectedPath, contentVersion: preview.current.id, revision: preview.revision, requestId: randomUUID() })
  await expect(tasks.check(ctx, { taskId: one.id, destination: publish })).rejects.toThrow('EDIT_CONFLICT')
  const privateSpace = a.lib.files.bindings!.list().find(s => s.mode === 'private')!
  const copy = await tasks.check(ctx, { taskId: one.id, destination: { mode: 'copy', spaceId: privateSpace.id } })
  const saved = await tasks.commit(ctx, one.id, copy.task.prepared!.token)
  expect(saved.lastResult?.space.spaceId).toBe(privateSpace.id)
  expect(readFileSync(a.lib.files.readable(String(a.store.blocksOf(ai).file.data.path)), 'utf8')).toBe('检查后继续修改')
  expect(count(f)).toBe(2)
  await expect(tasks.open(other, one.id, async () => '')).rejects.toThrow()
})

it('丢失准备／发布响应仍用原请求重试；接纳失败后重启接续，不重复发布', async () => {
  const f = await setup(), { tasks, ctx, a, ai } = f
  const task = await tasks.start(ctx, { id: ai }), path = await work(tasks, ctx, task.id)
  writeFileSync(path, '等待保存')
  const prepare = ctx.api.prepareFileEdit
  ctx.api.prepareFileEdit = async input => { await prepare(input); throw new Error('准备响应丢失') }
  await expect(tasks.check(ctx, { taskId: task.id, destination: publish })).rejects.toThrow('准备响应丢失')
  ctx.api.prepareFileEdit = prepare
  let resumed = new FileEditingTasks(f.folder)
  expect((await resumed.list(ctx))[0].phase).toBe('preparing'); expect(count(f)).toBe(1)
  const checked = await resumed.check(ctx, { taskId: task.id, destination: publish })
  a.lib.db.exec("CREATE TRIGGER deny_update BEFORE UPDATE ON block WHEN NEW.kind='file' BEGIN SELECT RAISE(ABORT,'injected'); END")
  const pending = await resumed.commit(ctx, task.id, checked.task.prepared!.token)
  expect(pending.phase).toBe('pending'); expect(count(f)).toBe(2)
  a.lib.db.exec('DROP TRIGGER deny_update')
  resumed = new FileEditingTasks(f.folder)
  const commit = ctx.api.commitFileEdit
  ctx.api.commitFileEdit = async input => { await commit(input); throw new Error('提交响应丢失') }
  await expect(resumed.commit(ctx, task.id, checked.task.prepared!.token)).rejects.toThrow('提交响应丢失')
  ctx.api.commitFileEdit = commit
  writeFileSync(path, '保存后继续编辑的文字')
  const saved = await new FileEditingTasks(f.folder).commit(ctx, task.id, checked.task.prepared!.token)
  expect(saved.lastResult?.library.state).toBe('accepted'); expect(count(f)).toBe(2)
  expect(readFileSync(path, 'utf8')).toBe('保存后继续编辑的文字')
  expect((await resumed.inspectEnd(ctx, task.id)).changed).toBe(true)
  expect(readFileSync(a.lib.files.readable(String(a.store.blocksOf(ai).file.data.path)), 'utf8')).toBe('等待保存')
})

it('放弃只清理本机副本，过期确认、缺失文件、符号链接和回收素材保留处理入口', async () => {
  const f = await setup(), { tasks, ctx, ai, a } = f
  const task = await tasks.start(ctx, { id: ai }), path = await work(tasks, ctx, task.id)
  const check = await tasks.inspectEnd(ctx, task.id)
  writeFileSync(path, '尚未保存')
  await expect(tasks.discard(ctx, task.id, check.token)).rejects.toThrow('EDIT_CHANGED')
  const original = a.lib.files.readable(String(a.store.blocksOf(ai).file.data.path))
  unlinkSync(path); symlinkSync(original, path)
  await expect(tasks.check(ctx, { taskId: task.id, destination: publish })).rejects.toThrow('普通文件')
  unlinkSync(path)
  const missing = await tasks.inspectEnd(ctx, task.id); expect(missing.changed).toBe(true)
  writeFileSync(path, '保留草稿'); a.api.trash([ai])
  await expect(tasks.check(ctx, { taskId: task.id, destination: publish })).rejects.toThrow('ITEM_UNAVAILABLE')
  // 确认放弃期间迟到的外部保存会使确认过期。
  const removal = await tasks.inspectEnd(ctx, task.id); writeFileSync(path, '迟到的保存')
  await expect(tasks.discard(ctx, task.id, removal.token)).rejects.toThrow('EDIT_CHANGED')
  // 接续上一版已结束但保留副本的登记，不要求用户再经历结束／删除两步。
  const recordPath = join(dirname(path), 'state.json'), old = JSON.parse(readFileSync(recordPath, 'utf8'))
  old.ended = true; writeFileSync(recordPath, JSON.stringify(old))
  expect((await tasks.list(ctx))[0].ended).toBe(true)
  await tasks.discard(ctx, task.id, (await tasks.inspectEnd(ctx, task.id)).token)
  expect(existsSync(path)).toBe(false); expect(existsSync(original)).toBe(true)
  expect(await tasks.list(ctx)).toEqual([])
})

it('替换文件沿用同一任务协议，拒绝覆盖已有工作副本；不启动可执行格式或坏预览', async () => {
  const f = await setup(), { tasks, ctx, ai } = f
  writeFileSync(f.source, '替换结果')
  const task = await tasks.start(ctx, { id: ai, source: f.source }), path = await work(tasks, ctx, task.id)
  expect(readFileSync(path, 'utf8')).toBe('替换结果')
  await expect(tasks.start(ctx, { id: ai, source: f.source })).rejects.toThrow('EDIT_EXISTS')
  const checked = await tasks.check(ctx, { taskId: task.id, destination: publish })
  await expect(tasks.previewPath(ctx.id, task.id, randomUUID())).rejects.toThrow('预览已结束')
  await tasks.discardPrepared(ctx, task.id)
  await expect(tasks.previewPath(ctx.id, task.id, checked.task.prepared!.reference.split('/').at(-1)!)).rejects.toThrow('预览已结束')
  await tasks.discard(ctx, task.id, (await tasks.inspectEnd(ctx, task.id)).token)
  await expect(tasks.start(ctx, { id: ai, source: f.source + '.png' })).rejects.toThrow('FORMAT_MISMATCH')
  const [program] = await f.a.api.ingest([{ type: 'bytes', name: 'program.exe', bytes: new Uint8Array([1, 2, 3]) }])
  const programTask = await tasks.start(ctx, { id: program })
  expect(programTask.canOpen).toBe(false)
  await expect(tasks.open(ctx, programTask.id, async () => { throw new Error('不应启动') })).rejects.toThrow('EDITOR_REQUIRED')
  // 受控流程创建副本后，上游显式编辑不会被本机任务覆盖。
  const next = await tasks.start(ctx, { id: ai })
  writeFileSync(f.source, '另一入口的保存'); await f.a.api.commitFileEdit(await prepareVersionEdit(f.a, ai, f.source))
  const nextPath = await work(tasks, ctx, next.id); writeFileSync(nextPath, '自己的内容')
  await expect(tasks.check(ctx, { taskId: next.id, destination: publish })).rejects.toThrow('EDIT_CONFLICT')
})


it('完成编辑组合发布、接纳和清理；无变化不发版，清理失败后重启只清理，重复完成不影响新任务', async () => {
  const f = await setup(), { tasks, ctx, ai } = f
  const unchanged = await tasks.start(ctx, { id: ai }), first = await work(tasks, ctx, unchanged.id)
  expect(await tasks.finish(ctx, { taskId: unchanged.id })).toBeNull()
  expect(count(f)).toBe(1); expect(existsSync(first)).toBe(false)
  const task = await tasks.start(ctx, { id: ai }), path = await work(tasks, ctx, task.id)
  writeFileSync(path, '一键完成')
  // 真实外部编辑器可能生成辅助文件；未知内容不递归删除，保留“待清理”。
  const sidecar = join(dirname(path), 'external-project.data'); writeFileSync(sidecar, '保留')
  await expect(tasks.finish(ctx, { taskId: task.id })).rejects.toThrow('其他文件')
  expect((await tasks.list(ctx))[0].phase).toBe('cleanup'); expect(count(f)).toBe(2)
  const resumed = new FileEditingTasks(f.folder)
  unlinkSync(sidecar)
  expect(await resumed.finish(ctx, { taskId: task.id })).toBeNull()
  expect(existsSync(path)).toBe(false); expect(count(f)).toBe(2); expect(await resumed.list(ctx)).toEqual([])
  const next = await resumed.start(ctx, { id: ai }), nextPath = await work(resumed, ctx, next.id)
  writeFileSync(nextPath, '新工作副本')
  expect(await resumed.finish(ctx, { taskId: task.id })).toBeNull()
  expect(readFileSync(nextPath, 'utf8')).toBe('新工作副本'); expect(count(f)).toBe(2)
})

it('完成编辑在接纳失败、响应丢失及清理前迟到保存时保留副本；原请求重试不重复发布', async () => {
  const f = await setup(), { tasks, ctx, a, ai } = f
  const task = await tasks.start(ctx, { id: ai }), path = await work(tasks, ctx, task.id)
  writeFileSync(path, '需要接纳')
  a.lib.db.exec("CREATE TRIGGER deny_update BEFORE UPDATE ON block WHEN NEW.kind='file' BEGIN SELECT RAISE(ABORT,'injected'); END")
  expect((await tasks.finish(ctx, { taskId: task.id }))?.phase).toBe('pending')
  expect(count(f)).toBe(2); expect(existsSync(path)).toBe(true)
  await expect(tasks.discard(ctx, task.id, (await tasks.inspectEnd(ctx, task.id)).token)).rejects.toThrow()
  a.lib.db.exec('DROP TRIGGER deny_update')
  const commit = ctx.api.commitFileEdit
  ctx.api.commitFileEdit = async input => { await commit(input); throw new Error('回执响应丢失') }
  await expect(tasks.finish(ctx, { taskId: task.id })).rejects.toThrow('回执响应丢失')
  ctx.api.commitFileEdit = commit
  writeFileSync(path, '提交期间又保存的内容')
  const resumed = new FileEditingTasks(f.folder)
  await expect(resumed.finish(ctx, { taskId: task.id })).rejects.toThrow('又有修改')
  expect(readFileSync(path, 'utf8')).toBe('提交期间又保存的内容'); expect(count(f)).toBe(2)
  const sidecar = join(dirname(path), 'editor.backup'); writeFileSync(sidecar, '保留')
  await expect(resumed.finish(ctx, { taskId: task.id })).rejects.toThrow('其他文件')
  expect(count(f)).toBe(3)
  writeFileSync(path, '清理待重试时又改了')
  unlinkSync(sidecar)
  await expect(resumed.finish(ctx, { taskId: task.id })).rejects.toThrow('EDIT_CHANGED')
  expect(existsSync(path)).toBe(true); expect(count(f)).toBe(3)
  expect(await resumed.finish(ctx, { taskId: task.id })).toBeNull()
  expect(count(f)).toBe(4); expect(existsSync(path)).toBe(false)
})

it('完成恢复核对实际引用；旧接受回执不能宣称本库已采用，也不清理工作副本', async () => {
  const f = await setup(), { tasks, ctx, a, ai } = f
  const task = await tasks.start(ctx, { id: ai }), path = await work(tasks, ctx, task.id)
  writeFileSync(path, '第一次已保存但响应丢失')
  const commit = ctx.api.commitFileEdit
  ctx.api.commitFileEdit = async input => { await commit(input); throw new Error('模拟断线') }
  await expect(tasks.finish(ctx, { taskId: task.id })).rejects.toThrow('模拟断线')
  ctx.api.commitFileEdit = commit
  writeFileSync(f.source, '另一入口更新了引用')
  await a.api.commitFileEdit(await prepareVersionEdit(a, ai, f.source))
  const current = a.store.blocksOf(ai).file.data.path
  const resumed = new FileEditingTasks(f.folder)
  expect((await resumed.finish(ctx, { taskId: task.id }))?.phase).toBe('unadopted')
  expect(a.store.blocksOf(ai).file.data.path).toBe(current); expect(existsSync(path)).toBe(true)
  expect(count(f)).toBe(3)
  await resumed.discard(ctx, task.id, (await resumed.inspectEnd(ctx, task.id)).token)
  expect(a.store.blocksOf(ai).file.data.path).toBe(current)
})
