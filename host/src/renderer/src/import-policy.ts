import type { ImportReport, ImportSettings, ImportSettingsInput } from '../../shared/import-settings'
import type { UiHost } from './plugin'

type PolicyChange = Partial<Pick<ImportSettingsInput, 'collect' | 'defaultSpaceId'>> & {
  space?: { spaceId: string; automatic?: boolean; updates?: 'manual' | 'automatic' }
}
const writes = new WeakMap<UiHost['core'], Promise<ImportSettings>>()

/** 设置窗口和工作台都只提交改动的字段，整份配置在写入前从仓库读取。 */
export function updateImportPolicy(core: UiHost['core'], change: PolicyChange) {
  const write = async () => {
    const current = await core.getImportSettings()
    const { space, ...defaults } = change
    let spaces = current.spaces
    if (space) {
      const existing = spaces.find(rule => rule.spaceId === space.spaceId)
      spaces = [...spaces.filter(rule => rule.spaceId !== space.spaceId), { automatic: false, ...existing, ...space }]
    }
    return core.setImportSettings({ defaultSpaceId: current.defaultSpaceId, collect: current.collect, ...defaults, spaces })
  }
  const previous = writes.get(core)
  const result = previous ? previous.then(write, write) : write()
  writes.set(core, result)
  const finished = () => { if (writes.get(core) === result) writes.delete(core) }
  void result.then(finished, finished)
  return result
}

export function importSummary(result: ImportReport, showSpaceHint = true): string {
  const files = new Map<string, 'saved' | 'existing'>()
  for (const file of result.saved) {
    const key = `${file.spaceId}/${file.fileId}`
    if (files.get(key) !== 'saved') files.set(key, file.outcome)
  }
  const saved = [...files.values()].filter(v => v === 'saved').length
  const reused = files.size - saved
  const items = new Map<string, string>()
  for (const item of result.items) if (!items.has(item.id)) items.set(item.id, item.outcome)
  const count = (outcome: string) => [...items.values()].filter(v => v === outcome).length
  const parts = [saved ? `新保存 ${saved} 个文件` : '', reused ? `${reused} 个文件已存在` : '',
    count('created') ? `本仓库新增 ${count('created')} 项` : '', count('restored') ? `恢复 ${count('restored')} 项` : '', count('existing') ? `本仓库已有 ${count('existing')} 项` : '',
    showSpaceHint && !result.collect && result.saved.length ? '文件可在“文件空间”页稍后收录' : '', result.errors.length ? `${result.errors.length} 项未完成：${result.errors.map(e => `第 ${e.index + 1} 项 ${e.message}`).join('；')}` : '']
  return parts.filter(Boolean).join('；') || '没有可导入的内容'
}
