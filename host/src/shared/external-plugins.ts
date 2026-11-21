import { packageLocalesSchema } from './package-locales.ts'
import { z } from 'zod'
import type { PluginInfo } from './plugin-plan'
import type { BlockKind } from './blocks'
import { pluginCatalogSchema } from './plugin-catalog-schema.ts'

export const PACKAGE_API = 1
// 退役标记只保留元信息读取：旧安装／仓库登记仍可查看和卸载，加载时明确拒绝，不再提供旧实现。
export const uiFeaturesSchema = z.array(z.enum(['media-recording-v1', 'window-surfaces-v1', 'block-sections-v1', 'content-selection-v1', 'navigation-order-v1', 'file-edits-v1', 'view-containers-v1', 'editor-groups-v1', 'open-target-v1', 'page-lifecycle-v1', 'page-instances-v1', 'shared-editing-v1', 'edit-history-v1', 'query-in-v1', 'open-with-v1', 'file-working-copy-v1', 'file-working-copy-service-v1', 'collection-surface-v1', 'page-inputs-v1', 'reactive-badges-v1', 'file-working-copy-ui-v1', 'browsing-layout-v1', 'workbench-presets-v1', 'workbench-content-v1', 'plugin-presets-v1', 'operation-history-v1', 'database-maintenance-v1', 'scoped-facets-v1', 'settings-navigation-v1', 'settings-appearance-v1', 'ui-commands-v1', 'context-tools-v1', 'bound-context-tools-v1', 'tool-docking-v1', 'tool-placement-v1', 'quick-actions-v1', 'ui-extension-points-v1', 'facet-identity-v1', 'query-subtree-v1', 'plugin-local-state-v1', 'block-facets-v1', 'entity-identities-v1', 'content-drop-v1', 'navigation-context-v1', 'exclusive-filter-v1', 'processing-status-v1', 'read-preview-v1', 'workbench-session-v1', 'ui-kit-v1', 'ui-locale-v1', 'ui-schema-labels-v1'])).max(32).refine(a => new Set(a).size === a.length, '界面能力声明不能重复')
/** 数据驱动的附加字段定义；声明本身也是版本兼容契约。 */
export const definitionsSchema = z.object({ kind: z.string().min(1), prefix: z.string().regex(/^[a-z][a-z0-9-]*:$/) }).strict()
export const coreFeaturesSchema = z.array(z.enum(['image-sample-v1', 'image-crop-v1', 'compatible-schemas-v1', 'business-queries-v1', 'ingest-metadata-v1', 'ingest-read-v1', 'command-trash-v1', 'command-restore-v1', 'read-title-candidates-v1', 'query-in-v1', 'scoped-facets-v1', 'query-subtree-v1', 'data-lifecycle-v1', 'operation-effects-v1', 'entity-roles-v1', 'operation-review-v1'])).max(16).refine(a => new Set(a).size === a.length, '能力声明不能重复')
const id = z.string().regex(/^[a-z][a-z0-9-]{0,79}$/).refine(s => s !== 'host', '保留的插件 ID')
export const packageManifestSchema = z.object({
  formatVersion: z.literal(1), apiVersion: z.literal(PACKAGE_API),
  id, title: z.string().min(1).max(100), description: z.string().max(2000),
  locales: packageLocalesSchema.optional(),
  catalog: pluginCatalogSchema.optional(),
  author: z.string().min(1).max(100), version: z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/),
  /** 新 UI 契约显式声明；旧宿主拒绝未知能力，避免静默丢失界面贡献。 */
  uiFeatures: uiFeaturesSchema.optional(),
  definitions: definitionsSchema.optional(),
  coreFeatures: coreFeaturesSchema.optional(),
  requires: z.array(id).max(30).default([]), optional: z.array(id).max(30).default([]),
  entries: z.object({ core: z.literal('core.mjs').optional(), ui: z.literal('ui.mjs').optional(), service: z.literal('service.mjs').optional() }).strict()
    .refine(e => !!e.core || !!e.ui || !!e.service, '需要 core、ui 或 service 入口'),
  styles: z.array(z.string()).max(10).default([])
}).strict().superRefine((p, ctx) => {
  const deps = [...p.requires, ...p.optional]
  if (p.definitions && !p.entries.core) ctx.addIssue({ code: 'custom', message: '动态定义需要核心入口' })
  if (p.coreFeatures?.length && !p.entries.core) ctx.addIssue({ code: 'custom', message: '核心能力需要 core 入口' })
  if (p.coreFeatures?.includes('ingest-read-v1') && !p.coreFeatures.includes('ingest-metadata-v1')) ctx.addIssue({ code: 'custom', message: 'ingest-read-v1 需要同时声明 ingest-metadata-v1' })
  if (deps.includes(p.id) || new Set(deps).size !== deps.length) ctx.addIssue({ code: 'custom', message: '依赖不能重复或指向自身' })
})
export type PackageManifest = z.infer<typeof packageManifestSchema>
export interface PackageRef { manifest: PackageManifest; hash: string }
export interface InstalledPackage extends PackageRef { directory: string; problem?: string; development?: boolean }
export interface ExternalBinding extends PackageRef { enabled: boolean }
export const bindingSchema = z.object({ manifest: packageManifestSchema, hash: z.string().regex(/^[a-f0-9]{64}$/), enabled: z.boolean() }).strict()
export const pluginSettingsSchema = z.object({ disabled: z.array(z.string()).max(1000), external: bindingSchema.array().max(100) }).strict()
export const packageChangesSchema = z.object({
  disabled: z.array(z.string()).max(1000),
  changes: z.array(z.object({ hash: z.string().regex(/^[a-f0-9]{64}$/), enabled: z.boolean() }).strict()).max(100)
}).strict()
export type PackageChanges = z.infer<typeof packageChangesSchema>
export interface PackageRow extends PackageRef {
  installed: boolean; selected: boolean; enabled: boolean; running: boolean; reason?: string
  /** 由本机应用交付记录核对确切摘要，包不能自行声明。 */
  bundled?: boolean
  development?: boolean
}
export interface PackageInstallItem {
  /** 批内稳定行号；文件名可重复，不作为身份。 */
  index: number
  file: string
  status: 'ready' | 'existing' | 'duplicate' | 'invalid' | 'installed' | 'failed' | 'reused' | 'skipped'
  manifest?: PackageManifest
  hash?: string
  bytes?: number
  files?: number
  alternatives?: { hash: string; version: string }[]
  reuseHash?: string
  error?: string
}
/** 预览和安装结果使用同一批次；成功安装项不重装，套件复用／跳过选择在重试时保留。 */
export interface PackagePreview { token: string; items: PackageInstallItem[]; suites?: import('./plugin-suites').SuiteInstallResult[] }
export interface DevelopmentBuildState { state: 'building' | 'ready' | 'error' | 'stopped'; message?: string }
export interface DevelopmentSourceRow {
  source: string; id?: string; title: string; version?: string; description?: string
  appliedHash?: string; availableHash?: string; problem?: string
  build?: DevelopmentBuildState; running?: boolean; reason?: string
}
export interface DevelopmentDirectoryState {
  directory?: string; directories?: string[]; toolchain?: string; problem?: string; rows: DevelopmentSourceRow[]
}
export const developmentSelectionSchema = z.array(z.object({ source: z.string().min(1), hash: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).max(100)
export type DevelopmentSelection = z.infer<typeof developmentSelectionSchema>
export interface PackageBridge {
  developmentDirectory(): Promise<DevelopmentDirectoryState>
  pickDevelopmentDirectory(): Promise<boolean>
  removeDevelopmentDirectory(directory: string): Promise<void>
  pickDevelopmentToolchain(): Promise<boolean>
  prepareDevelopmentSources(sources: string[], retry?: boolean): Promise<void>
  applyDevelopmentDirectory(selection: DevelopmentSelection): Promise<void>
  clearDevelopmentDirectory(): Promise<void>
  list(): Promise<PackageRow[]>
  installed(): Promise<PackageRow[]>
  suites(): Promise<import('./plugin-suites').SuiteRegistration[]>
  removeSuite(id: string, hash: string): Promise<void>
  onChanged(listener: () => void): () => void
  pickUpdate(hash: string): Promise<import('./plugin-updates').PackageUpdatePreview | null>
  startUpdate(token: string): Promise<import('./plugin-updates').PackageUpdateJob>
  pendingUpdate(): Promise<import('./plugin-updates').PackageUpdateJob | null>
  resumeUpdate(token: string): Promise<import('./plugin-updates').PackageUpdateJob>
  cancelUpdate(token: string): Promise<void>
  pick(suiteId?: string): Promise<PackagePreview | null>
  install(token: string, choices?: { index: number; hash: string | null }[]): Promise<PackagePreview>
  cancelInstall(token: string): Promise<void>
  /** 保存内外插件的一批选择；调用者随后统一重载。 */
  apply(settings: PackageChanges): Promise<void>
  removal(hash: string): Promise<string[]>
  uninstall(hash: string): Promise<void>
  runtime(): Promise<{ manifest: PluginInfo[]; packages: PackageRef[]; base: string }>
  failed(id: string, message: string): Promise<void>
  ready(): Promise<void>
}

export { packageInfo } from './package-info.ts'

/** 持久定义快照不携带函数；与 Host 的仓库快照共用。 */
export function kindSnapshot(k: BlockKind): BlockKind {
  const { id, plugin, title, rebuildable, content, container, allowOnContainer, history, standalone, management, captured, template, version, fields, display } = k
  return JSON.parse(JSON.stringify({ id, plugin, title, rebuildable, content, container, allowOnContainer, history, standalone, management, captured, template, version, fields, display }))
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
  return JSON.stringify(value)
}
