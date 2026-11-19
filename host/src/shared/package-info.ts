import type { PluginInfo } from './plugin-plan'
import type { PackageRef } from './external-plugins'

/** 纯元信息转换，界面预演不加载安装包校验器。 */
export const packageInfo = (p: PackageRef, problem?: string): PluginInfo => ({
  id: p.manifest.id, title: p.manifest.title, description: p.manifest.description, catalog: p.manifest.catalog,
  requires: p.manifest.requires, optional: p.manifest.optional, entries: p.manifest.entries,
  external: { hash: p.hash, version: p.manifest.version }, problem
})
