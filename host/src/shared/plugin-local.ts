import { z } from 'zod'
import type { LocalScope, LocalValue } from '../plugin-api/local-service'
export const localPluginSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/).refine(v => !['__proto__', 'constructor', 'prototype'].includes(v))
export const localScopeSchema = z.enum(['application', 'library'])
export const localCategorySchema = z.enum(['settings', 'secrets', 'state'])
export const localCleanupSchema = z.object({ pluginId: localPluginSchema, scope: localScopeSchema, categories: z.array(localCategorySchema).min(1).max(3).refine(v => new Set(v).size === v.length) }).strict()
export type LocalCategory = z.infer<typeof localCategorySchema>
export type LocalCleanupRequest = z.infer<typeof localCleanupSchema>
export interface LocalDataFile { category: LocalCategory; keys: string[]; bytes: number; error?: string }
export interface LocalDataInfo { pluginId: string; files: LocalDataFile[]; pending: boolean }
export interface LocalDataPreview extends LocalCleanupRequest { token: string; files: LocalDataFile[]; blocked: string[] }
export interface LocalDataResult { pluginId: string; scope: LocalScope; token: string; items: { category: LocalCategory; status: 'done' | 'pending' | 'retained'; error?: string }[] }
export interface LocalDataBridge {
  list(scope: LocalScope): Promise<LocalDataInfo[]>
  preview(input: LocalCleanupRequest): Promise<LocalDataPreview>
  clean(input: LocalCleanupRequest & { token: string }): Promise<LocalDataResult>
  retry(input: { pluginId: string; scope: LocalScope }): Promise<LocalDataResult>
  state(pluginId: string, scope: LocalScope, action: 'get' | 'set' | 'remove' | 'importOnce', key: string, value?: LocalValue): Promise<LocalValue | undefined>
  onChanged(listener: (event: { pluginId: string; scope: LocalScope; key?: string }) => void): () => void
}
