// 标签页层的后端部分：素材库 ID、视图身份、可写视图。

import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import { syncViewSource } from '../../src/renderer/src/collection-query'
import { admissionReport, rejectionState } from '../../src/renderer/src/admission-report'
import { moveSavedView, orderedViews, pinView, readViewNavigation } from '../../src/renderer/src/view-navigation'
import { defaultWorkspace } from '../../src/renderer/src/workspace'
import { describeCondition, splitConditions } from '../../src/shared/query'
import { legacyCorePlugins as corePlugins } from '../helpers/legacy-plugins'
import { Registry } from '../../src/core/registry'
import { classifyFolder } from '../../src/main/folders'
import { openHost, tempDir } from '../helpers/helpers'

function textFile(name: string): string {
  const path = join(tempDir(), name)
  writeFileSync(path, `# ${name}`)
  return path
}

let cleanups: (() => void)[] = []
afterEach(() => {
  for (const c of cleanups) c()
  cleanups = []
})

function setup(root?: string) {
  const h = openHost(undefined, undefined, root)
  cleanups.push(h.cleanup)
  return h
}

const ids = (r: unknown) => (r as { ids: string[] }).ids

describe('素材库 ID', () => {
  it('第一次打开时生成，之后保持不变', () => {
    const a = setup()
    const id = (a.host.api.info() as { libraryId: string }).libraryId
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
    a.host.close()
    cleanups = []
    const b = setup(a.root)
    expect((b.host.api.info() as { libraryId: string }).libraryId).toBe(id)
  })
})

describe('仓库锁', () => {
  it('同一个仓库同时只能打开一次；关掉后可以再打开', () => {
    const a = setup()
    expect(() => openHost(undefined, undefined, a.root)).toThrow(/已经在另一个窗口或程序里打开/)
    a.host.close()
    cleanups = []
    const b = setup(a.root)
    expect(b.host.lib.id).toBe(a.host.lib.id)
  })

  it('崩溃留下的锁（进程已经不在了）会被接管', () => {
    const root = tempDir('rm-lock-')
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, '.lock'), '999999')
    const { host } = setup(root)
    expect(readFileSync(join(root, '.lock'), 'utf8')).toBe(String(process.pid))
    host.close()
    cleanups = []
    expect(existsSync(join(root, '.lock'))).toBe(false)
  })
})

describe('文件夹能不能当仓库', () => {
  it('仓库、空文件夹、有别的东西的文件夹、文件', () => {
    const lib = setup()
    expect(classifyFolder(lib.root)).toBe('library')
    const empty = tempDir('rm-empty-')
    writeFileSync(join(empty, '.DS_Store'), '')
    expect(classifyFolder(empty)).toBe('empty')
    expect(classifyFolder(join(empty, '还不存在'))).toBe('empty')
    writeFileSync(join(empty, '照片.jpg'), '')
    expect(classifyFolder(empty)).toBe('other')
    expect(classifyFolder(join(empty, '照片.jpg'))).toBe('file')
  })
})

describe('视图是一个身份', () => {
  it('保存的视图不出现在"全部"里，侧栏用查询列出它们', async () => {
    const { host } = setup()
    const [t] = await host.api.ingest([{ type: 'text', text: '素材' }])
    const v = host.api.create({ view: { title: '项目 A 参考', query: { where: [{ op: 'eq', kind: 'tags', field: 'values', value: '项目A' }] }, layout: 'masonry' } }) as string
    expect(ids(host.api.query({}))).toEqual([t])
    expect(ids(host.api.query({ scope: 'all', has: ['view'] }))).toEqual([v])
    expect(host.store.blocksOf(v).view.data.title).toBe('项目 A 参考')
  })

  it('不能手动创建可重建的数据块', () => {
    const { host } = setup()
    expect(() => host.api.create({ image: { width: 1, height: 1 } })).toThrow(/可重建/)
  })
})

describe('放入视图：准入与写入', () => {
  const reg = new Registry(corePlugins)
  const kindOf = (k: string) => reg.kind(k)
  const tag = (value: string) => ({ op: 'eq' as const, kind: 'tags', field: 'values', value })

  it('能写的条件写入，写不了的条件当作准入', () => {
    expect(splitConditions({}, kindOf)).toEqual({ write: [], attach: [], check: { where: [] } })
    expect(splitConditions({ where: [tag('项目A')] }, kindOf)?.write).toEqual([tag('项目A')])
    expect(splitConditions({ scope: 'trash', where: [tag('项目A')] }, kindOf)).toBeUndefined()

    const range = { op: 'range' as const, kind: 'image', field: 'width', min: 3000 }
    const ext = { op: 'eq' as const, kind: 'file', field: 'ext', value: 'png' }
    const split = splitConditions({ has: ['video'], where: [tag('待剪辑'), range, ext] }, kindOf)!
    expect(split.write).toEqual([tag('待剪辑')])
    expect(split.check).toEqual({ scope: undefined, has: ['video'], lacks: undefined, where: [range, ext] })
  })

  it('条件说明', () => {
    expect(describeCondition({ has: 'video' }, kindOf)).toBe('有视频')
    expect(describeCondition({ op: 'eq', kind: 'file', field: 'ext', value: 'mp4' }, kindOf)).toBe('格式为「mp4」')
    expect(describeCondition({ op: 'range', kind: 'image', field: 'width', min: 3000 }, kindOf)).toBe('宽 ≥ 3000')
    expect(describeCondition({ op: 'eq', kind: 'audioPlayback', field: 'finished', value: false }, kindOf)).toBe('已播完为「否」')
  })

  it('只有写入条件：全部接受，标签加入列表、已有时不重复', async () => {
    const { host } = setup()
    const [a, b] = await host.api.ingest([
      { type: 'text', text: '一' },
      { type: 'text', text: '二' }
    ])
    host.api.put(a, 'tags', { values: ['光影'] })
    const where = [tag('项目A')]
    expect(await host.api.admit([a, b], { where })).toEqual({ accepted: [a, b], rejected: [] })
    await host.api.admit([a], { where })
    expect(host.store.blocksOf(a).tags.data.values).toEqual(['光影', '项目A'])
    expect(host.store.blocksOf(b).tags.data.values).toEqual(['项目A'])
    expect(ids(host.api.query({ where })).sort()).toEqual([a, b].sort())
  })

  it('不满足准入条件的被拒绝，并说明哪一条；通过的写上条件', async () => {
    const { host } = setup()
    const [t] = await host.api.ingest([{ type: 'text', text: '一段文字' }])
    const [f] = await host.api.ingest([{ type: 'file', path: textFile('readme.md') }])
    const query = { where: [tag('待整理'), { op: 'eq' as const, kind: 'file', field: 'ext', value: 'md' }] }
    const res = (await host.api.admit([t, f], query)) as { accepted: string[]; rejected: { id: string; reason: string }[] }
    expect(res.accepted).toEqual([f])
    expect(res.rejected).toEqual([{ id: t, reason: '格式为「md」' }])
    expect(host.store.blocksOf(f).tags.data.values).toEqual(['待整理'])
    expect(host.store.blocksOf(t).tags).toBeUndefined()
  })

  it('回收站不接受拖入', async () => {
    const { host } = setup()
    const [t] = await host.api.ingest([{ type: 'text', text: '一' }])
    expect(await host.api.admit([t], { scope: 'trash' })).toEqual({ accepted: [], rejected: [{ id: t, reason: '回收站不接受拖入' }] })
  })

  it('刚收录的图片：等读出图片块再检查"有图片"，不会被误判', async () => {
    const { host } = setup()
    const png = join(tempDir(), 'fresh.png')
    await sharp({ create: { width: 40, height: 30, channels: 3, background: '#808080' } }).png().toFile(png)
    const [id] = await host.api.ingest([{ type: 'file', path: png }])
    // 收录刚返回时，图片块还没有
    expect(host.store.blocksOf(id).image).toBeUndefined()
    const res = await host.api.admit([id], { has: ['image'], where: [tag('新图')] })
    expect(res).toEqual({ accepted: [id], rejected: [] })
    expect(host.store.blocksOf(id).tags.data.values).toEqual(['新图'])
  })

  it('apply 只接受能写入的条件', async () => {
    const { host } = setup()
    const [a] = await host.api.ingest([{ type: 'text', text: '一' }])
    expect(() => host.api.apply([a], [{ op: 'eq', kind: 'image', field: 'width', value: 100 }])).toThrow(/不能直接写入/)
  })
})


describe('视图规则的保存与最终准入', () => {
  it('外部输入先保守预检；默认拒绝未匹配，正式事务再次校验，显式例外按输入授权', async () => {
    const { host } = setup()
    const png = textFile('view-check.png'), txt = textFile('view-check.txt')
    const sources = [{ type: 'file' as const, path: png }, { type: 'file' as const, path: txt }]
    const query = { where: [{ op: 'eq' as const, kind: 'file', field: 'ext', value: 'png' }, { op: 'eq' as const, kind: 'tags', field: 'values', value: '收集' }] }
    const before = (await host.api.query({})).ids
    const preview = await host.api.previewViewImport(sources, query)
    expect(preview.map(r => r.status)).toEqual(['matched', 'unmatched'])
    expect((await host.api.query({})).ids).toEqual(before)
    expect((await host.api.previewViewImport(sources, { has: ['image'] })).map(r => r.status)).toEqual(['unknown', 'unknown'])
    // 绕过界面预检也不能把未匹配项收进库；批次回滚，原件可能已成为空间候选。
    await expect(host.api.importToView(sources, { query, requestId: 'view-reject-default' })).rejects.toThrow(/VIEW_CHANGED/)
    expect((await host.api.query({})).ids).toEqual(before)
    const options = { query, allowUnmatched: [1], requestId: 'view-explicit-choice' }
    const result = await host.api.importToView(sources, options)
    expect(result.items).toHaveLength(2)
    const [a, b] = result.items.map(item => item.id)
    expect(host.store.blocksOf(a).tags.data.values).toEqual(['收集'])
    expect(host.store.blocksOf(b).tags).toBeUndefined()
    expect(await host.api.importToView(sources, options)).toEqual(result)
    await expect(host.api.importToView(sources, { ...options, allowUnmatched: [] })).rejects.toThrow(/REQUEST_ID_CONFLICT/)
    const admitted = await host.api.admit([a, b], query)
    expect(admitted.accepted).toEqual([a]); expect(admitted.rejected.map(r => r.id)).toEqual([b])
    host.api.undo(); expect((await host.api.query({})).ids).toEqual(before)
    expect(existsSync(png)).toBe(true); expect(existsSync(txt)).toBe(true)
  })

  it('预检后去重对象已改名／回收，正式校验失败不复活素材或改写其标签', async () => {
    const { host } = setup(), path = textFile('before.md')
    const source = [{ type: 'file' as const, path }]
    const imported = await host.api.importToLibrary(source, { requestId: 'view-existing-seed' }), id = imported.items[0].id
    host.api.patch(id, 'file', { name: 'changed.md' })
    host.api.trash([id])
    const query = { where: [{ op: 'eq' as const, kind: 'file', field: 'name', value: 'before.md' }, { op: 'eq' as const, kind: 'tags', field: 'values', value: '不要写入' }] }
    expect((await host.api.previewViewImport(source, query))[0].status).toBe('matched')
    await expect(host.api.importToView(source, { query, requestId: 'view-existing-guard' })).rejects.toThrow(/VIEW_CHANGED/)
    expect(host.store.isTrashed(id)).toBe(true)
    expect(host.store.blocksOf(id).tags).toBeUndefined()
    expect(host.store.blocksOf(id).file.data.name).toBe('changed.md')
  })

  it('批次反馈按身份去重，导入复用不能误报新增，条件拒绝与检查失败分开', () => {
    const report = admissionReport('目标', ['old'], { accepted: ['yes', 'yes'], rejected: ['old', 'new', 'restored'].map(id => ({ id, reason: '格式' })) }, {
      collect: true, processing: 'not_waited', saved: [], errors: [], items: [
        { index: 0, id: 'old', outcome: 'existing' }, { index: 1, id: 'new', outcome: 'created' }, { index: 2, id: 'new', outcome: 'existing' }, { index: 3, id: 'restored', outcome: 'restored' }
      ]
    })
    expect(report.accepted).toEqual(['yes'])
    expect(rejectionState(report)).toBe('1 项已新增到仓库；1 项已从仓库回收站恢复；1 项原本就在仓库')
    expect(report.failure).toBeUndefined()
    expect(admissionReport('目标', ['old'], { accepted: [], rejected: [] }, undefined, '加工失败').failure).toBe('加工失败')
  })

  it('导航排序保留暂时缺失的身份，新视图补入；固定与跨区移动不修改规则', () => {
    const navigation = readViewNavigation({ order: ['b', 'deleted', 'a', 'b'], pinned: ['deleted', 'a', null] })
    expect(orderedViews(['a', 'b', 'new'], navigation)).toEqual(['b', 'a', 'new'])
    const moved = moveSavedView(navigation, ['a', 'b', 'new'], 'new', 'b', true)
    expect(moved.pinned).toEqual(['deleted', 'a', 'new'])
    expect(orderedViews(['a', 'b', 'new', 'deleted'], moved)).toEqual(['new', 'b', 'deleted', 'a'])
    expect(orderedViews(['a', 'b', 'new'], moveSavedView(moved, ['a', 'b', 'new'], 'new', 'a', false, true))).toEqual(['b', 'a', 'new'])
    expect(pinView(moved, 'new', false).order).toEqual(moved.order)
    expect(moveSavedView(moved, ['a', 'b'], 'gone', 'b', false)).toBe(moved)
    expect(readViewNavigation(null)).toEqual({ version: 1, order: [], pinned: [] })
  })

  it('同字段任一不推导写值；写入后验收，拒绝项无半次修改，整个接受批次可以撤销', async () => {
    const { host } = setup()
    const [a, b] = await host.api.ingest([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])
    host.api.put(b, 'tags', { values: ['原标签'] })
    const join = { op: 'eq' as const, kind: 'tags', field: 'values', value: '项目 A' }
    const any = { op: 'in' as const, kind: 'tags', field: 'values', values: ['项目 A', '项目 B'] }
    expect((await host.api.admit([a], { where: [any] })).accepted).toEqual([])
    expect(host.store.blocksOf(a).tags).toBeUndefined()
    // 写入项目 A 后才能命中 any；b 不满足正文搜索，连带试写必须回滚。
    const result = await host.api.admit([a, b], { where: [join, any], search: [{ kind: 'text', text: 'a' }] })
    expect(result.accepted).toEqual([a])
    expect(host.store.blocksOf(a).tags.data.values).toEqual(['项目 A'])
    expect(host.store.blocksOf(b).tags.data.values).toEqual(['原标签'])
    host.api.undo()
    expect(host.store.blocksOf(a).tags).toBeUndefined()
    expect(host.store.blocksOf(b).tags.data.values).toEqual(['原标签'])
    // 相互矛盾的最终条件不能报告成功，也不留下待撤销的操作。
    expect((await host.api.admit([a], { lacks: ['tags'], where: [join] })).accepted).toEqual([])
    expect(host.store.blocksOf(a).tags).toBeUndefined()
    expect((await host.api.admit([a, b], { ids: [b], where: [join] })).accepted).toEqual([b])
    expect(host.store.blocksOf(a).tags).toBeUndefined()
  })

  it('保存视图校验旧版本、保留草案重试；删除不删素材，撤销恢复规则', async () => {
    const { host } = setup()
    const [material] = await host.api.ingest([{ type: 'text', text: '素材' }])
    const draft = { title: '参考', query: { has: ['text'], sort: 'created', dir: 'asc' }, layout: 'masonry', options: {} }
    const { id } = host.api.run('view', 'saveView', draft) as { id: string }
    const seq = host.store.blocksOf(id).view.seq
    host.api.run('view', 'saveView', { ...draft, id, expectedSeq: seq, title: '新版' })
    expect(() => host.api.run('view', 'saveView', { ...draft, id, expectedSeq: seq, title: '旧页面' })).toThrow(/别处修改/)
    expect(host.store.blocksOf(id).view.data.title).toBe('新版')
    const local = { filters: [], search: '本页搜索', anchor: material }, w = defaultWorkspace()
    w.tabs[0].params.viewId = id; w.tabs[0].state = local
    const synced = syncViewSource(w, id, { status: 'ready', view: host.store.get([id])[0] })
    expect(synced.tabs[0].params.title).toBe('新版')
    expect(synced.tabs[0].state).toBe(local)
    expect(syncViewSource(synced, id, { status: 'missing' }).tabs[0].params.viewId).toBeUndefined()
    host.api.undo(); expect(host.store.blocksOf(id).view.data.title).toBe('参考')
    host.api.run('view', 'deleteView', { id })
    expect((await host.api.query({})).ids).toContain(material)
    expect(() => host.api.run('view', 'saveView', { ...draft, id, expectedSeq: seq })).toThrow(/已删除/)
    host.api.undo(); expect(host.store.blocksOf(id).view.data.query).toEqual(draft.query)
    expect(() => host.api.run('view', 'saveView', { ...draft, query: { where: [{ op: 'in', kind: 'file', field: 'ext', values: [] }] } })).toThrow()
  })
})
