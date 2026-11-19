import { Host } from '../../src/core/host'
import { legacyCorePlugins, legacyManifest } from '../helpers/legacy-plugins'

/** 冻结的旧标签实现生成样本，新包不能参与准备旧定义。 */
export async function seedTagsTable(root: string, disabled: string[] = [], registered = false) {
  const h = new Host(root, legacyCorePlugins, () => {}, { manifest: legacyManifest })
  try {
    h.lib.db.prepare("DELETE FROM main.meta WHERE key='plugin_defaults_pending'").run()
    const [id] = await h.api.ingest([{ type: 'text', text: '旧库构图参考' }])
    await h.api.put(id, 'tags', { values: ['光影', '保留'] })
    const group = await h.api.run('tags', 'createGroup', { title: '主题', tag: '光影' }) as string
    const groups = (await h.api.query({ scope: 'all', has: ['tagGroups'] })).ids[0]
    const template = await h.api.create({ template: { title: '参考信息', fields: [{ id: 'fyear', title: '年份', type: 'text' }] } })
    const kind = `tpl:${template}`
    await h.api.put(id, kind, { fyear: '2026' })
    const view = { title: '旧表格', query: { has: [kind], where: [{ op: 'eq' as const, kind: 'tags', field: 'values', value: '光影' }] }, layout: 'table', options: { custom: '保留旧选项' } }
    const viewId = await h.api.create({ view })
    await h.api.setPlugins(disabled)
    if (registered) h.lib.db.prepare("INSERT OR REPLACE INTO main.config (key,value) VALUES ('pluginSelection',?)").run(JSON.stringify({ version: 1, known: legacyManifest.map(p => p.id) }))
    await h.scheduler.idle()
    const ids = [id, groups, template, viewId]
    return { id, groups, group, template, kind, viewId, ids, libraryId: h.lib.id,
      records: h.store.get(ids), history: h.lib.db.prepare('SELECT * FROM main.block_history ORDER BY seq').all(),
      workspace: { version: 1, active: 'legacy-table', panels: { sidebar: true, inspector: true }, tabs: [
        { id: 'legacy-table', type: 'collection', params: { ...view, viewId, base: { layout: view.layout, options: view.options } } }
      ] }
    }
  } finally { h.close() }
}
