import type { EntityView } from '../../shared/blocks'
import type { UiPlugin } from '../../plugin-api/ui/contracts'
import type { PluginInfo } from '../../shared/plugin-plan'
import { canOpenCopy, fileExtension } from '../../shared/open-copy'

export interface OpenChoice { id: string; title: string; detail: string; remember: boolean }
export type RegisteredOpener = OpenChoice & { contribution: NonNullable<UiPlugin['opens']>[number] }
export function collectOpeners(plugins: UiPlugin[], manifest: PluginInfo[]): RegisteredOpener[] {
  return plugins.flatMap(plugin => (plugin.opens ?? []).map((contribution, index) => {
    const name = manifest.find(p => p.id === plugin.id)?.title ?? plugin.id
    return { id: contribution.id ?? `legacy:${plugin.id}:${index}`, title: contribution.title ?? `${name}（${'tab' in contribution ? contribution.tab : '打开'}）`,
      detail: contribution.id ? name : `${name} · 旧版打开器，仅本次选择`, remember: !!contribution.id, contribution }
  })).sort((a, b) => a.contribution.priority - b.contribution.priority)
}

export function openerChoices(view: EntityView, openers: RegisteredOpener[]): OpenChoice[] {
  return [
    { id: 'host.auto', title: '自动选择', detail: openers[0] ? `当前使用：${openers[0].title}` : '当前使用：数据详情', remember: true },
    ...openers,
    { id: 'host.data', title: '数据详情', detail: '查看此素材的数据块', remember: true },
    ...(!view.deletedAt && canOpenCopy(view.blocks.file?.data.name) ? [{ id: 'host.system', title: '系统默认应用（查看副本）', detail: '打开本库已接纳版本的临时副本；修改不会回写', remember: true }] : [])
  ]
}

/** 显式选择失效要报错；偏好失效则自动回退，但不抹掉偏好（重启插件后可恢复）。 */
export function resolveOpener(choices: OpenChoice[], requested?: string, preferred?: string): string {
  if (requested) {
    if (!choices.some(o => o.id === requested)) throw new Error('所选打开方式已不可用，请重新选择')
    return requested
  }
  return choices.some(o => o.id === preferred) ? preferred! : 'host.auto'
}

export const openerType = (v: EntityView) => fileExtension(v.blocks.file?.data.name)
const preferenceKey = (libraryId: string, type: string) => `rm:opener:${libraryId}:${type}`
export function readOpenerPreference(storage: Pick<Storage, 'getItem'>, libraryId: string, type?: string): string | undefined {
  if (!type) return
  try { return storage.getItem(preferenceKey(libraryId, type)) || undefined } catch { return }
}
export function saveOpenerPreference(storage: Pick<Storage, 'setItem' | 'removeItem'>, libraryId: string, type: string, choice: OpenChoice): void {
  if (!choice.remember) throw new Error('此打开器没有稳定 ID，不能保存默认方式')
  if (choice.id === 'host.auto') storage.removeItem(preferenceKey(libraryId, type))
  else storage.setItem(preferenceKey(libraryId, type), choice.id)
}
