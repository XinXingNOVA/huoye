import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import type { InstalledPackage } from '../shared/external-plugins'
import type { ServicePlugin } from '../plugin-api/service'
import type { LocalServiceContext, LocalServicePlugin } from '../plugin-api/local-service'

/** 延迟到启用后才加载模块；服务实例状态放在 start 中，不能放模块全局。 */
export function externalServices(packages: InstalledPackage[], local: (plugin: string, signal: AbortSignal) => Pick<LocalServiceContext, 'settings' | 'secrets'>): ServicePlugin[] {
  return packages.filter(p => !p.problem && p.manifest.entries.service).map(pack => ({
    id: pack.manifest.id,
    async start(ctx) {
      const module = await import(/* @vite-ignore */ pathToFileURL(join(pack.directory, pack.manifest.entries.service!)).href) as { plugin: LocalServicePlugin }
      if (ctx.signal.aborted) throw new Error('[SERVICE_UNAVAILABLE] 服务加载已取消')
      if (!module.plugin || module.plugin.id !== pack.manifest.id || typeof module.plugin.start !== 'function') throw new Error('服务 ID 或 start 导出与声明不符')
      const instance = await module.plugin.start({ library: ctx.library, signal: ctx.signal, onDispose: ctx.onDispose, ...local(pack.manifest.id, ctx.signal) })
      if (!instance || typeof instance !== 'object' || (instance.invoke !== undefined && typeof instance.invoke !== 'function') || (instance.stream !== undefined && typeof instance.stream !== 'function')) throw new Error('服务实例必须提供有效的 invoke / stream')
      return instance
    }
  }))
}
