import { describe, it, expect, vi } from 'vitest'
import { CollectionSession } from '../../src/renderer/src/collection-session'
import { createWorkbenchSession, workspaceContextChanged } from '../../src/renderer/src/workbench-session'
import { collectionTab, type Workspace } from '../../src/renderer/src/workspace'
import { activateEditor, openEditor } from '../../src/renderer/src/editor-layout'
import type { PageAccess } from '../../src/renderer/src/app/page-access'
import type { SessionPresent } from '../../src/shared/workbench-session'

function collection() {
  const present = vi.fn(), session = new CollectionSession(present)
  session.configure({ ids: ['a', 'b'] }, ['a'], 'masonry', true)
  const revision = session.invalidate()
  session.onRendered({ revision, ids: ['a'] }); session.accept(revision, ['a', 'b'])
  return { session, present, revision }
}
describe('工作台现场与定位', () => {
  it('分别跟踪失效、查询结果、DOM 提交；迟到结果不冒充当前画面', () => {
    const { session, revision } = collection()
    expect(session.read().state).toBe('ready')
    const next = session.invalidate()
    session.accept(revision, ['old']); session.onRendered({ revision, ids: ['old'] })
    expect(session.read().state).toBe('querying')
    session.accept(next, ['a', 'b'])
    expect(session.read().state).toBe('rendering')
    expect(() => session.reveal(['a'])).toThrow('WORKBENCH_NOT_READY')
    session.onRendered({ revision: next, ids: ['a'] })
    expect(session.read().state).toBe('ready')
    session.accept(next, [], 'query failed')
    expect(session.read()).toMatchObject({ state: 'error', error: 'query failed' })
  })
  it('定位不改选区，必须命中当前结果且等目标真正渲染；更换筛选会清除高亮', () => {
    const { session, present, revision } = collection()
    expect(() => session.reveal(['missing'])).toThrow('ITEM_NOT_IN_VIEW')
    const { token } = session.reveal(['b'])
    expect(present).toHaveBeenLastCalledWith(['b'], { id: 'b', token })
    expect(session.read()).toMatchObject({ selectedIds: ['a'], highlightedIds: ['b'], reveal: { token, state: 'pending' } })
    session.onRendered({ revision, ids: ['a'], revealToken: token })
    expect(session.read().reveal?.state).toBe('pending')
    session.onRendered({ revision, ids: ['b'], revealToken: token })
    expect(session.read().reveal?.state).toBe('rendered')
    session.configure({ text: '新筛选' }, [], 'masonry', true)
    expect(session.read()).toMatchObject({ highlightedIds: [], state: 'querying' })
  })
  it('上下文支持 A→B→A 检测，未知布局与过大快照不伪造完整状态', () => {
    const { session } = collection(), original = session.read().contextVersion
    session.configure({ ids: ['a', 'b'] }, ['b'], 'masonry', true)
    session.configure({ ids: ['a', 'b'] }, ['a'], 'masonry', true)
    expect(session.read().contextVersion).toBeGreaterThan(original)
    const many = Array.from({ length: 1200 }, (_, i) => `item-${i}-xxxxxxxxxxxxxxxx`)
    session.configure({ ids: many }, many, 'external', false)
    const revision = session.invalidate(); session.accept(revision, many)
    const snapshot = session.read()
    expect(snapshot).toMatchObject({ state: 'unsupported', queryTruncated: true, selectionTruncated: true, selectedCount: 1200, renderedVersion: null })
    expect(snapshot.query).toBeUndefined(); expect(snapshot.selectedIds).toHaveLength(1000)
    expect(() => session.reveal(['a'])).toThrow('LAYOUT_UNSUPPORTED')
  })
  it('页面拥有选区时单独报告检查对象，页面卸载后选择为空', async () => {
    const tab = { id: 'work', type: 'example.editor', params: {} }
    const ws: Workspace = { version: 1, active: tab.id, tabs: [tab], panels: { sidebar: true, inspector: true } }
    const api = vi.fn<() => ReturnType<PageAccess['api']>>(() => ({ pageSelection: { ids: ['part1', 'part2'], remove() {} } }))
    const pages = { api, ownsSelection: () => true, focus: () => ['source'] } as unknown as PageAccess
    const handle = createWorkbenchSession({ read: () => ws, epoch: () => 0, busy: () => false, pages, open: vi.fn(), core: { get: vi.fn(), reviewBatch: vi.fn() } })
    const read = () => handle({ action: 'read', input: {} }, { revision: 0, focused: 'main', windows: [] }, async () => {})
    await expect(read()).resolves.toMatchObject({ target: { selectedIds: ['part1', 'part2'], selectedCount: 2, inspectionIds: ['source'], inspectionCount: 1 } })
    api.mockReturnValue(null)
    await expect(read()).resolves.toMatchObject({ target: { selectedIds: [], inspectionIds: ['source'] } })
  })
  it('展示新页保留旧页；重放不重新打开，旧现场、迟到授权和重载会话均拒绝', async () => {
    const a = collectionTab({ title: '原始页', query: {} }), b = collectionTab({ title: '其他页', query: {} })
    let ws: Workspace = { version: 1, active: a.id, tabs: [a, b], panels: { sidebar: true, inspector: true } }, epoch = 0
    const update = (next: Workspace) => { if (workspaceContextChanged(ws, next)) epoch++; ws = next }
    const { session } = collection()
    const pages = { ownsSelection: () => false, api: () => ({ collectionSession: session }), focus: () => ['a'], entry: (id: string) => ws.tabs.find(t => t.id === id) } as unknown as PageAccess
    const open = vi.fn((entry, target) => update(openEditor(ws, entry, target, undefined, a)))
    const handle = createWorkbenchSession({ read: () => ws, epoch: () => epoch, busy: () => false, pages, open, core: { get: vi.fn(), reviewBatch: vi.fn() } })
    const windows = { revision: 0, focused: 'main', windows: [{ id: 'main', visible: true, focused: true }] }
    const read = () => handle({ action: 'read', input: {} }, windows, async () => {}) as Promise<any>
    const first = await read()
    const refreshed = session.invalidate()
    session.accept(refreshed, ['a', 'b']); session.onRendered({ revision: refreshed, ids: ['a'] })
    expect((await read()).expected).toEqual(first.expected) // 后台结果刷新不冒充用户切换现场。
    const input: SessionPresent = { expected: first.expected, requestId: 'open-test-1', target: { action: 'open', title: 'AI 结果', query: { ids: ['a'] } } }
    update(activateEditor(ws, b.id)); update(activateEditor(ws, a.id))
    await expect(handle({ action: 'present', input }, windows, async () => {})).rejects.toThrow('CONTEXT_CHANGED')
    input.expected = (await read()).expected
    await expect(handle({ action: 'present', input }, windows, async () => { session.configure({ text: '用户已搜索' }, [], 'masonry', true) })).rejects.toThrow('CONTEXT_CHANGED')
    input.expected = (await read()).expected
    const result = await handle({ action: 'present', input }, windows, async () => {}) as any
    expect(result.state).toBe('accepted'); expect(ws.tabs).toHaveLength(3); expect(ws.tabs[0]).toBe(a)
    update(activateEditor(ws, a.id))
    expect(await handle({ action: 'present', input }, windows, async () => {})).toMatchObject({ replayed: true, tabId: result.tabId })
    expect(ws.active).toBe(a.id); expect(open).toHaveBeenCalledTimes(1)
    await expect(handle({ action: 'present', input: { ...input, target: { action: 'reveal', ids: ['a'] } } }, windows, async () => {})).rejects.toThrow('REQUEST_CONFLICT')
    await expect(handle({ action: 'present', input: { ...input, expected: { ...input.expected, sessionId: crypto.randomUUID() } } }, windows, async () => {})).rejects.toThrow('SESSION_CHANGED')
  })
})
