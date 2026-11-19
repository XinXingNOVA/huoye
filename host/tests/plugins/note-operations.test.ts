import { afterEach, expect, it } from 'vitest'
import { notePlugin } from '@test-plugins/note/core'
import { tagsPlugin } from '@test-plugins/tags/core'
import { textPlugin } from '../../src/plugins/text/core'
import { openHost } from '../helpers/helpers'

let current: ReturnType<typeof openHost> | undefined
afterEach(() => { current?.cleanup(); current = undefined })
const setup = () => (current = openHost([notePlugin, tagsPlugin, textPlugin], {
  manifest: ['note', 'tags', 'text'].map(id => ({ id, title: id, description: '' }))
})).host

it('笔记操作保留 Markdown 空白、其他数据和回执，写入与删除均可撤销', async () => {
  const h = setup(), id = await h.api.create({ text: { content: '原文' }, tags: { values: ['保留'] } })
  const text = '    缩进代码\n\n尾部换行\n'
  const request = { operation: 'set_note', requestId: 'note-create', args: { id, text, expectedSeq: null } }
  expect((await h.api.describeLibrary()).operations.map(o => o.name)).toContain('set_note')
  const result = await h.api.executeOperation(request)
  const seq = (await h.api.readItem({ id, kinds: ['note'] })).fields[0].seq
  expect(result.result).toEqual({ id, seq })
  expect(h.store.blocksOf(id).note.data.text).toBe(text)
  expect(await h.api.executeOperation(request)).toEqual({ ...result, replayed: true })
  await h.api.undo()
  expect(h.store.blocksOf(id).note).toBeUndefined()
  expect(h.store.blocksOf(id).tags.data.values).toEqual(['保留'])
  expect(h.store.blocksOf(id).text.data.content).toBe('原文')
  await h.api.redo()
  const restoredSeq = (await h.api.readItem({ id, kinds: ['note'] })).fields[0].seq
  expect(await h.api.executeOperation({ operation: 'set_note', requestId: 'note-delete', args: { id, text: ' \n ', expectedSeq: restoredSeq } })).toMatchObject({ result: { id, seq: null } })
  expect(h.store.blocksOf(id).note).toBeUndefined()
  await h.api.undo()
  expect(h.store.blocksOf(id).note.data.text).toBe(text)
})

it('版本检查拒绝覆盖新笔记或重新创建已被删除的笔记', async () => {
  const h = setup(), id = await h.api.create({ text: { content: '原文' }, tags: { values: ['保留'] }, note: { text: '初稿' } })
  const seq = (await h.api.readItem({ id, kinds: ['note'] })).fields[0].seq
  await h.api.patch(id, 'note', { text: '用户的新稿' })
  const write = (requestId: string, expectedSeq: number | null) => h.api.executeOperation({ operation: 'set_note', requestId, args: { id, text: 'AI 改稿', expectedSeq } })
  expect(() => write('stale-note', seq)).toThrow('NOTE_CHANGED')
  expect(() => write('unexpected-note', null)).toThrow('NOTE_CHANGED')
  expect(h.store.blocksOf(id).note.data.text).toBe('用户的新稿')
  await h.api.remove(id, 'note')
  expect(() => write('removed-note', seq)).toThrow('笔记已被删除')
  expect(h.store.blocksOf(id).note).toBeUndefined()
  await write('new-note', null)
  expect(h.store.blocksOf(id).note.data.text).toBe('AI 改稿')
})

it('拒绝向不存在、回收站或管理记录写笔记，并验证输入', async () => {
  const h = setup(), id = await h.api.create({ text: { content: '原文' }, tags: { values: ['保留'] }, note: { text: '原稿' } })
  const managed = await h.api.create({ tagGroups: { groups: [{ id: 'group', title: '分组', tags: [] }] } })
  const write = (target: string, text = '新稿') => h.api.executeOperation({ operation: 'set_note', requestId: `reject-${target}`, args: { id: target, text } })
  expect(() => write(id, 'x'.repeat(32001))).toThrow('INVALID_INPUT')
  await h.api.trash([id])
  for (const target of ['missing', id, managed]) expect(() => write(target)).toThrow('NOT_FOUND')
  expect(h.store.blocksOf(id).note.data.text).toBe('原稿')
  expect(h.store.blocksOf(managed).note).toBeUndefined()
})
