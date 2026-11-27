import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { PluginDistribution } from '../../src/shared/plugin-distribution.ts'
import type { PluginInfo } from '../../src/shared/plugin-plan.ts'
import { capabilityDeclarationsSchema } from '../../src/shared/capability-declarations.ts'
import { pluginCatalogSchema } from '../../src/shared/plugin-catalog-schema.ts'

/** 发行元信息只从应用源码目录读取，不进入可分享的 plugin.json。 */
export function readDistribution(dir: string, info: PluginInfo, origin: PluginDistribution['origin']): PluginDistribution {
  const file = join(dir, 'distribution.json')
  const value = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { group: info.required ? 'base' : 'optional', defaultEnabled: !!info.required }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !['group', 'defaultEnabled', 'legacyBuiltin', 'legacyKinds', 'legacyDefinitionPrefixes'].includes(k)) ||
    !['base', 'common', 'recommended', 'optional', 'support'].includes(value.group) || typeof value.defaultEnabled !== 'boolean' ||
    (value.legacyBuiltin !== undefined && (typeof value.legacyBuiltin !== 'boolean' || origin !== 'bundled')) ||
    (value.legacyKinds !== undefined && (origin !== 'bundled' || value.legacyBuiltin !== true || !Array.isArray(value.legacyKinds) ||
      value.legacyKinds.some((id: unknown) => typeof id !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(id)) || new Set(value.legacyKinds).size !== value.legacyKinds.length)) ||
    (value.legacyDefinitionPrefixes !== undefined && (origin !== 'bundled' || value.legacyBuiltin !== true || !Array.isArray(value.legacyDefinitionPrefixes) ||
      value.legacyDefinitionPrefixes.some((id: unknown) => typeof id !== 'string' || !/^[a-z][a-z0-9-]*:$/.test(id)) || new Set(value.legacyDefinitionPrefixes).size !== value.legacyDefinitionPrefixes.length)) ||
    (value.group === 'base') !== !!info.required || (info.required && !value.defaultEnabled)) throw new Error(`${file}：发行策略无效`)
  return { id: info.id, title: info.title, origin, ...(info.catalog ? { catalog: info.catalog } : {}), ...(info.scope ? { scope: info.scope } : {}), ...value }
}

export function validateDistribution(catalog: PluginDistribution[]): void {
  const owners = new Map<string, string>()
  for (const p of catalog) for (const id of [...p.legacyKinds ?? [], ...p.legacyDefinitionPrefixes ?? []]) {
    if (owners.has(id) || catalog.some(other => (other.id === id || `${other.id}:` === id) && other.id !== p.id)) throw new Error(`旧数据块归属冲突：${id}`)
    owners.set(id, p.id)
  }
}

export function bundledDescriptors(project: string): { dir: string; info: PluginInfo }[] {
  const root = join(project, 'packaging', 'plugins')
  if (!existsSync(root)) return []
  // 目录归属不表示发行授权；此目录只保管宿主发行元信息，业务源码通过显式来源配置取得。
  return readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory() && existsSync(join(root, d.name, 'distribution.json'))).sort((a,b) => a.name.localeCompare(b.name)).map(d => {
    const dir = join(root, d.name), value = JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf8'))
    if (value.required || value.scope || typeof value.id !== 'string' || typeof value.title !== 'string') throw new Error(`${dir}：附带包声明无效`)
    // 此处只读取依赖元信息，包入口和其余字段由公共打包器完整校验。
    const info: PluginInfo = { id: value.id, title: value.title, description: value.description, capabilities: capabilityDeclarationsSchema.optional().parse(value.capabilities), catalog: value.catalog === undefined ? undefined : pluginCatalogSchema.parse(value.catalog), requires: value.requires, optional: value.optional }
    readDistribution(dir, info, 'bundled')
    return { dir, info }
  })
}
