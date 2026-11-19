import { afterEach, expect, it } from 'vitest'
import { readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Host } from '../../src/core/host'
import { Registry } from '../../src/core/registry'
import { legacyCorePlugins as corePlugins, legacyManifest as PLUGINS } from '../helpers/legacy-plugins'
import { templateKindId } from '../fixtures/legacy-fields/blocks'
import type { BlockKind, EntityView } from '../../src/shared/blocks'
import { summaryTitle } from '../../src/shared/title'
import { tempDir } from '../helpers/helpers'

let host: Host | undefined
const dirs: string[] = []
const dir = () => { const value = tempDir('rm-data-core-'); dirs.push(value); return value }
afterEach(async () => {
  if (host) { await host.scheduler.idle(); host.close(); host = undefined }
  dirs.splice(0).forEach(d => rmSync(d, { force: true, recursive: true }))
})

async function sample() {
  const root = dir()
  const source = join(dir(), '原始记录.txt')
  writeFileSync(source, '原始文件字节\n不能丢失。')
  host = new Host(root, corePlugins, () => {}, { manifest: PLUGINS })
  const [file, text] = await host.api.ingest([{ type: 'file', path: source }, { type: 'text', text: '# 独立文字\n\n完整正文 boundarytoken' }])
  const template = await host.api.create({ template: { title: '研究资料', fields: [{ id: 'fremark', title: '研究说明', type: 'text' }] } })
  const custom = templateKindId(template)
  await host.api.put(file, custom, { fremark: '不可丢失的自定义字段' })
  const anchor = await host.api.create({ anchor: { target: file, type: '文本区间', quote: '原始文件字节' } })
  const groups = await host.api.create({ tagGroups: { groups: [{ id: 'one', title: '用途', tags: ['研究'] }] } })
  await host.scheduler.idle()
  const before = host.store.get([file, text, template, anchor, groups])
  await host.api.setPlugins(PLUGINS.map(p => p.id))
  host.close()
  host = new Host(root, corePlugins, () => {}, { manifest: PLUGINS })
  return { root, source, file, text, template, custom, anchor, groups, before }
}

it('所有可选插件停用：文件、视图是基础模块，旧记录能查询、读全文和处理依附关系', async () => {
  const s = await sample()
  expect(host!.reg.plugins.map(p => p.id)).toEqual(['file', 'view'])
  expect((await host!.api.query({ scope: 'all' })).ids.length).toBe(5)
  expect((await host!.api.query({})).ids.length).toBe(3)
  expect(host!.store.get(s.before.map(v => v.id))).toEqual(s.before)
  expect((await host!.api.searchPage({ query: { text: 'boundarytoken' } })).items).toMatchObject([{ id: s.text, title: '独立文字' }])
  expect((await host!.api.readContent({ id: s.text, kind: 'text', field: 'content' })).text).toContain('完整正文 boundarytoken')
  expect(host!.reg.kind('text')).toMatchObject({ dormant: true, display: { title: 'content' } })
  expect(() => host!.api.patch(s.file, s.custom, { fremark: '不允许修改' })).toThrow(/没有启用/)
  await host!.api.trash([s.file])
  expect((await host!.api.query({ scope: 'trash' })).ids.sort()).toEqual([s.file, s.anchor].sort())
  const original = s.before.find(v => v.id === s.file)!
  expect(host!.api.getIdentities([s.file, 'missing', s.file])).toEqual([
    { id: s.file, createdAt: original.createdAt, deletedAt: expect.any(Number) }
  ])
  await host!.api.undo()
  expect((await host!.api.query({ scope: 'trash' })).ids).toEqual([])
  const fresh = join(dir(), '另一个文件.bin'); writeFileSync(fresh, '继续托管新文件')
  const [added] = await host!.api.ingest([{ type: 'file', path: fresh }])
  expect(readFileSync(await host!.api.locateOriginalFile({ id: added, kind: 'file', field: 'path' }), 'utf8')).toBe('继续托管新文件')
})

it('核心无插件代码时取回定义、记录、原文件和依附模板；普通关联只保留引用', async () => {
  const s = await sample()
  host!.close()
  host = new Host(s.root, [], () => {}, { manifest: [] })
  // 持久引用索引仍属于仓库，普通关联不隐式复制整个知识网络。
  host.lib.db.prepare('INSERT INTO main.ref VALUES (?, ?, ?, ?, ?)').run(s.file, 'testLink', 'target', s.text, 'link')
  expect(await host.api.takeoutPreview([s.anchor])).toMatchObject({ items: 1, related: 2, files: 1, externalReferences: 1, problems: [] })
  const parent = dir()
  const out = await host.api.takeoutRun({ ids: [s.anchor], parent, name: '取回' })
  expect(out).toMatchObject({ items: 3, files: 1, problems: [] })
  const data = JSON.parse(readFileSync(join(out.dir, 'records.json'), 'utf8'))
  expect(data.records.map((v: EntityView) => v.id).sort()).toEqual([s.file, s.anchor, s.template].sort())
  expect(data.records.find((v: EntityView) => v.id === s.file).blocks[s.custom].data.fremark).toBe('不可丢失的自定义字段')
  expect(data.definitions.find((d: BlockKind) => d.id === s.custom).fields.fremark.title).toBe('研究说明')
  expect(data.references).toContainEqual({ entity_id: s.anchor, kind: 'anchor', field: 'target', target_id: s.file, ref_type: 'attach' })
  expect(data.externalReferences).toContainEqual({ entity_id: s.file, kind: 'testLink', field: 'target', target_id: s.text, ref_type: 'link' })
  expect(readFileSync(join(out.dir, data.files[0].copy))).toEqual(readFileSync(s.source))
  expect(host.store.get(s.before.map(v => v.id))).toEqual(s.before)
  const again = await host.api.takeoutRun({ ids: [s.text], parent, name: '取回' })
  expect(again.dir).toBe(join(parent, '取回 (2)'))
  const text = JSON.parse(readFileSync(join(again.dir, 'records.json'), 'utf8')).records[0]
  expect(text.blocks.text.data.content).toBe('# 独立文字\n\n完整正文 boundarytoken')
  expect((await host.api.exportPreview([s.text])).unsupported).toBe(1)
  expect((await host.api.exportRun({ ids: [s.text], titles: {}, parent, name: '格式导出' })).failed).toHaveLength(1)
})

it('原文件缺失、越界或链接指向仓库外时明确报告；非文件字段不能拿来定位磁盘文件', async () => {
  const s = await sample()
  const original = await host!.api.locateOriginalFile({ id: s.file, kind: 'file', field: 'path' })
  const external = join(dir(), '外部.txt'); writeFileSync(external, '不属于仓库')
  expect(() => host!.api.locateOriginalFile({ id: s.file, kind: 'file', field: 'name' })).toThrow(/不是原文件/)
  rmSync(original)
  symlinkSync(external, original)
  expect(() => host!.api.locateOriginalFile({ id: s.file, kind: 'file', field: 'path' })).toThrow(/不在仓库内|不能使用符号链接/)
  expect((await host!.api.takeoutPreview([s.file])).problems[0]).toMatch(/不在仓库内|不能使用符号链接/)
  rmSync(original)
  const out = await host!.api.takeoutRun({ ids: [s.file], parent: dir(), name: '缺失文件' })
  expect(out.files).toBe(0)
  expect(out.problems).toHaveLength(1)
  expect(JSON.parse(readFileSync(join(out.dir, 'records.json'), 'utf8')).files[0].copy).toBeUndefined()
})

it('新数据类型靠声明获得通用标题；旧定义、空内容和未知数据仍有可识别标题', () => {
  const kind: BlockKind = { id: 'research', plugin: 'research', title: '研究条目', content: true, rebuildable: false, version: 1,
    fields: { headline: { title: '标题', type: 'text' }, body: { title: '正文', type: 'longtext' } }, display: { title: 'headline', summary: 'body', priority: 5 } }
  const blocks = { research: { ver: 1, seq: 1, data: { headline: '新类型标题', body: '正文' } } }
  expect(summaryTitle(blocks, () => kind)).toBe('新类型标题')
  expect(summaryTitle(blocks, () => ({ ...kind, display: undefined }))).toBe('新类型标题')
  expect(summaryTitle({ research: { ...blocks.research, data: {} } }, () => kind, 'record123')).toBe('研究条目 · ord123')
  expect(summaryTitle(blocks, () => undefined, 'record123')).toBe('research · ord123')
  expect(() => new Registry([{ id: 'research', version: 1, blocks: [{ ...kind, display: { title: 'missing' } }] }])).toThrow(/呈现字段/)
})

it('旧库曾停用文件插件：迁为基础模块后，原先跟随关闭的媒体不会自动启用', async () => {
  const root = dir()
  host = new Host(root, corePlugins, () => {}, { manifest: PLUGINS })
  host.lib.db.prepare("INSERT OR REPLACE INTO main.config (key,value) VALUES ('plugins',?)").run(JSON.stringify({ disabled: ['file'] }))
  host.close()
  host = new Host(root, corePlugins, () => {}, { manifest: PLUGINS })
  expect(host.plan.enabled.has('file')).toBe(true)
  expect(host.plan.enabled.has('view')).toBe(true)
  for (const id of ['image', 'video', 'pdf']) expect(host.plan.enabled.has(id)).toBe(false)
  expect(host.plan.enabled.has('text')).toBe(true)
  const chosen = (await host.api.plugins()).filter(p => p.chosen).map(p => p.id)
  expect(chosen).not.toContain('file')
  expect(chosen).toContain('image')
})

it('定义缺失也能分段读原始字段；取回保留原数据并报告无法解释的块', async () => {
  const s = await sample()
  host!.lib.db.prepare('DELETE FROM main.kind_def WHERE id = ?').run('text')
  host!.close()
  host = new Host(s.root, [], () => {}, { manifest: [] })
  expect(host.reg.kind('text')).toBeUndefined()
  const first = await host.api.readContent({ id: s.text, kind: 'text', field: 'content', limit: 8 })
  expect(first.format).toBe('text')
  expect(first.next).not.toBeNull()
  let combined = first.text, next = first.next
  while (next) { const chunk = await host.api.readContent(next); combined += chunk.text; next = chunk.next }
  expect(combined).toBe('# 独立文字\n\n完整正文 boundarytoken')
  const out = await host.api.takeoutRun({ ids: [s.text], parent: dir(), name: '未知定义' })
  const data = JSON.parse(readFileSync(join(out.dir, 'records.json'), 'utf8'))
  expect(data.records[0].blocks.text.data.content).toBe('# 独立文字\n\n完整正文 boundarytoken')
  expect(data.problems.some((p: string) => p.includes('缺少定义'))).toBe(true)
})

it('取回期间修改了原记录时，问题清单明确标记，不能伪称一致快照', async () => {
  const s = await sample()
  const pending = host!.api.takeoutRun({ ids: [s.file], parent: dir(), name: '并发变化' })
  await host!.api.patch(s.file, 'file', { name: '取回期间修改的名称.txt' })
  const result = await pending
  expect(result.problems.some(p => p.includes('记录发生变化'))).toBe(true)
  const manifest = JSON.parse(readFileSync(join(result.dir, 'records.json'), 'utf8'))
  expect(manifest.records.find((v: EntityView) => v.id === s.file).blocks.file.data.name).toBe('原始记录.txt')
  expect(manifest.problems).toEqual(result.problems)
})
