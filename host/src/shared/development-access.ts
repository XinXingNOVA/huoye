import { z } from 'zod'
import { packageManifestSchema } from './external-plugins'

const id = z.string().min(1).max(200), hash = z.string().regex(/^[a-f0-9]{64}$/)
const requestId = z.string().min(8).max(128).regex(/^[a-zA-Z0-9_-]+$/)
export const developmentGrantSchema = z.object({
  enabled: z.boolean(), capture: z.boolean(), toolchain: z.string().optional(),
  sources: z.array(z.object({ key: hash, source: z.string(), pluginId: id }).strict()).max(32)
}).strict()
export type DevelopmentGrant = z.infer<typeof developmentGrantSchema>
export const setDevelopmentGrantSchema = z.object({ key: id, enabled: z.boolean(), capture: z.boolean(), sourceIds: z.array(hash).max(32) }).strict()
export type SetDevelopmentGrant = z.infer<typeof setDevelopmentGrantSchema>
export interface DevelopmentCatalog {
  toolchain?: string
  problem?: string
  sources: { key: string; source: string; pluginId: string; title: string; problem?: string }[]
}
const library = { libraryId: id }
export const developmentProjectSchema = z.object({ ...library, requestId, pluginId: packageManifestSchema.shape.id, title: packageManifestSchema.shape.title }).strict()
export const developmentSchemas = {
  create_development_project: developmentProjectSchema,
  get_development_status: z.object({ ...library, requestId: requestId.optional() }).strict(),
  prepare_development_build: z.object({ ...library, sourceIds: z.array(hash).min(1).max(32), retry: z.boolean().default(false) }).strict(),
  apply_development_build: z.object({ ...library, selection: z.array(z.object({ sourceId: hash, hash }).strict()).max(32), revision: hash, session: z.string().uuid(), requestId }).strict(),
  control_library: z.object({ ...library, action: z.enum(['close', 'reload']), session: z.string().uuid(), requestId }).strict(),
  capture_workbench_window: z.object({ ...library, windowId: z.string().regex(/^(main|content:[a-zA-Z0-9_-]{1,100})$/), session: z.string().uuid(), windowRevision: z.number().int().nonnegative(), maxSide: z.number().int().min(256).max(1600).default(1280) }).strict()
}
export type DevelopmentAction = keyof typeof developmentSchemas
export type DevelopmentInput<K extends DevelopmentAction = DevelopmentAction> = z.infer<(typeof developmentSchemas)[K]>
export const projectActions: readonly DevelopmentAction[] = ['create_development_project', 'get_development_status', 'prepare_development_build', 'apply_development_build']
export interface DevelopmentTarget { projectToolchain?: string; libraryId: string; root: string; grant: DevelopmentGrant }
export interface DevelopmentBackend {
  resolveToolchain?(path?: string): string
  sources(root: string): DevelopmentCatalog | Promise<DevelopmentCatalog>
  execute(action: DevelopmentAction, input: DevelopmentInput, target: DevelopmentTarget, guard: () => void): Promise<unknown>
}
