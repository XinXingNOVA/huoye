import { z } from 'zod'
import { creationRequestSchema } from './application-creation'
import { creationPluginsSchema, startingPresetSchema } from './library-creation'
import { pluginSelectionSchema, presetLayoutSchema, type PluginPresetPreview, type PluginSelectionSnapshot } from './plugin-presets'
import type { PackagePreview, PackageRef } from './external-plugins'

export const managementSchemas = {
  preview_workbench: z.object({ libraryId: z.string().min(1), layout: presetLayoutSchema.optional() }).strict(),
  configure_workbench: creationRequestSchema.extend({ libraryId: z.string().min(1), layout: presetLayoutSchema, revision: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  get_workbench_configuration: creationRequestSchema.extend({ libraryId: z.string().min(1) }).strict(),
  request_package_installation: creationRequestSchema.extend({ paths: z.array(z.string().min(1).max(4096)).min(1).max(50) }).strict(),
  get_package_installation: creationRequestSchema,
  install_packages: creationRequestSchema,
  preview_library_plugins: z.object({ libraryId: z.string().min(1), preset: startingPresetSchema.optional(), plugins: creationPluginsSchema.optional(), mode: z.enum(['add', 'replace']).default('add') }).strict().refine(v => !!v.preset !== !!v.plugins, '请选择方案或明确插件组合'),
  configure_library_plugins: creationRequestSchema.extend({ libraryId: z.string().min(1), selection: pluginSelectionSchema, revision: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  cancel_library_configuration: creationRequestSchema.extend({ libraryId: z.string().min(1) }).strict(),
  get_library_configuration: creationRequestSchema.extend({ libraryId: z.string().min(1) }).strict(),
  list_allowed_file_spaces: z.object({}).strict(),
  link_library_file_space: z.object({ libraryId: z.string().min(1), spaceId: z.string().uuid() }).strict()
}
export type ManagementAction = keyof typeof managementSchemas
export const localManagementSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list') }).strict(),
  z.object({ action: z.literal('approve-installation'), requestId: creationRequestSchema.shape.requestId }).strict(),
  z.object({ action: z.literal('cancel-configuration'), requestId: creationRequestSchema.shape.requestId }).strict(),
  z.object({ action: z.literal('cancel-installation'), requestId: creationRequestSchema.shape.requestId }).strict(),
  z.object({ action: z.literal('package-permission'), hash: z.string().regex(/^[a-f0-9]{64}$/), allowed: z.boolean() }).strict(),
  z.object({ action: z.literal('package-permissions'), hashes: z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1).max(500), allowed: z.boolean() }).strict(),
  z.object({ action: z.literal('allow-space'), sourceKind: z.enum(['managed','directory']).optional(), root: z.string().min(1).max(4096) }).strict(),
  z.object({ action: z.literal('remove-space'), spaceId: z.string().uuid() }).strict()
])
export interface ManagedInstallation {
  requestId: string; state: 'pending' | 'completed' | 'cancelled'; approvalRequired: PackageRef[]
  preview: PackagePreview; error?: string
}
export interface AllowedSpace { id: string; root: string; name: string; sourceKind?: 'managed' | 'directory' }
export interface ManagementSettings {
  suites: { id: string; title: string; locales?: import('./package-locales').PackageLocales; version: string; hashes: string[] }[]
  configurations: { requestId: string; libraryId: string; root: string; saved: boolean; error?: string }[]
  installations: ManagedInstallation[]
  packages: (PackageRef & { allowed: boolean; bundled: boolean; installed: boolean })[]
  spaces: AllowedSpace[]
}
export interface LibraryConfiguration {
  requestId: string; libraryId: string; state: 'pending' | 'completed' | 'cancelled'; saved: boolean; running: boolean
  error?: string; runtimeProblems: string[]; layoutPending: boolean
}
export interface ManagedPluginPreview extends PluginPresetPreview { current: PluginSelectionSnapshot['selection'] }
