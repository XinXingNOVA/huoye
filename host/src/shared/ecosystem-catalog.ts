import { z } from 'zod'
import type { ApplicationAccessSettings } from './application-access'
import type { accessCapabilities, AccessMode } from './external-access'
import type { PluginCatalog } from './plugin-presentation'

export const ecosystemCatalogSchema = z.object({
  libraryId: z.string().min(1).max(200).optional(),
  offset: z.number().int().min(0).max(100000).default(0),
  limit: z.number().int().min(1).max(100).default(30),
  snapshot: z.string().regex(/^[a-f0-9]{64}$/).optional()
}).strict()
export type EcosystemCatalogInput = z.input<typeof ecosystemCatalogSchema>
export interface EcosystemEntry {
  kind: 'plugin' | 'suite' | 'preset'
  id: string; title: string; description: string
  source: 'builtin' | 'bundled' | 'installed' | 'suite' | 'user'
  version?: string; hash?: string; revision?: string
  scope?: 'application' | 'library'; required?: boolean
  catalog?: PluginCatalog
  installed?: boolean
  requires: string[]
  /** 仅静态依赖和接口预检；不执行插件，不证明业务／界面装配成功。 */
  issues: string[]
  runtime: 'not-checked'
  authorization?: 'builtin' | 'bundled-on-first-open' | 'granted' | 'approval-required' | 'blocked' | 'not-installed'
  plugins?: { id: string; version?: string; hash?: string }[]
  presets?: string[]
  hasLayout?: boolean
}
export interface EcosystemCatalog {
  creation: ApplicationAccessSettings['creation']
  target?: { libraryId: string; mode: AccessMode; permissions: ReturnType<typeof accessCapabilities> & { autonomousDevelopment: boolean } }
  /** 当前接口可用性与已授予的管理权限分别表达。 */
  supported: { defaultCreation: true; creationWithPreset: boolean; backgroundCreation: boolean; creationRecovery: boolean; pluginConfiguration: boolean; packageInstallation: boolean; spaceAssociation: boolean; workbenchConfiguration: boolean }
  entries: EcosystemEntry[]; total: number; nextOffset: number | null; snapshot: string
}
