import assert from 'node:assert/strict'
import type { BrowserWindow } from 'electron'

type Call = (name: string, args?: Record<string, unknown>) => Promise<any>
/** 和普通外部 Agent 使用同一 MCP 通道；选择和搜索通过原生输入事件。 */
export async function checkWorkbenchSession(win: BrowserWindow, libraryId: string, imageIds: string[], viewId: string, call: Call,
  denied: (name: string, args: Record<string, unknown>, code: string) => Promise<void>, setMode: (mode: string) => Promise<unknown>, capture: (name: string) => Promise<void>) {
  const pause = () => new Promise(r => setTimeout(r, 80))
  const until = async (check: () => Promise<boolean>, label: string) => {
    for (let i = 0; i < 180; i++) { if (await check()) return; await pause() }
    await capture('session-failed')
    throw new Error('L2 等待失败：' + label)
  }
  const read = (tabId?: string) => call('get_workbench_session', { libraryId, ...(tabId ? { tabId } : {}) })
  const ready = async (tabId?: string) => {
    let snapshot: any
    await until(async () => { snapshot = await read(tabId); return snapshot.target.collection?.state === 'ready' }, '查询与 DOM 同步')
    assert.equal(snapshot.target.collection.queryVersion, snapshot.target.collection.renderedVersion)
    return snapshot
  }
  const click = async (selector: string, modifiers: ('meta' | 'control')[] = []) => {
    const point = await win.webContents.executeJavaScript(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)return;const r=el.getBoundingClientRect(),x=Math.round(r.x+r.width/2),y=Math.round(r.y+Math.min(r.height/2,40));return {x,y,hit:el.contains(document.elementFromPoint(x,y))}})()`)
    assert(point?.hit, '点击必须命中可见目标：' + selector)
    delete point.hit
    win.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1, modifiers })
    win.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1, modifiers })
    await pause()
  }
  await setMode('read')
  let snapshot = await ready()
  await denied('present_workbench', { libraryId, requestId: 'l2-read-only', expected: snapshot.expected, target: { action: 'reveal', ids: imageIds } }, 'READ_ONLY')
  await setMode('organize')
  const selectionPage = await call('present_workbench', { libraryId, requestId: 'l2-selection-page', expected: snapshot.expected, target: { action: 'open', title: 'L2 双图', query: { ids: imageIds, sort: 'created', dir: 'asc' } } })
  snapshot = await ready(selectionPage.tabId)
  const originalTab = snapshot.target.id
  const pane = `[data-tab-content="${originalTab}"]`
  await click(`${pane} [data-entity-id="${imageIds[0]}"]`)
  await click(`${pane} [data-entity-id="${imageIds[1]}"]`, [process.platform === 'darwin' ? 'meta' : 'control'])
  await until(async () => { snapshot = await read(); return snapshot.target.selectedCount === 2 }, '原生多选回读')
  assert.deepEqual(new Set(snapshot.target.selectedIds), new Set(imageIds))
  const beforeRefresh = snapshot
  await call('execute_operation', { libraryId, operation: 'create_text', requestId: 'l2-background-change', args: { content: '刷新列表但不改变双图页面的查询和选区' } })
  await until(async () => { snapshot = await read(); return snapshot.target.collection?.state === 'ready' && snapshot.target.collection.queryVersion > beforeRefresh.target.collection.queryVersion }, '后台查询刷新')
  assert.deepEqual(snapshot.expected, beforeRefresh.expected, '后台数据刷新不冒充用户切换现场')
  const revealInput = { libraryId, expected: snapshot.expected, requestId: 'l2-reveal-images', target: { action: 'reveal', ids: [imageIds[1]] } }
  win.blur()
  await until(async () => (await read()).windows.focused === null, '外部客户端获得焦点')
  const reveal = await call('present_workbench', revealInput)
  assert(!win.isFocused(), '从客户端推送高亮不会抢焦点')
  win.focus()
  await until(async () => (await read()).windows.focused === 'main', '目标窗口重新获得焦点')
  await until(async () => (await read()).target.collection?.reveal?.state === 'rendered', '高亮已提交')
  snapshot = await read()
  assert.equal(snapshot.target.collection.reveal.token, reveal.revealToken)
  await call('present_workbench', { ...revealInput, requestId: 'l2-refocus-reveal' })
  assert.deepEqual(new Set(snapshot.target.selectedIds), new Set(imageIds), 'AI 高亮不改选区')
  assert(await win.webContents.executeJavaScript(`!!document.querySelector('${pane} .ai-highlighted[data-entity-id="${imageIds[1]}"]')`))
  await capture('session-highlight')
  const beforeWindow = snapshot.expected
  win.hide()
  await denied('present_workbench', { ...revealInput, expected: beforeWindow, requestId: 'l2-hidden-window' }, 'CONTEXT_CHANGED')
  win.show(); win.focus(); await pause()
  snapshot = await read()
  assert.equal(snapshot.windows.focused, 'main')
  assert(snapshot.expected.windowRevision > beforeWindow.windowRevision)
  await denied('present_workbench', { ...revealInput, expected: beforeWindow, requestId: 'l2-stale-window' }, 'CONTEXT_CHANGED')

  // 用户真实输入改变筛选；迟到请求必须在展示之前拒绝。
  const beforeSearch = snapshot.expected
  await click(`${pane} .search-input`); win.webContents.insertText('不存在的L2筛选')
  await until(async () => { snapshot = await read(); return JSON.stringify(snapshot.target.collection?.query).includes('不存在的L2筛选') && snapshot.target.collection?.state === 'ready' }, '有效搜索回读')
  assert.equal(snapshot.target.collection.resultCount, 0); assert.deepEqual(snapshot.target.collection.highlightedIds, [])
  await denied('present_workbench', { ...revealInput, expected: beforeSearch, requestId: 'l2-stale-query' }, 'CONTEXT_CHANGED')
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'a', modifiers: [process.platform === 'darwin' ? 'meta' : 'control'] })
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'a', modifiers: [process.platform === 'darwin' ? 'meta' : 'control'] })
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace' }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace' })
  await until(async () => { snapshot = await read(); return !JSON.stringify(snapshot.target.collection?.query).includes('不存在的L2筛选') && snapshot.target.collection?.state === 'ready' }, '搜索恢复')

  // 新页中准备足够多的素材，验证虚拟列表真正滚动，而不是只保存一个目标 ID。
  const more: string[] = []
  for (let i = 0; i < 24; i++) {
    const receipt = await call('execute_operation', { libraryId, operation: 'create_text', requestId: `l2-text-${i}`, args: { content: `L2 定位素材 ${i}\n${'用于屏外定位验证。'.repeat(30)}` } })
    more.push(receipt.result.id)
  }
  snapshot = await ready()
  const opened = await call('present_workbench', { libraryId, requestId: 'l2-open-results', expected: snapshot.expected, target: { action: 'open', title: 'L2 定位验收', query: { ids: more, sort: 'created', dir: 'asc' } } })
  const newTab = opened.tabId
  snapshot = await ready(newTab)
  assert.equal(snapshot.target.collection.resultCount, 24)
  assert(snapshot.tabs.some((t: any) => t.id === originalTab), '另开结果页保留原页')
  const last = more[more.length - 1]
  assert(!snapshot.target.collection.renderedIds.includes(last), '目标起初位于虚拟列表屏外')
  await click(`[data-tab-content="${newTab}"] [data-entity-id="${more[0]}"]`)
  snapshot = await ready(newTab)
  const scrollInput = { libraryId, requestId: 'l2-reveal-offscreen', expected: snapshot.expected, target: { action: 'reveal', ids: [last] } }
  await call('present_workbench', scrollInput)
  await until(async () => (await read(newTab)).target.collection?.reveal?.state === 'rendered', '屏外目标定位完成')
  snapshot = await read(newTab)
  assert.deepEqual(snapshot.target.selectedIds, [more[0]])
  assert(await win.webContents.executeJavaScript(`(()=>{const p=document.querySelector('[data-tab-content="${newTab}"]'), c=p.querySelector('[data-entity-id="${last}"]'), s=p.querySelector('.grid-scroller');if(!c)return false;const r=c.getBoundingClientRect(),v=s.getBoundingClientRect();return s.scrollTop>0&&r.top<v.bottom&&r.bottom>v.top&&c.classList.contains('ai-highlighted')})()`))
  await capture('session-offscreen')
  await denied('present_workbench', { libraryId, requestId: 'l2-outside-query', expected: snapshot.expected, target: { action: 'reveal', ids: imageIds } }, 'ITEM_NOT_IN_VIEW')

  const stale = snapshot.expected
  await click(`[data-tab="${originalTab}"]`)
  await denied('present_workbench', { ...scrollInput, expected: stale, requestId: 'l2-stale-tab' }, 'CONTEXT_CHANGED')
  assert.equal((await call('present_workbench', scrollInput)).replayed, true)
  assert.equal((await read()).activeTabId, originalTab, '重放不重新抢焦点')
  snapshot = await ready()
  const saved = await call('present_workbench', { libraryId, requestId: 'l2-open-saved', expected: snapshot.expected, target: { action: 'open_view', viewId } })
  snapshot = await ready(saved.tabId)
  assert.equal(snapshot.target.collection.resultCount, 1); assert(snapshot.target.collection.renderedIds.includes(imageIds[0]))
  await setMode('off'); await denied('get_workbench_session', { libraryId }, 'ACCESS_DENIED'); await setMode('admin')
  return { readSelection: true, permission: true, effectiveSearch: true, queryAndRenderVersion: true, backgroundRefresh: true, highlightWithoutSelection: true, offscreenReveal: true, savedView: true, staleContext: true, staleWindow: true, replayWithoutFocus: true }
}
