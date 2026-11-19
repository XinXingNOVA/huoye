// 每个仓库自己决定启用哪些插件（设计文档 8.4）：依赖传递；停用的插件留下的数据照样认得（休眠的定义），
// 能显示、能查询、素材还算素材，但不能修改；重新启用一切恢复。

import { afterEach, describe, expect, it } from 'vitest'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PLUGINS, resolvePlugins } from '../../src/plugins/manifest'
import { corePlugins } from '../../src/plugins/core'
import { Registry } from '../../src/core/registry'
import { templateKindId } from '../fixtures/legacy-fields/blocks'
import { openHost, tempDir } from '../helpers/helpers'

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

/** 关掉再打开：插件设置在重新加载后生效。 */
function reopen(h: ReturnType<typeof setup>) {
  h.host.close()
  cleanups = []
  return setup(h.root)
}

const ids = (r: unknown) => (r as { ids: string[] }).ids

describe('启用哪些插件', () => {
  it('依赖传递：预览停用了，图片、视频也停用；宿主用到的视图不能停用', () => {
    const plan = resolvePlugins(['preview', 'view'])
    expect(plan.off.get('preview')).toBe('已停用')
    expect(plan.off.get('image')).toBe('需要「预览」')
    expect(plan.off.get('video')).toBe('需要「预览」')
    expect(plan.enabled.has('view')).toBe(true)
    expect(PLUGINS.some(p => p.id === 'playback')).toBe(false)
    expect(resolvePlugins([]).enabled.has('audio')).toBe(true)
  })

  it('依赖声明是完整的：停用任何一个插件，剩下的插件都能装配', () => {
    for (const p of PLUGINS) {
      const plan = resolvePlugins([p.id])
      expect(() => new Registry(corePlugins.filter((c) => plan.enabled.has(c.id))), `停用 ${p.id}`).not.toThrow()
    }
  })

  it('设置存在仓库里，重新加载后生效', () => {
    const a = setup()
    a.host.api.setPlugins(['status', 'view'])
    const b = reopen(a)
    expect(b.host.api.info()).toMatchObject({ disabledPlugins: ['status'] })
    const status = (b.host.api.plugins() as { id: string; enabled: boolean; chosen: boolean }[]).find((p) => p.id === 'status')
    expect(status).toMatchObject({ enabled: false, chosen: true })
  })
})

describe('停用的插件留下的数据', () => {
  it('状态插件停用：数据还在，能查能筛，不能改；重新启用就恢复', async () => {
    const a = setup()
    const [x, y] = await a.host.api.ingest([
      { type: 'text', text: '一' },
      { type: 'text', text: '二' }
    ])
    a.host.api.patch(x, 'status', { value: '进行中' })
    a.host.api.setPlugins(['status'])

    const b = reopen(a)
    const def = b.host.reg.kind('status')!
    expect(def).toMatchObject({ dormant: true, title: '状态' })
    expect(def.fields.value.title).toBe('状态')
    expect((b.host.api.kinds() as { id: string }[]).map((k) => k.id)).toContain('status')
    expect(b.host.store.blocksOf(x).status.data).toEqual({ value: '进行中' })
    expect(ids(b.host.api.query({ where: [{ op: 'eq', kind: 'status', field: 'value', value: '进行中' }] }))).toEqual([x])
    expect(b.host.api.facet('status', 'value')).toEqual([{ value: '进行中', count: 1 }])
    expect(() => b.host.api.patch(y, 'status', { value: '待处理' })).toThrow(/没有启用/)
    expect(() => b.host.api.remove(x, 'status')).toThrow(/没有启用/)

    b.host.api.setPlugins([])
    const c = reopen(b)
    expect(c.host.reg.kind('status')?.dormant).toBeUndefined()
    c.host.api.patch(y, 'status', { value: '待处理' })
    expect(c.host.store.blocksOf(y).status.data.value).toBe('待处理')
  })

  it('文件托管是基础模块：旧的停用配置不再关闭它，停用媒体仍保留原文件', async () => {
    const a = setup()
    const path = join(tempDir(), '会议记录.txt')
    writeFileSync(path, '下周交初稿')
    const [f] = await a.host.api.ingest([{ type: 'file', path }])
    a.host.api.setPlugins(['file', 'image', 'video'])
    const b = reopen(a)
    expect(b.host.plan.off.get('file')).toBeUndefined()
    expect(b.host.plan.off.get('image')).toBe('已停用')
    expect(b.host.reg.kind('file')).toMatchObject({ content: true })
    expect(b.host.reg.kind('file')?.dormant).toBeUndefined()
    expect(ids(b.host.api.query({}))).toEqual([f])
    expect(ids(b.host.api.query({ where: [{ op: 'eq', kind: 'file', field: 'ext', value: 'txt' }] }))).toEqual([f])
  })

  it('自定义字段停用：模板定义的数据块也休眠，字段名还在', async () => {
    const a = setup()
    const tpl = a.host.api.create({ template: { title: '影视片段', fields: [{ id: 'fshot', title: '镜头', type: 'select', options: ['推'] }] } }) as string
    const kind = templateKindId(tpl)
    const [x] = await a.host.api.ingest([{ type: 'text', text: '一' }])
    a.host.api.put(x, kind, { fshot: '推' })
    a.host.api.setPlugins(['fields'])
    const b = reopen(a)
    expect(b.host.reg.kind(kind)).toMatchObject({ dormant: true, title: '影视片段' })
    expect(b.host.reg.kind(kind)!.fields.fshot.title).toBe('镜头')
    expect(ids(b.host.api.query({ where: [{ op: 'eq', kind, field: 'fshot', value: '推' }] }))).toEqual([x])
    expect(() => b.host.api.put(x, kind, { fshot: '推' })).toThrow(/没有启用/)
  })
})

describe('停用的插件的加工记录', () => {
  it('留着：重新启用时不用全部重算', async () => {
    const { default: sharp } = await import('sharp')
    const a = setup()
    const png = join(tempDir(), 'a.png')
    await sharp({ create: { width: 40, height: 30, channels: 3, background: '#808080' } }).png().toFile(png)
    await a.host.api.ingest([{ type: 'file', path: png }])
    await a.host.scheduler.idle()
    const count = (h: ReturnType<typeof setup>) =>
      h.host.lib.db.prepare("SELECT COUNT(*) FROM derived.derivation WHERE system = 'preview.thumb'").pluck().get()
    expect(count(a)).toBe(1)
    a.host.api.setPlugins(['preview'])
    const b = reopen(a)
    expect(count(b)).toBe(1)
  })
})
