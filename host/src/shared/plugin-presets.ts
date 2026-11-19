import { z } from 'zod'
import { readWorkbenchLayout, type WorkbenchLayout } from './workbench-layout'

const pluginId = z.string().regex(/^[a-z][a-z0-9-]{0,79}$/).refine(id => id !== 'host')
export const presetTitleSchema = z.string().trim().min(1).max(80)
export const presetKeySchema = z.string().uuid()
export const pluginSelectionSchema = z.object({
  disabled: z.array(pluginId).max(1000),
  external: z.array(z.object({ id: pluginId, hash: z.string().regex(/^[a-f0-9]{64}$/), enabled: z.boolean() }).strict()).max(100)
}).strict().superRefine((s, ctx) => {
  if (new Set(s.disabled).size !== s.disabled.length || new Set(s.external.map(p => p.id)).size !== s.external.length)
    ctx.addIssue({ code: 'custom', message: '插件选择不能重复' })
})
export const presetLayoutSchema = z.unknown().transform((value, ctx) => {
  try { return readWorkbenchLayout(value) } catch (e) { ctx.addIssue({ code: 'custom', message: String(e) }); return z.NEVER }
})
export const presetReferenceSchema = z.string().max(200).refine(id => z.string().uuid().safeParse(id).success || /^suite:[a-z][a-z0-9-]{0,79}:[a-z][a-z0-9-]{0,79}$/.test(id))
export const pluginPresetSchema = z.object({
  id: presetReferenceSchema, revision: z.string().min(1).max(100), title: presetTitleSchema,
  description: z.string().max(2000).optional(), layout: presetLayoutSchema.optional(),
  plugins: z.array(z.object({ id: pluginId, title: z.string().min(1).max(100), version: z.string().max(80).optional(), hash: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict()).max(1000)
}).strict().refine(p => new Set(p.plugins.map(v => v.id)).size === p.plugins.length, '组合中的插件不能重复')
export type PluginSelection = z.infer<typeof pluginSelectionSchema>
export type PluginPreset = z.infer<typeof pluginPresetSchema> & { source?: { kind: 'user' } | { kind: 'suite'; id: string; title: string; version: string; bundled?: boolean }; editable?: boolean }
export interface PluginPresetOptions { description?: string; layout?: WorkbenchLayout | null }
export interface PresetArrangement { title: string; layout: WorkbenchLayout }
export interface PendingPresetArrangement extends PresetArrangement { id: string; problem?: string }
export type PluginPresetMode = 'add' | 'replace'
export interface PluginSelectionSnapshot {
  selection: PluginSelection
  /** 当前仓库选择、安装包和开发覆盖的校验基线；不用于标识组合。 */
  revision: string
  development: string[]
}
export interface PluginPresetPreview extends PluginSelectionSnapshot {
  versions?: { id: string; title: string; selected?: string; recommended?: string; choices: { hash: string; version: string }[] }[]
  changes: { id: string; title: string; enabled: boolean; version?: string; previousVersion?: string; dependency: boolean }[]
  issues: string[]
  warnings: string[]
}

/** 应用保存组合目录；读取／应用选择绑定当前仓库。没有安装、授权或业务配置入口。 */
export interface PluginPresetService {
  list(): Promise<PluginPreset[]>
  onChanged(listener: () => void): () => void
  current(): Promise<PluginSelectionSnapshot>
  /** 不传 selection 时捕获仓库已保存的选择；传入时保存界面的待应用选择。 */
  save(title: string, selection?: PluginSelection, options?: PluginPresetOptions): Promise<PluginPreset>
  copy(id: string, title: string): Promise<PluginPreset>
  rename(id: string, revision: string, title: string): Promise<PluginPreset>
  update(id: string, revision: string, selection?: PluginSelection, options?: PluginPresetOptions): Promise<PluginPreset>
  remove(id: string, revision: string): Promise<void>
  /** base 为已有草稿；预演不写入、不重载，不静默跳过缺包或冲突。 */
  preview(id: string, mode: PluginPresetMode, base?: PluginSelection, versions?: PluginSelection['external']): Promise<PluginPresetPreview>
  /** 重新检查基线与选择，有配置变化时页面收尾后保存并重载；配置已满足时只登记布局接续，不销毁调用者。 */
  apply(selection: PluginSelection, revision: string, arrangement?: PresetArrangement): Promise<{ reloaded: boolean }>
  /** 只读接续状态；problem 表示目标选择不同或所需插件未成功运行。 */
  pending(): Promise<PendingPresetArrangement | undefined>
  retryPending(id: string): Promise<void>
  cancelPending(id: string): Promise<void>
}

/** 宿主内部接续确认；插件管理界面不负责落盘完成回执。 */
export interface PluginPresetBridge extends PluginPresetService { finish(id: string): Promise<void> }
