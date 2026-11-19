import { z } from 'zod'
import { pluginPresetSchema } from './plugin-presets'
const id = z.string().regex(/^[a-z][a-z0-9-]{0,79}$/)
export const suiteManifestSchema = z.object({
  formatVersion: z.literal(1), id, title: z.string().trim().min(1).max(100),
  version: z.string().max(40).regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/).refine(v => v.split('.').every(n => Number.isSafeInteger(Number(n)))), description: z.string().max(2000),
  packages: z.array(z.object({ file: z.string().regex(/^[a-zA-Z0-9_-]+\.(hyplugin|rmplugin)$/), id, version: z.string(), hash: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).max(50),
  presets: z.array(z.object(pluginPresetSchema.shape).omit({ id: true, revision: true }).extend({ id })).min(1).max(30)
}).strict().superRefine((v, ctx) => {
  for (const values of [v.packages.map(p => p.id), v.packages.map(p => p.file.toLowerCase()), v.presets.map(p => p.id)])
    if (new Set(values).size !== values.length) ctx.addIssue({ code: 'custom', message: '套件中的包或方案不能重复' })
  for (const p of v.presets) if (new Set(p.plugins.map(i => i.id)).size !== p.plugins.length) ctx.addIssue({ code: 'custom', message: '方案中的插件不能重复' })
  for (const p of v.presets) for (const item of p.plugins) if (item.hash && !v.packages.some(pack => pack.id === item.id && pack.hash === item.hash)) ctx.addIssue({ code: 'custom', message: '方案推荐摘要必须指向套件中的包' })
})
export type SuiteManifest = z.infer<typeof suiteManifestSchema>
export interface SuiteRegistration { manifest: SuiteManifest; hash: string; bundled?: boolean; missing?: string[] }
export interface SuiteInstallResult {
  id: string; title: string; version: string; status: 'ready' | 'installed' | 'existing' | 'failed' | 'invalid' | 'incomplete'
  previousVersion?: string; changes?: string[]; missing?: string[]
  presets: { id: string; title: string }[]; error?: string
}
export const suitePresetId = (suite: string, preset: string) => `suite:${suite}:${preset}`
