import { afterEach, expect, it } from 'vitest'
import { z } from 'zod'
import type { CorePlugin } from '../../src/core/plugin'
import { filePlugin } from '../../src/plugins/file/core'
import { openHost } from '../helpers/helpers'

const schema = z.object({ id: z.string(), kind: z.string(), data: z.record(z.string(), z.unknown()), remove: z.boolean().optional() })
const probe: CorePlugin = {
  id: 'probe', version: 1,
  blocks: [false, true].map(rebuildable => ({ id: rebuildable ? 'derivedMemo' : 'memo', plugin: 'probe', title: '备忘', version: 1, rebuildable,
    fields: { text: { type: 'text' as const, title: '文字', search: true } } })),
  commands: {
    write(ctx, raw) {
      const { id, kind, data, remove } = schema.parse(raw)
      // 第二步被拒绝时，前面的合法写入也必须回滚。
      const created = ctx.createEntity(); ctx.put(created, 'memo', { text: 'temporary' })
      if (remove) ctx.remove(id, kind)
      else ctx.put(id, kind, data)
      return { label: '批量写入', result: created }
    }
  },
  operations: [{ name: 'probe_write', title: '写入', description: '验证公共命令边界', command: 'write', input: schema }]
}
const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).reverse().forEach(f => f()))
function setup() { const h = openHost([filePlugin, probe], { manifest: [] }); cleanups.push(h.cleanup); return h.host }

it.each(['run', 'preview', 'operation'] as const)('%s 拒绝孤立块和派生块，整笔写入及回执回滚', async mode => {
  const h = setup(), id = await h.api.create({ memo: { text: 'keep' } })
  h.store.put(id, 'derivedMemo', { text: 'computed' })
  const run = (args: z.infer<typeof schema>) => mode === 'operation'
    ? h.api.executeOperation({ operation: 'probe_write', requestId: 'guarded-write', args })
    : h.api[mode]('probe', 'write', args)
  for (const args of [
    { id: 'missing', kind: 'memo', data: { text: 'orphan' } },
    { id, kind: 'derivedMemo', data: { text: 'forged' } },
    { id, kind: 'derivedMemo', data: {}, remove: true },
  ]) {
    expect(() => run(args)).toThrow(/不存在|可重建/)
    expect((await h.api.query({ scope: 'all' })).ids).toEqual([id])
    expect(h.store.blocksOf('missing')).toEqual({})
    expect(h.store.blocksOf(id).derivedMemo.data.text).toBe('computed')
    expect(h.lib.db.prepare('SELECT count(*) FROM operation_receipt').pluck().get()).toBe(0)
    expect(h.lib.db.prepare('SELECT count(*) FROM operation').pluck().get()).toBe(1)
  }
  const created = run({ id, kind: 'memo', data: { text: 'changed' } })
  if (mode === 'preview') {
    expect(h.store.exists(String(created))).toBe(false)
    expect(h.store.blocksOf(id).memo.data.text).toBe('keep')
  } else {
    expect(h.store.blocksOf(id).memo.data.text).toBe('changed')
    h.api.undo(); expect(h.store.blocksOf(id).memo.data.text).toBe('keep')
    h.api.redo(); expect(h.store.blocksOf(id).memo.data.text).toBe('changed')
  }
})

it('UI、命令和外部操作拒绝换文件引用，允许离线改显示名；原收录关系与字节保持', async () => {
  const h = setup()
  const [a, b] = await h.api.ingest(['a', 'b'].map(text => ({ type: 'bytes', name: `${text}.txt`, bytes: new TextEncoder().encode(text) })))
  const original = h.store.blocksOf(a).file.data, other = h.store.blocksOf(b).file.data
  const adoption = h.lib.db.prepare('SELECT * FROM space_adoptions ORDER BY file_id').all()
  expect(() => h.api.put(a, 'file', other)).toThrow(/文件信息/)
  expect(() => h.api.patch(a, 'file', other)).toThrow(/文件信息/)
  for (const mode of ['run', 'preview', 'operation'] as const) {
    const args = { id: a, kind: 'file', data: other }
    expect(() => mode === 'operation' ? h.api.executeOperation({ operation: 'probe_write', requestId: 'redirect', args }) : h.api[mode]('probe', 'write', args)).toThrow(/文件信息/)
  }
  expect(h.store.blocksOf(a).file.data).toEqual(original)
  expect(h.lib.db.prepare('SELECT * FROM space_adoptions ORDER BY file_id').all()).toEqual(adoption)
  // 文件不可用不应阻止仅修改仓库显示信息。
  const space = h.lib.files.bindings!.default().space
  space.db.prepare("UPDATE files SET state='recycled'").run()
  h.api.run('file', 'rename', { names: { [a]: 'renamed' } })
  expect(h.store.blocksOf(a).file.data).toEqual({ ...original, name: 'renamed.txt' })
  h.api.undo(); expect(h.store.blocksOf(a).file.data).toEqual(original)
})
