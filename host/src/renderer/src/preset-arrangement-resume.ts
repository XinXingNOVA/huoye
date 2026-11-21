import { uiText } from '../../shared/i18n/interface-display'
import type { PluginPresetBridge } from '../../shared/plugin-presets'
import type { WorkbenchLayout } from '../../shared/workbench-layout'

/** 完成回执随工作区同次保存；落盘后、清接续记录前崩溃也不会再次套用。 */
export async function resumePresetArrangement(api: Pick<PluginPresetBridge, 'pending' | 'finish'>, actions: {
  alive(): boolean
  receipt(): string | undefined
  inspect(layout: WorkbenchLayout): string[]
  apply(layout: WorkbenchLayout, id: string): boolean
  checkpoint(): Promise<void>
}) {
  const job = await api.pending()
  if (!job || !actions.alive()) return
  if (job.problem) throw new Error(`${job.title}：${job.problem}`)
  if (actions.receipt() !== job.id) {
    const issues = actions.inspect(job.layout)
    if (issues.length) throw new Error(uiText("{title}：{value2}。配套布局尚未应用，可在插件组合中重试或取消", { title: String(job.title), value2: String(issues.join('；')) }))
    if (!actions.apply(job.layout, job.id)) throw new Error(uiText("工作台暂时忙碌，配套布局已保留，可在插件组合中重试"))
  }
  await actions.checkpoint()
  await api.finish(job.id)
  return job.title
}
