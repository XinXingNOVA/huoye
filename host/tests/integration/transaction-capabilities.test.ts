import { afterEach, expect, it, vi } from 'vitest'
import { writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { openHost } from '../helpers/helpers'
import { filePlugin } from '../../src/plugins/file/core'
import { plugin } from '../../examples/transaction-plugin/core'
import type { CorePlugin, CommandContext } from '../../src/plugin-api/core/contracts'
import type { IngestMetadataContext } from '../../src/plugin-api/ingest'
import type { IngestResult } from '../../src/plugin-api/operations'
import { packageManifestSchema } from '../../src/shared/external-plugins'

let current: ReturnType<typeof openHost> | undefined
afterEach(() => { current?.cleanup(); current = undefined })
const setup = (extra: CorePlugin[] = [], file = filePlugin) => (current = openHost([file, plugin, ...extra])).host
const inputFile = () => { const p = join(current!.root, 'input.txt'); writeFileSync(p, 'transaction content'); return p }
const group = async (h: ReturnType<typeof setup>) => (await h.api.run(plugin.id, 'create', { title: '组' }) as { id: string }).id
const request = (path: string, group: string) => ({ operation: 'import_files', requestId: 'join-reference-001', args: { files: [{ path, metadata: { 'demo-container.join': { group } } }] } })

it('提交时检查引用目标，导入关系与文件一次撤销；删除组不删除 link 成员', async () => {
  const h = setup(), id = await group(h), path = inputFile(), req = request(path, id)
  const first = await h.api.executeOperation(req), member = (first.result as IngestResult).items[0].id
  expect(h.store.blocksOf(member)['demo-container.member'].data.group).toBe(id)
  await h.api.undo(); expect(h.store.isTrashed(member)).toBe(true)
  await h.api.redo()
  const del = { operation: 'demo_container_trash', requestId: 'trash-reference-001', args: { id } }
  const result = await h.api.executeOperation(del)
  expect(h.store.isTrashed(id)).toBe(true); expect(h.store.isTrashed(member)).toBe(false)
  expect(await h.api.executeOperation(del)).toEqual({ ...result, replayed: true })
  await h.api.undo(); expect(h.store.isTrashed(id)).toBe(false)
  expect((await h.api.executeOperation(del)).replayed).toBe(true); expect(h.store.isTrashed(id)).toBe(false)
  expect(readFileSync(path, 'utf8')).toBe('transaction content')
})
it('复制期间目标删除，提交时拒绝整批；恢复后同 requestId 可以重试', async () => {
  let started!: () => void, release!: () => void
  const began = new Promise<void>(r => { started = r }), gate = new Promise<void>(r => { release = r })
  const slow: CorePlugin = { ...filePlugin, recognizers: [{ ...filePlugin.recognizers![0], async ingest(ctx, input) {
    const id = await filePlugin.recognizers![0].ingest(ctx, input); started(); await gate; return id
  } }] }
  const h = setup([], slow), id = await group(h), req = request(inputFile(), id), pending = h.api.executeOperation(req)
  await began; await h.api.run(plugin.id, 'trash', { id }); release()
  await expect(pending).rejects.toThrow('目标不是有效容器')
  expect((await h.api.query({ has: ['file'] })).ids).toEqual([])
  expect(h.lib.db.prepare('SELECT count(*) FROM operation_receipt').pluck().get()).toBe(0)
  expect(h.lib.files.bindings!.default().space.db.prepare("SELECT count(*) FROM files WHERE state='available'").pluck().get()).toBe(1)
  await h.api.undo(); expect((await h.api.executeOperation(req)).replayed).toBe(false)
})
it('只读快照区分不存在和回收站；只返回指定块，修改副本不写回，结束后不可继续读', async () => {
  let saved!: IngestMetadataContext
  const reader: CorePlugin = { id: 'reader', version: 1, ingestMetadata: [{ id: 'reader.check', title: '检查', description: '检查快照', input: z.object({ id: z.string() }), apply(ctx, input) {
    saved = ctx
    expect(ctx.readEntity('missing', [])).toBeNull()
    const v = ctx.readEntity(input.id as string, ['demo-container'])!
    expect(v.deleted).toBe(true); v.blocks['demo-container'].data.title = '不能写回'
    expect(ctx.readEntity(input.id as string, [])?.blocks).toEqual({})
    return { status: 'unchanged' }
  } }] }
  const h = setup([reader]), id = await group(h)
  await h.api.trash([id])
  await h.api.ingest([{ type: 'file', path: inputFile(), metadata: { 'reader.check': { id } } }])
  expect(h.store.blocksOf(id)['demo-container'].data.title).toBe('组')
  expect(() => saved.readEntity(id, [])).toThrow('已经结束')
})
it('读取次数和大小有界，引用目标错误时不会留下新素材身份', async () => {
  const reader: CorePlugin = { id: 'reader', version: 1, ingestMetadata: [{ id: 'reader.check', title: '检查', description: '检查边界', input: z.object({ id: z.string(), loop: z.boolean() }), apply(ctx, input) {
    for (let n = 0; n < (input.loop ? 101 : 1); n++) ctx.readEntity(input.id as string, ['demo-container'])
    return { status: 'unchanged' }
  } }] }
  const h = setup([reader]), id = await group(h), path = inputFile()
  for (const target of ['missing', h.store.createEntity()]) await expect(h.api.executeOperation({ ...request(path, target), requestId: `invalid-${target}` })).rejects.toThrow('目标不是有效容器')
  await expect(h.api.ingest([{ type: 'file', path, metadata: { 'reader.check': { id, loop: true } } }])).rejects.toThrow('INGEST_READ_LIMIT')
  h.store.put(id, 'demo-container', { title: 'x'.repeat(1024 * 1024) })
  await expect(h.api.ingest([{ type: 'file', path, metadata: { 'reader.check': { id, loop: false } } }])).rejects.toThrow('INGEST_READ_LIMIT')
  expect((await h.api.query({ has: ['file'] })).ids).toEqual([])
})
it('命令回收站沿用 attach 级联；预演与失败不取消加工，提交后取消，支持撤销重做', async () => {
  let retained!: CommandContext
  const extra: CorePlugin = { id: 'extra', version: 1, blocks: [
    { id: 'extra.child', plugin: 'extra', version: 1, title: '依附', rebuildable: false, content: true, fields: { parent: { type: 'ref', title: '父项', ref: 'attach' } } },
    { id: 'extra.management', plugin: 'extra', version: 1, title: '管理', rebuildable: false, standalone: true, management: {}, fields: { title: { type: 'text', title: '名称' } } }
  ], commands: { trash(ctx, args) { retained = ctx; ctx.trash(args.ids as string[]); if (args.fail) throw new Error('故意失败'); return { label: '删除', result: true } } } }
  const h = setup([extra]), id = await group(h), child = h.store.createEntity()
  h.store.put(child, 'extra.child', { parent: id })
  const cancel = vi.spyOn(h.scheduler, 'cancel')
  await h.api.preview('extra', 'trash', { ids: [id] }); expect(h.store.isTrashed(id)).toBe(false)
  expect(() => h.api.run('extra', 'trash', { ids: [id], fail: true })).toThrow('故意失败')
  expect(cancel.mock.calls.every(([ids]) => !ids.length)).toBe(true)
  expect(() => retained.trash([id])).toThrow('COMMAND_CONTEXT_EXPIRED')
  await h.api.run('extra', 'trash', { ids: [id, id] })
  expect(h.store.isTrashed(child)).toBe(true); expect(cancel).toHaveBeenCalledWith(expect.arrayContaining([id, child]))
  await h.api.undo(); expect(h.store.isTrashed(child)).toBe(false)
  await h.api.redo(); expect(h.store.isTrashed(child)).toBe(true)
  await h.api.undo()
  const managed = h.store.createEntity(); h.store.put(managed, 'extra.management', { title: '配置' })
  for (const ids of [[id, 'missing'], [id, managed], Array(101).fill(id), []]) {
    expect(() => h.api.run('extra', 'trash', { ids })).toThrow()
    expect(h.store.isTrashed(id)).toBe(false)
  }
  await h.api.run('extra', 'trash', { ids: [id] })
  await h.api.run('extra', 'trash', { ids: [id] }) // 已在回收站不制造新的撤销步骤
  await h.api.undo(); expect(h.store.isTrashed(id)).toBe(false)
})
it('新核心能力声明兼容检查要求导入读取同时声明导入协议', () => {
  const base = { formatVersion: 1, apiVersion: 1, id: 'test', title: '测试', description: '', author: '测试', version: '1.0.0', entries: { core: 'core.mjs' } }
  expect(packageManifestSchema.safeParse({ ...base, coreFeatures: ['ingest-read-v1'] }).success).toBe(false)
  expect(packageManifestSchema.safeParse({ ...base, coreFeatures: ['ingest-metadata-v1', 'ingest-read-v1', 'command-trash-v1'] }).success).toBe(true)
})
it('异步命令立即拒绝并回滚同步部分，延迟回收不能逃出事务', async () => {
  let lateError = ''
  const bad: CorePlugin = { id: 'bad', version: 1, commands: { invalid: (async (ctx: CommandContext, args: Record<string, unknown>) => {
    ctx.put(args.id as string, 'demo-container', { title: '应回滚' })
    await Promise.resolve()
    try { ctx.trash([args.id as string]) } catch (error) { lateError = String(error) }
    return { label: '错误示例' }
  }) as unknown as NonNullable<CorePlugin['commands']>[string] } }
  const h = setup([bad]), id = await group(h)
  expect(() => h.api.run('bad', 'invalid', { id })).toThrow('命令必须同步执行')
  await Promise.resolve()
  expect(lateError).toContain('COMMAND_CONTEXT_EXPIRED')
  expect(h.store.isTrashed(id)).toBe(false)
  expect(h.store.blocksOf(id)['demo-container'].data.title).toBe('组')
})
it('公共恢复沿用 attach 回收批次，link 不随行；预演回滚、输入边界与过期上下文',async()=>{
  let retained!:CommandContext
  const extra:CorePlugin={id:'recovery',version:1,blocks:[
    {id:'recovery.child',plugin:'recovery',title:'依附',version:1,rebuildable:false,content:true,fields:{parent:{type:'ref',title:'父项',ref:'attach'}}},
    {id:'recovery.link',plugin:'recovery',title:'关联',version:1,rebuildable:false,content:true,fields:{parent:{type:'ref',title:'父项',ref:'link'}}},
    {id:'recovery.managed',plugin:'recovery',title:'管理',version:1,rebuildable:false,standalone:true,management:{},fields:{name:{type:'text',title:'名'}}}
  ],commands:{restore(ctx,args){retained=ctx;ctx.restore(args.ids as string[]);if(args.fail)throw new Error('回滚');return{label:'恢复'}}}}
  const h=setup([extra]),parent=await group(h),child=await h.api.create({'recovery.child':{parent}}),earlier=await h.api.create({'recovery.child':{parent}}),link=await h.api.create({'recovery.link':{parent}})
  h.api.trash([earlier]);h.api.trash([parent]);h.api.trash([link])
  h.api.preview('recovery','restore',{ids:[parent]});expect(h.store.isTrashed(parent)).toBe(true)
  expect(()=>h.api.run('recovery','restore',{ids:[parent],fail:true})).toThrow('回滚');expect(h.store.isTrashed(child)).toBe(true)
  const managed=await h.api.create({'recovery.managed':{name:'管理记录'}})
  for(const ids of [[],Array(101).fill(parent),[parent,'missing'],[parent,managed]])expect(()=>h.api.run('recovery','restore',{ids})).toThrow()
  h.api.run('recovery','restore',{ids:[parent,parent]})
  expect(h.store.isTrashed(parent)).toBe(false);expect(h.store.isTrashed(child)).toBe(false)
  expect(h.store.isTrashed(earlier)).toBe(true);expect(h.store.isTrashed(link)).toBe(true)
  expect(()=>retained.restore([parent])).toThrow('COMMAND_CONTEXT_EXPIRED')
  h.api.run('recovery','restore',{ids:[parent]});h.api.undo();expect(h.store.isTrashed(parent)).toBe(true)
  h.api.redo();expect(h.store.isTrashed(child)).toBe(false)
})
