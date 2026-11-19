import { app, safeStorage } from 'electron'
import { join } from 'node:path'
import { servicePlugins } from '../plugins/services'
import { executables } from '../plugins/generated/executables'
import { enabledPlugins } from '../shared/plugin-plan'
import { ServiceRuntime } from './service-runtime'
import { callCore } from './core-client'
import type { OpenLibrary } from './libraries'
import { externalServices } from './external-services'
import { pluginLocalStore } from './plugin-local-store'

export async function startServices(lib: OpenLibrary): Promise<void> {
  // 捕获这次核心进程；旧实例不能在重载后悄悄获得新核心。
  const { core, id, root } = lib
  const plugins = [...servicePlugins]
  const runtime = new ServiceRuntime(plugins, plugin => ({
    library: { id, root },
    executable(name) {
      if (!executables.some(e => e.id === plugin && e.name === name)) throw new Error('插件未声明这个独立入口')
      return { command: process.execPath, args: [join(__dirname, `${name}.js`)], env: { ELECTRON_RUN_AS_NODE: '1' } }
    }
  }))
  lib.services = runtime
  const stopped = () => { void runtime.stop() }
  core.once('exit', stopped)
  try {
    const manifest = await callCore(core, 'plugins')
    lib.localPlugins = new Set(manifest.filter(p => p.enabled).map(p => p.id))
    const selected = lib.packages.filter(p => manifest.some(m => m.id === p.manifest.id && m.external?.hash === p.hash && m.enabled))
    plugins.push(...externalServices(selected, (plugin, signal) => pluginLocalStore({
      directory: join(app.getPath('userData'), 'plugin-local'), plugin, root, active: () => !signal.aborted,
      protection: {
        available: () => safeStorage.isEncryptionAvailable() && (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'),
        encrypt: value => safeStorage.encryptString(value), decrypt: value => safeStorage.decryptString(value)
      }
    })))
    const { assembly } = await callCore(core, 'info')
    await runtime.start(enabledPlugins(assembly, manifest))
  } catch (error) {
    await runtime.stop()
    console.error('[services]', error)
  }
}
