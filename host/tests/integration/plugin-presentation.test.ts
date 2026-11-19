import { expect, it } from 'vitest'
import { catalogGroup, catalogOf, matchesPlugin, pluginCategories } from '../../src/shared/plugin-presentation'
import { pluginCatalogSchema } from '../../src/shared/plugin-catalog-schema'
import { packageManifestSchema } from '../../src/shared/external-plugins'
import { packageInfo } from '../../src/shared/package-info'
import { DISTRIBUTION } from '../../src/plugins/generated/distribution'

const old = { id: 'note', title: '笔记', description: '记录想法', author: 'test', version: '1.0.0', formatVersion: 1, apiVersion: 1, entries: { ui: 'ui.mjs' } }
it('旧包保持原清单，已知包回退展示分类，未知包仍可使用并列入其他', () => {
  const manifest = packageManifestSchema.parse(old), before = JSON.stringify(manifest)
  expect(catalogGroup(manifest, DISTRIBUTION)).toBe('information')
  expect(catalogGroup({ ...manifest, id: 'unknown' }, DISTRIBUTION)).toBe('other')
  expect(JSON.stringify(manifest)).toBe(before)
  expect(manifest.catalog).toBeUndefined()
  expect(catalogOf({ ...manifest, catalog: { category: 'apps' } }, DISTRIBUTION).category).toBe('apps')
})
it('包清单携带分类和关键词；类别不限制入口、依赖和启停规则', () => {
  const manifest = packageManifestSchema.parse({ ...old, catalog: { category: 'information', keywords: ['摘录'], usage: '在阅读器中选择文字' } })
  const info = packageInfo({ manifest, hash: 'a'.repeat(64) })
  expect(info.catalog).toEqual(manifest.catalog)
  expect(matchesPlugin(info, '摘录 阅读器')).toBe(true)
  expect(matchesPlugin(info, 'NOTE')).toBe(true)
  expect(matchesPlugin(info, '歌曲')).toBe(false)
  expect(catalogGroup({ ...info, catalog: { category: 'tools', role: 'support' } })).toBe('support')
  expect(catalogGroup({ ...info, required: true })).toBe('core')
})
it('内外声明共用严格目录规范，拒绝拼错的分类、角色和超限内容', () => {
  for (const { id } of pluginCategories) expect(pluginCatalogSchema.safeParse({ category: id }).success).toBe(true)
  for (const catalog of [{ category: 'typo' }, { category: 'tools', role: 'recommended' }, { category: 'tools', defaultEnabled: true }, { category: 'files', keywords: ['a', 'a'] }, { category: 'files', usage: 'x'.repeat(501) }]) {
    expect(packageManifestSchema.safeParse({ ...old, catalog }).success).toBe(false)
  }
  for (const p of DISTRIBUTION) expect(p.catalog).toBeDefined()
  expect(catalogGroup(DISTRIBUTION.find(p => p.id === 'note')!, DISTRIBUTION)).toBe('information')
})
