import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { CorePlugin } from '../../src/plugin-api/core/contracts'
import { parseInput } from '../../src/plugin-api/operations'
import { checkCoreBoundaries } from '../../scripts/checks/core-boundaries'
import { Registry } from '../../src/core/registry'
import { openHost, tempDir } from '../helpers/helpers'
import { rmSync } from 'node:fs'

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).reverse().forEach(fn => fn()))
const temp = () => { const p = tempDir('rm-core-api-'); cleanups.push(() => rmSync(p, { recursive: true, force: true })); return p }
const input = z.object({ id: z.string(), text: z.string().min(1) }).strict()
// 完全独立的新业务：没有 MCP、Host、数据库或其他插件的导入。
const memo: CorePlugin = {
  id: 'memo', version: 1,
  blocks: [{ id: 'memo', plugin: 'memo', title: '备忘', version: 1, rebuildable: false, content: true,
    fields: { text: { type: 'longtext', title: '内容', search: true }, parent: { type: 'ref', ref: 'attach', title: '原记录' } }, display: { title: 'text' } }],
  commands: {
    update(ctx, args) { const { id, text } = parseInput(input, args); ctx.put(id, 'memo', { text }); return { label: '更新备忘', result: { id } } },
    internalOnly: () => ({ label: '内部操作' })
  },
  operations: [{ name: 'update_memo', title: '更新备忘', description: '修改已有备忘的内容', command: 'update', input }],
  exportSections: [{ id: 'memo.content', kind: 'memo', fields: ['text'], render: data => ({ markdown: String(data.text), inline: '短摘要', content: true }) }]
}

describe('公共后端能力组合', () => {
  it('新插件共用搜索、命令、外部工具及导出；没有对接 MCP 的业务代码', async () => {
    const root = temp(), dest = temp()
    let h = openHost([memo], { manifest: [{ id: 'memo', title: '备忘', description: '' }] }, root)
    cleanups.push(() => h.cleanup())
    const id = await h.host.api.create({ memo: { text: 'original' } })
    await h.host.api.run('memo', 'update', { id, text: '界面修改' })
    expect((await h.host.api.searchPage({ query: { text: '界面修改' } })).items[0].id).toBe(id)
    const description = await h.host.api.describeLibrary()
    expect(description.operations.find(o => o.name === 'update_memo')?.inputSchema.required).toEqual(['id', 'text'])
    expect(description.operations.some(o => o.name === 'internalOnly')).toBe(false)
    const request = { operation: 'update_memo', requestId: 'memo-request-01', args: { id, text: '外部修改' } }
    expect(await h.host.api.executeOperation(request)).toMatchObject({ replayed: false, result: { id } })
    expect(await h.host.api.executeOperation(request)).toMatchObject({ replayed: true })
    expect(await h.host.api.undo()).toBe('外部 · 更新备忘')
    expect((await h.host.api.readContent({ id, kind: 'memo', field: 'text' })).text).toBe('界面修改')
    expect((await h.host.api.exportPreview([id])).unsupported).toBe(0)
    await h.host.api.create({ memo: { text: '附属内容的完整第一行\n完整第二行', parent: id } })
    const exported = await h.host.api.exportRun({ ids: [id], titles: {}, parent: dest, name: '备忘' })
    expect(exported.failed).toEqual([])
    expect(readFileSync(join(exported.dir, '索引.md'), 'utf8')).toContain('界面修改')
    expect(readFileSync(join(exported.dir, '索引.md'), 'utf8')).toContain('附属内容的完整第一行\n  完整第二行')
    await h.host.api.setPlugins(['memo']); h.host.close()
    h = openHost([memo], { manifest: [{ id: 'memo', title: '备忘', description: '' }] }, root)
    expect((await h.host.api.describeLibrary()).operations.some(o => o.name === 'update_memo')).toBe(false)
    expect(() => h.host.api.executeOperation(request)).toThrow(/UNAVAILABLE_OPERATION/)
    expect((await h.host.api.readContent({ id, kind: 'memo', field: 'text' })).text).toBe('界面修改')
    expect((await h.host.api.exportPreview([id])).unsupported).toBe(2)
  })

  it('导出贡献必须明确字段归属，不能重复认领或覆盖其他插件', () => {
    expect(() => new Registry([{ ...memo, exportSections: [...memo.exportSections!, { ...memo.exportSections![0], id: 'memo.second' }] }])).toThrow(/重复认领/)
    expect(() => new Registry([{ ...memo, exportSections: [{ ...memo.exportSections![0], kind: 'other' }] }])).toThrow(/本插件/)
  })

  it('内容片段失败也保留原字段，并明确报告不完整', async () => {
    const broken: CorePlugin = { ...memo, exportSections: [{ ...memo.exportSections![0], render: () => { throw new Error('无法呈现正文') } }] }
    const dest = temp(), h = openHost([broken], { manifest: [] }); cleanups.push(h.cleanup)
    const id = await h.host.api.create({ memo: { text: '必须保留的原字段' } })
    const result = await h.host.api.exportRun({ ids: [id], titles: {}, parent: dest, name: '回退' })
    expect(result.failed.some(p => p.reason.includes('无法呈现正文'))).toBe(true)
    expect(readFileSync(join(result.dir, '索引.md'), 'utf8')).toContain('- 内容：必须保留的原字段')
  })

  it('普通根记录与依附环同时选择时，所有记录都有输出入口，重复选择不重复计数', async () => {
    const dest = temp(), h = openHost([memo], { manifest: [] }); cleanups.push(h.cleanup)
    const a = await h.host.api.create({ memo: { text: '环甲' } })
    const b = await h.host.api.create({ memo: { text: '环乙', parent: a } })
    const root = await h.host.api.create({ memo: { text: '独立根' } })
    await h.host.api.patch(a, 'memo', { parent: b })
    expect(await h.host.api.exportPreview([a, b, root, root])).toMatchObject({ items: 3, locals: 0 })
    const result = await h.host.api.exportRun({ ids: [a, b, root], titles: {}, parent: dest, name: '引用' })
    const index = readFileSync(join(result.dir, '索引.md'), 'utf8')
    for (const text of ['环甲', '环乙', '独立根']) expect(index).toContain(text)
  })
})

describe('后端依赖边界', () => {
  const fixture = () => {
    const root = temp(), entry = join(root, 'src/plugins/example/core.ts')
    const write = (path: string, text: string) => { const p = join(root, path); mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, text) }
    write('src/plugins/example/core.ts', "import './helper'")
    return { root, entry, write }
  }
  it.each(['core/store.ts', 'core/plugin.ts', 'main/libraries.ts', 'renderer/src/App.tsx', 'mcp/tools.ts', 'plugin-api/ui/internal/runtime.ts', 'plugins/other/lib/private.ts'])('辅助文件和类型引用不能绕过 %s 的边界', target => {
    const { root, entry, write } = fixture()
    write(`src/${target}`, 'export interface Secret {}')
    write('src/plugins/example/helper.ts', `export type { Secret } from '../../${target}'`)
    expect(() => checkCoreBoundaries(root, [entry])).toThrow(/后端边界/)
  })
  it('允许 Node 加工和公共契约，阻止公共契约反向依赖装配与动态路径', () => {
    const { root, entry, write } = fixture()
    write('src/plugin-api/core/contracts.ts', 'export interface CorePlugin {}')
    write('src/plugins/example/helper.ts', "import type { CorePlugin } from '../../plugin-api/core/contracts'\nimport { readFile } from 'node:fs/promises'")
    expect(() => checkCoreBoundaries(root, [entry])).not.toThrow()
    write('src/plugins/generated/core.ts', 'export const plugins = []')
    write('src/plugin-api/core/contracts.ts', "export { plugins } from '../../plugins/generated/core'")
    expect(() => checkCoreBoundaries(root, [entry])).toThrow(/反向引用/)
    write('src/plugins/example/helper.ts', 'const path = "./anything"; import(path)')
    expect(() => checkCoreBoundaries(root, [entry])).toThrow(/静态检查/)
    write('src/plugins/example/helper.ts', "import type { Tool } from '@modelcontextprotocol/sdk/types.js'")
    expect(() => checkCoreBoundaries(root, [entry])).toThrow(/接入协议/)
  })
})
