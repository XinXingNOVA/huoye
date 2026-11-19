import { Host } from '../../src/core/host'
import { legacyCorePlugins, legacyManifest } from '../helpers/legacy-plugins'

/** 在旧装配下保存真实数据、历史和视图，然后关闭，供迁移及 Electron 回归使用。 */
export async function seedLegacyPackages(root: string, disabled: string[] = []) {
  const host = new Host(root, legacyCorePlugins, () => {}, { manifest: legacyManifest })
  try {
    host.lib.db.prepare("DELETE FROM main.meta WHERE key = 'plugin_defaults_pending'").run()
    const [id] = await host.api.ingest([{ type: 'text', text: '旧库素材：继续整理构图' }])
    await host.api.put(id, 'status', { value: '待处理' })
    await host.api.patch(id, 'status', { value: '进行中' })
    const view = { title: '旧看板', query: { scope: 'content' as const }, layout: 'kanban', options: { groupBy: 'status.value', custom: '保留旧选项' } }
    const viewId = await host.api.create({ view })
    await host.scheduler.idle()
    await host.api.setPlugins(disabled)
    return {
      id, viewId, libraryId: host.lib.id,
      records: host.store.get([id, viewId]),
      history: host.lib.db.prepare('SELECT * FROM main.block_history ORDER BY seq').all(),
      workspace: { version: 1, active: 'legacy-board', panels: { sidebar: true, inspector: true }, tabs: [
        { id: 'legacy-board', type: 'collection', params: { ...view, viewId, base: { layout: view.layout, options: view.options } } }
      ] }
    }
  } finally { host.close() }
}
