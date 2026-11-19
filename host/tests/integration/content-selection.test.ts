import { expect, it, vi } from 'vitest'
import { ContentSelectionChannel } from '../../src/renderer/src/content-selection'
import { validateUiContributions } from '../../src/shared/ui-contributions'
import { isContentLocator } from '../../src/plugin-api/content-selection'
const owner = { tabId: 'tab-a', surfaceId: 'reader.chapter', sourceId: 'book', revision: 'hash:chapter' }
const input = () => ({ sourceId: 'book', text: '同一句话供多个插件使用', locator: { provider: 'example.chapter', version: 1, data: { chapter: 'one', from: 5 } }, rect: { left: 10, top: 20, width: 80, height: 20 } })
it('一个来源发布不可变快照，多个消费者共享；清理菜单不销毁已点击的有效快照', () => {
  const channel = new ContentSelectionChannel(); channel.activate('tab-a')
  const first = vi.fn(), second = vi.fn(), select = vi.fn(); channel.subscribe(first); channel.subscribe(second)
  const lease = channel.register({ ...owner, select }), original = input(); lease.publish(original)
  const value = channel.getSnapshot()!; expect(value.text).toBe(original.text); expect(first).toHaveBeenCalledOnce(); expect(second).toHaveBeenCalledOnce()
  original.locator.data.chapter = 'changed'; expect(value.locator.data.chapter).toBe('one')
  expect(() => { value.locator.data.chapter = 'overwrite' }).toThrow()
  channel.clear(value.id); expect(channel.getSnapshot()).toBeUndefined(); expect(channel.valid(value)).toBe(true)
  channel.select(value, 'quote'); expect(select).toHaveBeenCalledWith('quote')
  lease.dispose(); expect(channel.valid(value)).toBe(false)
})
it('切标签后旧回调不能重新发布，回到旧标签也不能复活旧快照；不同窗口相互隔离', () => {
  const a = new ContentSelectionChannel(), b = new ContentSelectionChannel(); a.activate('tab-a'); b.activate('tab-a')
  const lease = a.register(owner); lease.publish(input()); const snapshot = a.getSnapshot()!
  expect(b.getSnapshot()).toBeUndefined(); expect(b.valid(snapshot)).toBe(false)
  a.activate('tab-b'); expect(a.valid(snapshot)).toBe(false); lease.publish(input()); expect(a.getSnapshot()).toBeUndefined()
  a.activate('tab-a'); expect(a.valid(snapshot)).toBe(false); lease.publish(input()); expect(a.getSnapshot()).toBeUndefined()
})
it('来源或章节换版后旧对话框失效，旧 dispose 不能清掉新选区；旧操作完成不会覆盖新选区', () => {
  const channel = new ContentSelectionChannel(); channel.activate('tab-a'); const old = channel.register(owner); old.publish(input()); const before = channel.getSnapshot()!
  const next = channel.register({ ...owner, revision: 'changed' }); next.publish(input()); const current = channel.getSnapshot()!
  expect(channel.valid(before)).toBe(false); old.dispose(); channel.clear(before.id); expect(channel.getSnapshot()).toBe(current)
  next.dispose(); expect(channel.getSnapshot()).toBeUndefined()
})
it('拒绝无定位的内容、过大的快照和无效几何；消费者操作 ID 重复不能悄悄覆盖', () => {
  const channel = new ContentSelectionChannel(); channel.activate('tab-a'); const lease = channel.register(owner)
  expect(() => lease.publish({ ...input(), text: ' '.repeat(10) })).toThrow()
  expect(() => lease.publish({ ...input(), text: 'a'.repeat(100001) })).toThrow()
  expect(() => lease.publish({ ...input(), rect: { ...input().rect, left: NaN } })).toThrow()
  expect(() => lease.publish({ ...input(), rect: { ...input().rect, width: -1 } })).toThrow()
  expect(isContentLocator({ provider: 'example.chapter', version: 0, data: {} })).toBe(false)
  const manifest = [{ id: 'one', title: 'one', description: '' }, { id: 'two', title: 'two', description: '' }]
  expect(() => validateUiContributions([{ id: 'one', selectionActions: [{ id: 'same', order: 1 }] }, { id: 'two', selectionActions: [{ id: 'same', order: 2 }] }], manifest)).toThrow('重复')
  expect(() => validateUiContributions([{ id: 'one', selectionActions: [{ id: 'host.copy-selection', order: 1 }] }], manifest)).toThrow('选区')
  expect(() => validateUiContributions([{ id: 'one', contentLocations: [{ id: 'two.location', version: 1 }] }], manifest)).toThrow('定位')
})
