import { z } from 'zod'
import type { AccessMode } from './external-access'
import type { DevelopmentGrant } from './development-access'

export const accessMode = z.enum(['off', 'read', 'organize', 'admin'])
export const creationPolicySchema = z.object({ parent: z.string().min(1), mode: z.enum(['read', 'organize', 'admin']), autonomousDevelopment: z.boolean().optional() }).strict().refine(p => !p.autonomousDevelopment || p.mode === 'admin', '自主开发需要托管创建权限').nullable()
export const fileSpaceGrantSchema = z.object({ spaceId: z.string().uuid(), revise: z.boolean(), recycle: z.boolean(), browseDirectory: z.boolean().optional() }).strict()
export type FileSpaceGrant = z.infer<typeof fileSpaceGrantSchema>
export const applicationSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  developmentMode: z.boolean().optional(),
  projectToolchain: z.string().min(1).optional(),
  creation: creationPolicySchema.optional(),
  grant: z.object({ key: z.string(), mode: accessMode, autonomousDevelopment: z.boolean().optional(), fileSpaces: z.array(fileSpaceGrantSchema).max(100).refine(a => new Set(a.map(s => s.spaceId)).size === a.length).optional() }).strict().optional()
}).strict()
export type ApplicationAccessChange = z.infer<typeof applicationSettingsSchema>
export interface LibraryGrant { key: string; libraryId: string; root: string; name: string; mode: AccessMode; fileSpaces?: FileSpaceGrant[]; development?: DevelopmentGrant; projectToolchain?: string }
export interface ApplicationAccessSettings {
  enabled: boolean
  developmentMode: boolean
  projectToolchain?: string
  creation: z.infer<typeof creationPolicySchema>
  libraries: (LibraryGrant & { open: boolean })[]
}
export interface LibraryTarget { libraryId: string; root: string; name: string; open: boolean; mode: AccessMode; fileSpaces?: FileSpaceGrant[] }
export const libraryTargetSchema = z.object({ libraryId: z.string().min(1).max(200) }).strict()
export { createLibrarySchema, creationPreviewSchema, creationRequestSchema } from './application-creation'
export type { CreateLibraryInput, CreateLibraryReceipt } from './application-creation'


/** 仅应用设置使用；key 来自本机登记，不能传任意空间路径。 */
export const applicationSpacePermissionSchema = z.object({
  key: z.string().min(1), spaceId: z.string().uuid(), permission: z.enum(['revise', 'recycle']),
  enabled: z.boolean(), revision: z.number().int().positive()
}).strict()
export type ApplicationSpacePermissionInput = z.infer<typeof applicationSpacePermissionSchema>
export interface ApplicationSpacePermissionResult { revision: number; members: { id: string; name: string; revise: boolean; recycle: boolean }[] }
