import { afterEach, expect, it, vi } from 'vitest'
import { EditSessions } from '../../src/renderer/src/editing-sessions'
import { openHost } from '../helpers/helpers'
import type { EditCommit } from '../../src/plugin-api/ui/editing'
const managers: EditSessions[] = []
const manager = () => { const m = new EditSessions(); managers.push(m); return m }
afterEach(() => { managers.forEach(m => m.dispose()); managers.length = 0; vi.useRealTimers() })
it('同身份共享、窗口隔离；保存飞行期间新输入被串行保存，共享撤销不随成功保存清空', async () => {
  vi.useFakeTimers()
  const m = manager(), initial = { text: 'a', revision: 1 }
  let release!: (value: any) => void
  const commit = vi.fn<EditCommit>().mockImplementationOnce(() => new Promise(r => release = r)).mockResolvedValueOnce({ accepted: true, current: { text: 'abc', revision: 3 } })
  const a = m.open('text:1', initial, commit), b = m.open('text:1', initial, commit)
  expect(a).toBe(b); expect(manager().open('text:1', initial, commit)).not.toBe(a)
  a.change('ab'); const saving = a.save(); await Promise.resolve()
  b.change('abc'); b.observe({ text: 'ab', revision: 2 })
  release({ accepted: true, current: { text: 'ab', revision: 2 } }); await saving
  expect(commit).toHaveBeenLastCalledWith({ text: 'ab', revision: 2 }, 'abc')
  expect(b.snapshot().dirty).toBe(false)
  b.undo(); expect(a.snapshot().text).toBe('ab'); a.redo(); expect(b.snapshot().text).toBe('abc')
})
it('失败可重试；恢复草稿时比较底稿，冲突需显式选择，远端更新后不强行覆盖', async () => {
  vi.useFakeTimers()
  const m = manager(), initial = { text: 'base', revision: 1 }
  const commit = vi.fn<EditCommit>().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ accepted: false, current: { text: 'remote', revision: 2 } })
  const a = m.open('text:1', initial, commit); a.change('draft')
  await expect(a.save()).rejects.toThrow('offline'); expect(a.snapshot().text).toBe('draft')
  await expect(a.save()).rejects.toThrow('冲突'); expect(a.snapshot().conflict?.text).toBe('remote')
  const n = manager(); n.restore(m.export())
  const recovered = n.open('text:1', { text: 'remote', revision: 2 }, commit)
  expect(recovered.snapshot().conflict?.text).toBe('remote'); expect(recovered.snapshot().text).toBe('draft')
  recovered.resolve('draft'); expect(recovered.snapshot().base.revision).toBe(2)
  recovered.observe({ text: 'new remote', revision: 3 }); expect(recovered.snapshot().conflict?.text).toBe('new remote')
  recovered.resolve('remote'); expect(recovered.snapshot().text).toBe('new remote'); expect(n.export()).toEqual({})
  const orphan = manager(); orphan.restore(m.export())
  expect(orphan.get('text:1')?.snapshot().text).toBe('draft')
  await expect(orphan.get('text:1')!.save()).rejects.toThrow('尚未连接')
  orphan.get('text:1')!.discard(); expect(orphan.export()).toEqual({})
  // 已提交但响应丢失：恢复时正文一致即可确认成功，不再次写入。
  const k = manager(); k.restore(m.export())
  expect(k.open('text:1', { text: 'draft', revision: 5 }, commit).snapshot().dirty).toBe(false)
})
it('文字条件写入与回收、移除、仓库撤销共用真实事务；过期底稿不能覆盖', () => {
  const h = openHost()
  try {
    const id = h.host.api.create({ text: { content: 'base' } }) as string
    const seq = h.host.store.blocksOf(id).text.seq
    const save = (revision: number, text: string) => h.host.api.run('text', 'save', { id, revision, text }) as any
    const good = save(seq, 'new'); expect(good.accepted).toBe(true)
    expect(save(seq, 'stale')).toEqual({ accepted: false, current: good.current })
    h.host.api.undo(); expect(h.host.store.blocksOf(id).text.data.content).toBe('base')
    expect(save(good.current.revision, 'stale').accepted).toBe(false)
    h.host.api.trash([id]); expect(() => save(seq, 'bad')).toThrow('回收站')
    h.host.api.restore([id]); h.host.api.remove(id, 'text'); expect(() => save(seq, 'bad')).toThrow('文字数据块')
  } finally { h.cleanup() }
})

const inputHint = (type: string, before: number, after: number, source = 'page-a') => ({ source, inputType: type, before: { start: before, end: before }, after: { start: after, end: after } })
it('连续输入按词句合并，删除按方向合并；停顿与最长时段分界，自动保存不切断输入', async () => {
  vi.useFakeTimers()
  let revision = 1
  const s = manager().open('text:groups', { text: '', revision }, async (_base, text) => ({ accepted: true, current: { text, revision: ++revision } }))
  s.change('h', inputHint('insertText', 0, 1))
  s.change('he', inputHint('insertText', 1, 2))
  await s.save()
  s.change('hey ', inputHint('insertText', 2, 4))
  s.change('hey yo', inputHint('insertText', 4, 6))
  s.undo(); expect(s.snapshot().text).toBe('hey ')
  s.undo(); expect(s.snapshot().text).toBe('')
  s.redo(); s.redo(); expect(s.snapshot().text).toBe('hey yo')
  s.change('hey y', inputHint('deleteContentBackward', 6, 5))
  s.change('hey ', inputHint('deleteContentBackward', 5, 4))
  s.undo(); expect(s.snapshot().text).toBe('hey yo')
  s.change('hey o', inputHint('deleteContentForward', 4, 4))
  s.change('hey ', inputHint('deleteContentForward', 4, 4))
  s.undo(); expect(s.snapshot().text).toBe('hey yo')
  s.change('hey yoa', inputHint('insertText', 6, 7))
  vi.setSystemTime(Date.now() + 1100)
  s.change('hey yoab', inputHint('insertText', 7, 8))
  s.undo(); expect(s.snapshot().text).toBe('hey yoa')
  // 即使从不停顿，也不会把很长一段输入合成一次巨大的撤销。
  const t = manager().open('text:long', { text: '', revision: 1 }, async () => { throw new Error('not saved') })
  for (let i = 1; i <= 8; i++) { vi.setSystemTime(Date.now() + 900); t.change('a'.repeat(i), inputHint('insertText', i - 1, i)) }
  t.undo(); expect(t.snapshot().text).toBe('a'.repeat(6))
})
it('粘贴、选区替换、换行和程序化插入独立；移动位置与多视图切换不能串成一段，撤销后新编辑清掉重做', () => {
  vi.useFakeTimers()
  const s = manager().open('text:boundaries', { text: '', revision: 1 }, async () => { throw new Error('not saved') })
  s.change('a', inputHint('insertText', 0, 1))
  s.change('aPASTE', inputHint('insertFromPaste', 1, 6))
  s.change('aPASTEx', inputHint('insertText', 6, 7))
  s.undo(); expect(s.snapshot().text).toBe('aPASTE')
  s.undo(); expect(s.snapshot().text).toBe('a')
  s.change('b', { ...inputHint('insertText', 0, 1), before: { start: 0, end: 1 } })
  s.change('b\n', inputHint('insertLineBreak', 1, 2))
  s.undo(); expect(s.snapshot().text).toBe('b')
  s.undo(); expect(s.snapshot().text).toBe('a')
  s.change('ab', inputHint('insertText', 1, 2))
  s.change('abc', inputHint('insertText', 2, 3, 'inspector'))
  s.undo(); expect(s.snapshot().text).toBe('ab')
  s.change('axb', inputHint('insertText', 1, 2)); s.undo(); expect(s.snapshot().text).toBe('ab')
  s.change('abd', inputHint('insertText', 2, 3)); s.breakHistory()
  s.change('abde', inputHint('insertText', 3, 4)); s.undo(); expect(s.snapshot().text).toBe('abd')
  s.change('abd[[link]]'); s.undo(); expect(s.snapshot().text).toBe('abd')
  s.change('abd!'); expect(s.snapshot().canRedo).toBe(false)
})
it('输入法候选整体撤销；取消不留空步骤，在途保存不能把候选带进仓库', async () => {
  vi.useFakeTimers()
  const s = manager().open('text:ime', { text: '原文', revision: 1 }, async () => { throw new Error('not saved') })
  const comp = { ...inputHint('insertCompositionText', 2, 3), composition: 'ime-1' }
  s.change('原文n', comp); vi.setSystemTime(Date.now() + 9000)
  s.change('原文ni', comp); s.change('原文你', comp); s.breakHistory()
  s.change('原文你好', { ...comp, composition: 'ime-2' }); s.breakHistory()
  s.undo(); expect(s.snapshot().text).toBe('原文你')
  s.undo(); expect(s.snapshot().text).toBe('原文')
  s.redo(); expect(s.snapshot().text).toBe('原文你')
  s.change('原文你h', { ...comp, composition: 'cancel' })
  s.change('原文你', { ...comp, composition: 'cancel' }); s.breakHistory()
  s.undo(); expect(s.snapshot().text).toBe('原文')
  let release!: (value: any) => void
  const commit = vi.fn<EditCommit>().mockImplementationOnce(() => new Promise(r => release = r))
    .mockResolvedValueOnce({ accepted: true, current: { text: 'x你', revision: 3 } })
  const t = manager().open('text:ime-flight', { text: '', revision: 1 }, commit)
  t.change('x'); const flight = t.save(); await Promise.resolve()
  t.change('xn', { ...comp, composition: 'flight' })
  release({ accepted: true, current: { text: 'x', revision: 2 } }); await flight
  await vi.advanceTimersByTimeAsync(1500); expect(commit).toHaveBeenCalledTimes(1)
  await expect(t.save()).rejects.toThrow('完成输入法')
  t.change('x你', { ...comp, composition: 'flight' }); t.breakHistory()
  await vi.advanceTimersByTimeAsync(800); expect(commit).toHaveBeenLastCalledWith({ text: 'x', revision: 2 }, 'x你')
})
