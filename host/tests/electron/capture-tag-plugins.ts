import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import type { CoreApi } from '../../src/shared/rpc'
import { callCore } from '../../src/main/core-client'
import { libraryOf } from '../../src/main/libraries'
import { executeUiCommand } from './capture-command'
export async function tagPluginsFlow(win: BrowserWindow, dir: string, { js, shot }: { js(code: string): Promise<any>; shot(name: string): Promise<void> }) {
  const wait = (ms = 150) => new Promise(r => setTimeout(r, ms))
  const until = async (code: string) => { for(let i=0;i<100;i++) { if(await js(code)) return; await wait() } throw Error('标签界面未就绪：'+code) }
  const call = <K extends keyof CoreApi>(method: K, ...args: Parameters<CoreApi[K]>) => callCore(libraryOf(win.webContents)!.core, method, ...args)
  const click = async (selector: string, modifiers: { metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean } = {}) => {
    await js(`document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...${JSON.stringify(modifiers)} }))`); await wait()
  }
  const checkFilters = async (names: string[], cards: number) => {
    await until(`document.querySelectorAll('[data-tab-focused="true"] [data-entity-id]').length===${cards}`)
    const labels = await js(`Array.from(document.querySelectorAll('[data-tab-focused="true"] .filter-bar .query-chip-label'), el => el.textContent)` ) as string[]
    assert.equal(labels.length, names.length, '临时条件没有按点击替换／取消：' + labels.join('；'))
    names.forEach((name, i) => assert(labels[i].includes(name)))
  }
  const path = join(dir, 'tag-fixture.json')
  const tree = { kind: 'tag-tree.node', key: 'tag', parent: 'parent' }
  const query = { scope: 'all' as const, role: 'material' as const, where: [{ op: 'subtree' as const, kind: 'tags', field: 'values', value: 'Math', tree }] }
  await executeUiCommand(js, 'host.view.all')
  if (process.env.CAPTURE_FLOW === 'tagpluginsmissing') {
    await until(`!!document.querySelector('.tag-groups')`)
    assert(!(await js(`!!document.querySelector('.tag-tree')`)))
    await assert.rejects(call('query', query), /未启用/)
    const fixture = JSON.parse(readFileSync(path, 'utf8'))
    assert.deepEqual((await call('get', [fixture.ids[0]]))[0].blocks.tags.data.values, ['Logic', 'Metrics'])
    assert.equal((await call('executeQuery', { query: 'tag-groups.list_groups' })).result.total, 1)
  } else if (process.env.CAPTURE_FLOW === 'tagpluginsresume') {
    await until(`!!document.querySelector('.tag-groups [data-tag="Logic"]') && !!document.querySelector('.tag-tree [data-tag="Math"]')`)
    assert.equal((await call('query', query)).ids.length, 3)
    assert.equal((await call('executeQuery', { query: 'tag-groups.list_groups' })).result.total, 1)
    await shot('tags-restart.png')
  } else {
    const sourceFile = join(dir, 'Logic and metrics.txt'); writeFileSync(sourceFile, 'Logic and metrics')
    const ids = await call('ingest', [{ type: 'file', path: sourceFile }, { type: 'text', text: 'Mathematics' }, { type: 'text', text: 'AI note' }])
    for (const [i, values] of [['Logic', 'Metrics'], ['Math'], ['AI']].entries()) await call('run', 'tags', 'update', { ids: [ids[i]], add: values })
    await call('create', { tagGroups: { groups: [{ id: 'old', title: '常用', tags: ['Logic'] }] } })
    await until(`!![...document.querySelectorAll('.tag-groups button')].find(b=>b.textContent==='导入旧分组')`)
    await js(`[...document.querySelectorAll('.tag-groups button')].find(b=>b.textContent==='导入旧分组').click()`)
    await call('run', 'tag-tree', 'setParent', { tag: 'Logic', parent: 'Math' })
    await call('run', 'tag-tree', 'setParent', { tag: 'Metrics', parent: 'Math' })
    await call('run', 'tag-tree', 'setParent', { tag: '空母标签', parent: null })
    await until(`document.querySelector('.tag-groups')?.textContent.includes('常用') && document.querySelector('.tag-tree [data-tag="Math"] small')?.textContent==='2'`)
    assert(!(await js(`document.querySelector('.tag-groups').textContent.includes('未分组')`)))
    assert(!(await js(`!!document.querySelector('.tag-tree [data-tag="空母标签"]')`)))
    await shot('tags-browse.png')
    await click('.tag-tree [data-tag="Math"]')
    await checkFilters(['Math'], 2)
    await click('.tag-tree [data-tag="Logic"]')
    await checkFilters(['Logic'], 1) // 普通单击替换，不能把原条件再追加一次。
    await click('.tag-tree [data-tag="Logic"]')
    await checkFilters([], 3)
    await click('.tag-tree [data-tag="Math"]')
    await click('.tag-tree [data-tag="Logic"]', { metaKey: true })
    await checkFilters(['Math', 'Logic'], 1)
    await click('.tag-tree [data-tag="Logic"]', { metaKey: true })
    await checkFilters(['Math'], 2)
    await click('.tag-tree [data-tag="Metrics"]')
    await checkFilters(['Metrics'], 1)
    await click('.tag-tree [data-tag="Metrics"]', { altKey: true })
    await checkFilters(['Metrics'], 1) // 精确条件与分支条件不同，但单击仍只保留当前一个。
    await click('.tag-tree [data-tag="Math"]', { ctrlKey: true })
    await checkFilters(['Metrics', 'Math'], 1)
    await click('.tag-groups [data-tag="Logic"] button')
    await checkFilters(['Logic'], 1) // 两种面板共享同字段筛选。
    await click('.tag-tree [data-tag="Math"]')
    await checkFilters(['Math'], 2)
    await click('[aria-label="整理层级标签"]')
    await until(`!!document.querySelector('.tag-tree [data-tag="空母标签"]') && !!document.querySelector('.tag-tree [data-tag="AI"]')`)
    // 原生拖动数据协议；宿主工作区拖动不接管业务标签。
    await js(`(()=>{ const source=document.querySelector('.tag-tree [data-tag="AI"]'), target=document.querySelector('.tag-tree [data-tag="Math"]'), dataTransfer=new DataTransfer(); source.dispatchEvent(new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer})); target.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer})); target.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer})); source.dispatchEvent(new DragEvent('dragend',{bubbles:true,dataTransfer})); })()`)
    await until(`document.querySelector('.tag-tree [data-tag="Math"] small')?.textContent==='3'`)
    await click('[aria-label="整理标签分组"]')
    await call('run', 'tag-groups', 'createGroup', { title: '空分组' })
    await until(`document.querySelector('.tag-groups')?.textContent.includes('空分组')`)
    await shot('tags-manage.png')
    const groups = (await call('executeQuery', { query: 'tag-groups.list_groups' })).result.items as {id:string;title:string}[]
    await call('run','tag-groups','deleteGroup',{group:groups.find(g=>g.title==='空分组')!.id})
    await click('[aria-label="整理标签分组"]'); await click('[aria-label="整理层级标签"]')
    assert.deepEqual((await call('get', [ids[0]]))[0].blocks.tags.data.values, ['Logic','Metrics'])
    assert.equal((await call('query', query)).ids.length, 3)
    writeFileSync(path, JSON.stringify({ids}))
  }
  writeFileSync(join(dir, process.env.CAPTURE_FLOW+'-result.json'), JSON.stringify({ ok:true }))
}
