import { z } from 'zod'
import { libraryNameSchema } from './library-name'
import { presetReferenceSchema, pluginSelectionSchema, type PluginPreset, type PluginPresetPreview } from './plugin-presets'
import { pluginSettingsSchema } from './external-plugins'

export const startingPresetSchema = z.object({
  id: presetReferenceSchema, revision: z.string().min(1).max(100),
  versions: pluginSelectionSchema.shape.external.default([]),
  layout: z.boolean().default(true)
}).strict()
export const creationPluginsSchema = z.array(z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,79}$/), hash: z.string().regex(/^[a-f0-9]{64}$/).optional()
}).strict()).max(100).refine(rows => new Set(rows.map(p => p.id)).size === rows.length, '插件选择不能重复')
export interface LauncherFolder { path: string; name: string; parent: string; kind: 'library' | 'empty' | 'other'; token?: string }
export const creationSourceSchema = z.object({ root: z.string(), device: z.string(), inode: z.string() }).strict()
export type CreationSource = z.infer<typeof creationSourceSchema>
export interface SourceIntroduction { spaceId: string; name: string }
export const createVaultSchema = z.object({
  parent: z.string().min(1).max(4096), name: libraryNameSchema,
  spaceRoot: z.string().min(1).max(4096).optional(), spaceId: z.string().uuid().optional(), preset: startingPresetSchema.optional(), plugins: creationPluginsSchema.optional(),
  previewRevision: z.string().min(1).max(100).optional()
}).strict().refine(v => !(v.preset && v.plugins), '起始方案与明确插件组合只能选择一种')
export type CreateVaultInput = z.input<typeof createVaultSchema>
export type StartingPreset = z.infer<typeof startingPresetSchema>
export interface CreationPreview extends PluginPresetPreview {
  preset?: PluginPreset
  versions: { id: string; title: string; choices: { hash: string; version: string }[] }[]
}
/** 仅用于宿主初次装配；核心仍是数据库唯一写入者。 */
export const libraryInitializationSchema = z.object({
  id: z.string().uuid(), libraryId: z.string().uuid(), settings: pluginSettingsSchema.optional()
}).strict()
export type LibraryInitialization = z.infer<typeof libraryInitializationSchema>
export interface CreationRecovery {
  id: string; root: string; name: string; title?: string; error?: string
}
export type VaultResult = { ok: true } | { error: string; recovery?: CreationRecovery }
export interface CreationBridge {
  preview(preset?: z.input<typeof startingPresetSchema>, plugins?: CreateVaultInput['plugins']): Promise<CreationPreview>
  pickFolder(purpose: 'open' | 'source'): Promise<LauncherFolder | null>
  introduction(): Promise<SourceIntroduction | null>
  dismissIntroduction(spaceId: string): Promise<void>
  create(input: CreateVaultInput, sourceToken?: string): Promise<VaultResult>
  pending(): Promise<CreationRecovery[]>
  resume(id: string): Promise<VaultResult>
  openBasic(id: string): Promise<VaultResult>
  dismiss(id: string): Promise<void>
}
