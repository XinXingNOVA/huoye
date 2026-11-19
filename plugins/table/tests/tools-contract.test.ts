import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tableToolsPoint, toolsFor, columnTitle } from '../tools-contract.ts'
import type { UiHost } from '@resource-manager/plugin-api/ui/contracts'
import type { BlockKind } from '@resource-manager/plugin-api/blocks'

test('结构校验拒绝坏贡献，接受函数和 React 包装组件', () => {
  assert.equal(tableToolsPoint.validate({ match: () => true, header: { width: 48, Component: () => null } }), undefined)
  assert.equal(tableToolsPoint.validate({ match: () => true, header: { width: 48, Component: { $$typeof: Symbol.for('react.memo') } } }), undefined)
  for (const value of [null, {}, { match: true }, { match: () => true, header: { width: 0, Component: () => null } }, { match: () => true, addOption: false }]) assert.equal(typeof tableToolsPoint.validate(value), 'string')
})
test('按目录顺序匹配；坏匹配／标题有来源，休眠定义不提供编辑', () => {
  const issues: unknown[] = []
  const entries = [
    { id: 'bad.match', value: { match() { throw Error('bad match') } } },
    { id: 'fields.template', value: { match: () => true, columnMenu: { title() { throw Error('bad title') } } } }
  ]
  const host = { extensions: { list: () => entries, reportFailure: (...args: unknown[]) => issues.push(args) } } as unknown as UiHost
  const kind = { id: 'tpl:test', title: '原标题' } as BlockKind
  const entry = toolsFor(host, kind)
  assert.equal(entry?.id, 'fields.template')
  assert.equal(columnTitle(host, entry, { kind, field: 'x', def: { title: 'X', type: 'text' } }), '原标题')
  assert.equal(issues.length, 2)
  assert.equal(toolsFor(host, { ...kind, dormant: true }), undefined)
  assert.equal(issues.length, 2)
})
