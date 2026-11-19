import { describe, expect, it } from 'vitest'
import { emptyInspectorLayout, inspectorLayoutKey, mergeInspectorOrder, moveInspectorSection, readInspectorLayout } from '../../src/renderer/src/inspector-layout'
import { uiFeaturesSchema } from '../../src/shared/external-plugins'

describe('详情布局偏好', () => {
  it('损坏或未来版本配置回到默认；清理重复和非法 ID', () => {
    for (const raw of [null, '{', '[]', '{"version":2,"order":["a"]}']) expect(readInspectorLayout(raw)).toEqual(emptyInspectorLayout())
    expect(readInspectorLayout(JSON.stringify({ version: 1, order: ['a', 1, '', 'a', 'b'], collapsed: ['b', null, 'b'] }))).toEqual({ version: 1, order: ['a', 'b'], collapsed: ['b'] })
    expect(readInspectorLayout('{"version":1,"order":null}')).toEqual(emptyInspectorLayout())
  })

  it('新增分区按默认相邻位置插入，保留手动排序和当前缺席的分区', () => {
    expect(mergeInspectorOrder([], ['file', 'tags', 'note'])).toEqual(['file', 'tags', 'note'])
    const saved = ['note', 'block:tpl:1', 'file']
    expect(mergeInspectorOrder(saved, ['file', 'tags', 'note'])).toEqual(['note', 'block:tpl:1', 'file', 'tags'])
    expect(mergeInspectorOrder(saved, ['new', 'file', 'note'])).toEqual(['note', 'block:tpl:1', 'new', 'file'])
    expect(saved).toEqual(['note', 'block:tpl:1', 'file'])
  })

  it('跨不同素材移动，只改变指定分区，模板重新出现时沿用布局和折叠', () => {
    const initial = { version: 1 as const, order: ['file', 'block:tpl:1', 'note', 'tags'], collapsed: ['block:tpl:1', 'note'] }
    const next = moveInspectorSection(initial, ['file', 'tags', 'note'], 'tags', 'file')
    expect(next.order).toEqual(['tags', 'file', 'block:tpl:1', 'note'])
    expect(next.collapsed).toEqual(initial.collapsed)
    expect(mergeInspectorOrder(next.order, ['file', 'block:tpl:1', 'tags', 'note'])).toEqual(next.order)
    expect(moveInspectorSection(next, ['file', 'tags', 'note'], 'tags', 'note', true).order).toEqual(['file', 'block:tpl:1', 'note', 'tags'])
    expect(initial.order).toEqual(['file', 'block:tpl:1', 'note', 'tags'])
  })

  it('过期的拖动目标、缺失分区和原地移动均不改布局', () => {
    const layout = emptyInspectorLayout()
    for (const [source, target] of [['a', 'a'], ['a', 'gone'], ['gone', 'a']]) expect(moveInspectorSection(layout, ['a', 'b'], source, target)).toBe(layout)
  })

  it('仓库的本机偏好互不混用', () => {
    expect(inspectorLayoutKey('/one')).not.toBe(inspectorLayoutKey('/two'))
  })
})

it('新逐块详情声明可与窗口贡献并用；未知或重复能力拒绝安装', () => {
  expect(uiFeaturesSchema.parse(['window-surfaces-v1', 'block-sections-v1'])).toHaveLength(2)
  expect(uiFeaturesSchema.safeParse(['block-sections-v2']).success).toBe(false)
  expect(uiFeaturesSchema.safeParse(['block-sections-v1', 'block-sections-v1']).success).toBe(false)
})
