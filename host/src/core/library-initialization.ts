import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Library } from './library'
import { adoptBundledPlugins } from './external-plugins'
import { libraryInitializationSchema, type LibraryInitialization } from '../shared/library-creation'
import type { PluginInfo } from '../shared/plugin-plan'
import type { PluginDistribution } from '../shared/plugin-distribution'
import type { PackageRef } from '../shared/external-plugins'

/** 初始选择和默认值交接同事务，必须早于加载任何外部代码。 */
export function initializeCreatedLibrary(lib: Library, initial: LibraryInitialization | undefined, builtin: PluginInfo[], bundled: PackageRef[], distribution: PluginDistribution[]) {
  const receipt = lib.db.prepare("SELECT value FROM main.meta WHERE key = 'creation_initialized'").pluck().get()
  if (!initial) {
    const marker = join(lib.root, '.creation.json')
    if (existsSync(marker)) {
      const task = JSON.parse(readFileSync(marker, 'utf8'))
      if (receipt !== task.id || task.libraryId !== lib.id) throw new Error('建库尚未完成，请从开始页接续')
    }
    adoptBundledPlugins(lib, bundled, builtin, distribution)
    return
  }
  const input = libraryInitializationSchema.parse(initial)
  if (lib.id !== input.libraryId) throw new Error('创建任务与仓库身份不一致')
  if (receipt === input.id) return // 重试不覆盖之后的选择。
  if (receipt || !lib.db.prepare("SELECT 1 FROM main.meta WHERE key = 'plugin_defaults_pending'").get()) throw new Error('此仓库已初始化，不能重新应用建库配置')
  lib.db.transaction(() => {
    adoptBundledPlugins(lib, bundled, builtin, distribution, input.settings)
    lib.db.prepare("INSERT INTO main.meta(key,value) VALUES ('creation_initialized',?)").run(input.id)
  })()
}
