import { expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { openHost } from '../helpers/helpers'
import { spaceReference } from '../../src/storage/space-reference'
import { directoryReference } from '../../src/storage/directory-reference'
import { itemSelectionLimit } from '../../src/shared/item-lifecycle'
import { spaceItemPageSize } from '../../src/shared/space-items'

it('来源盘点区分主文件、附件、未辨认引用和回收站，执行时复核来源及状态', async () => {
  const { host, cleanup } = openHost()
  try {
    const space = randomUUID(), other = randomUUID()
    const path = directoryReference(space, randomUUID(), 'a'.repeat(64), '文稿.md')
    const another = spaceReference(other, randomUUID(), '副本.md', randomUUID())
    const file = (ref: string) => ({ name: '文稿', path: ref })
    const make = (ref: string) => {
      const id = host.store.createEntity(); host.store.put(id, 'file', file(ref)); return id
    }
    const main = make(path), otherMain = make(another)
    const note = await host.api.create({ text: { content: '独立笔记' } })
    const unknown = await host.api.create({ text: { content: path } })
    // 旧插件未加载，保留下来的文件列表字段仍有可判定的用途。
    host.reg.setDormant([{ id: 'archive-attachment', plugin: 'archive', title: '附件', version: 1, rebuildable: false,
      fields: { files: { type: 'text', list: true, file: true, title: '附件' } } }])
    for (const id of [main, otherMain, note]) host.store.put(id, 'archive-attachment', { files: [path, path] }, true)
    const list = (group: 'primary' | 'trashed' | 'attachment' | 'unclassified') => host.api.listSpaceItems({ spaceId: space, group, offset: 0 })
    expect((await list('primary')).counts).toEqual({ primary: 1, attachment: 2, unclassified: 1, trashed: 0 })
    expect((await list('attachment')).items.map(r => r.id).sort()).toEqual([note, otherMain].sort())
    expect((await list('unclassified')).batchIds).toEqual([])
    expect((await list('unclassified')).items[0].id).toBe(unknown)
    const selection = { action: 'trash' as const, primarySpaceId: space, ids: [main] }
    expect(() => host.api.previewItemLifecycle({ ...selection, ids: [main, note] })).toThrow('主文件来源')
    const plan = await host.api.previewItemLifecycle(selection)
    const request = { ...selection, requestId: randomUUID(), previewToken: plan.previewToken }
    host.store.put(main, 'file', file(another))
    expect(() => host.api.applyItemLifecycle(request)).toThrow('主文件来源')
    expect(host.store.isTrashed(main)).toBe(false)
    host.store.put(main, 'file', file(path))
    const fresh = await host.api.previewItemLifecycle(selection)
    const applied = { ...request, previewToken: fresh.previewToken }
    await host.api.applyItemLifecycle(applied)
    expect((await host.api.applyItemLifecycle(applied)).replayed).toBe(true)
    await host.api.trash([note])
    const trash = await list('trashed')
    expect(trash.counts.trashed).toBe(2)
    expect(trash.batchIds).toEqual([main])
    expect(() => host.api.previewItemLifecycle(selection)).toThrow('回收状态')
    expect(() => host.api.previewItemLifecycle({ ...selection, action: 'restore', ids: [note] })).toThrow('主文件来源')
    expect((await host.api.listSpaceItems({ spaceId: other, group: 'primary', offset: 0 })).batchIds).toEqual([otherMain])
  } finally { await host.scheduler.idle(); cleanup() }
})

it('批选跨页固定身份，一次最多处理生命周期入口允许的主文件数', async () => {
  const { host, cleanup } = openHost([])
  try {
    const space = randomUUID(), path = spaceReference(space, randomUUID(), '索引.md', randomUUID())
    const db = host.lib.db
    const entity = db.prepare('INSERT INTO main.entity(id,created_at) VALUES (?,1)')
    const block = db.prepare("INSERT INTO main.block(entity_id,kind,data,seq,schema_ver,updated_at) VALUES (?,'file',?,1,1,1)")
    db.transaction(() => {
      for (let i = 0; i <= itemSelectionLimit; i++) {
        const id = 'item-' + String(i).padStart(4, '0')
        entity.run(id); block.run(id, JSON.stringify({ path }))
      }
    })()
    const page = await host.api.listSpaceItems({ spaceId: space, group: 'primary', offset: spaceItemPageSize })
    expect(page.items).toHaveLength(spaceItemPageSize)
    expect(page.items[0].id).toBe('item-0050')
    expect(page.selectable).toBe(itemSelectionLimit + 1)
    expect(page.batchIds).toHaveLength(itemSelectionLimit)
    expect(page.batchIds.at(-1)).toBe('item-0999')
  } finally { cleanup() }
})
