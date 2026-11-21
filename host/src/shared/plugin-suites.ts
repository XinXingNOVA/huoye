import { packageLocalesSchema } from './package-locales'
import { z } from 'zod'
import { pluginPresetSchema } from './plugin-presets'
const id = z.string().regex(/^[a-z][a-z0-9-]{0,79}$/)
export const suiteThemeRef = z.object({ id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/), file: z.string().regex(/^[a-z0-9_-]+\.hytheme$/), hash: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
export const recommendedTheme = z.string().regex(/^(external:)?[a-z][a-z0-9-]{0,63}$/)
export const suiteManifestSchema = z.object({
  formatVersion: z.literal(1), id, title: z.string().trim().min(1).max(100),
  version: z.string().max(40).regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/).refine(v => v.split('.').every(n => Number.isSafeInteger(Number(n)))), description: z.string().max(2000),
  locales: packageLocalesSchema.optional(),
  themes: z.array(suiteThemeRef).max(8).optional(),
  packages: z.array(z.object({ file: z.string().regex(/^[a-zA-Z0-9_-]+\.(hyplugin|rmplugin)$/), id, version: z.string(), hash: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).max(50),
  presets: z.array(z.object(pluginPresetSchema.shape).omit({ id: true, revision: true }).extend({ id, recommendedTheme: recommendedTheme.optional() })).min(1).max(30)
}).strict().superRefine((v, ctx) => {
  for (const values of [v.packages.map(p => p.id), v.packages.map(p => p.file.toLowerCase()), v.presets.map(p => p.id)])
    if (new Set(values).size !== values.length) ctx.addIssue({ code: 'custom', message: '套件中的包或方案不能重复' })
  const themes = v.themes ?? []
  if (new Set(themes.map(t => t.id)).size !== themes.length || new Set(themes.map(t => t.file)).size !== themes.length)
    ctx.addIssue({ code: 'custom', message: '套件中的主题重复' })
  for (const p of v.presets) if (p.recommendedTheme?.startsWith('external:') && !themes.some(t => 'external:' + t.id === p.recommendedTheme))
    ctx.addIssue({ code: 'custom', message: '推荐外部主题必须随套件提供' })
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

/** 随套件交付的主题使用内容摘要固定版本，内置主题继续使用稳定 ID。 */
export function suiteThemeId(manifest: SuiteManifest, recommendation?: string) {
  if (!recommendation?.startsWith('external:')) return recommendation
  const ref = manifest.themes?.find(t => 'external:' + t.id === recommendation)
  if (!ref) throw new Error('套件中缺少推荐主题')
  return recommendation + '@' + ref.hash
}
