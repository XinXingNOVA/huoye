import { applicationDirectories, notifyDirectoryCatalog } from './directory-spaces'
import { createApplicationManagement } from './application-management'
import { refreshSpaceWindows } from './space-notifications'
import { FileSpace } from '../storage/file-space'
import { setVersionPermission } from '../storage/space-versions'
import { app, ipcMain } from 'electron'
import { join } from 'node:path'
import { ALL_PLUGINS, APPLICATION_PLUGINS } from '../plugins/manifest'
import { entries } from '../plugins/generated/application-service'
import { executables } from '../plugins/generated/executables'
import { catalogEntries } from '../shared/plugin-catalog'
import type { ApplicationServiceContext } from '../plugin-api/service'
import { ApplicationAccess, type ApplicationLibrary } from './application-access'
import { ServiceRuntime } from './service-runtime'
import { callCore } from './core-client'
import { openLibraries, openLibrary, type OpenLibrary } from './libraries'
import { classifyFolder } from './folders'
import { trustedWindow } from './trusted-window'
import { localPackages, localSuites } from './plugin-packages'
import { PresetCatalog } from '../plugin-packages/preset-catalog'
import { applicationCreations, registerCreationAuthority } from './library-creation'
import { ecosystemEntries } from './ecosystem-catalog'
import { libraryStatus } from './library-status'
import { workbenchSession } from './workbench-control'
import { createDevelopmentAccess } from './development-access'

let runtime: ServiceRuntime<ApplicationServiceContext> | undefined
const accesses = new Map<string, ApplicationAccess>()
const target = (lib: OpenLibrary): ApplicationLibrary => {
  const core = lib.core
  return { id: lib.id, root: lib.root, status: sections => libraryStatus(lib, sections), session: (request, guard) => workbenchSession(lib, request, guard), call: (method, ...args) => runtime!.track(callCore(core, method, ...args)),
    active: () => !lib.win.isDestroyed() && !lib.reloading && !lib.closing && lib.core === core && core.pid !== undefined }
}
export async function startApplicationServices() {
  // 随附包接续属于应用启动，目录查询本身不安装或授权。
  // 目录损坏不能阻止应用启动、关闭 MCP 或查看已有授权；保留原文件供修复。
  let packages: ReturnType<typeof localPackages> | undefined
  try { packages = localPackages() }
  catch (error) { console.error('[application-catalog] 插件目录初始化失败', error) }
  const presets = new PresetCatalog(app.getPath('userData'), localSuites())
  const suites = localSuites()
  runtime = new ServiceRuntime<ApplicationServiceContext>(catalogEntries(APPLICATION_PLUGINS, 'service', entries), (id, scope) => {
    const access = new ApplicationAccess({ management: packages ? createApplicationManagement(id) : undefined, creations: applicationCreations, userData: app.getPath('userData'), namespace: id,
      development: createDevelopmentAccess(join(app.getPath('userData'), id, 'development-tasks'), task => { void scope.track(task).catch(() => {}) }),
      directories: applicationDirectories, trackCheck: work => { void scope.track(work) },
      sourceChecked: (id, directory) => directory ? notifyDirectoryCatalog(id, true) : refreshSpaceWindows(id),
      catalog: root => {
        if (!packages) throw new Error('[CATALOG_UNAVAILABLE] 插件目录初始化失败，请在应用中检查插件包并修复后重启')
        return ecosystemEntries(ALL_PLUGINS, packages, presets.list(), suites.list(), root)
      },
      active: () => !scope.signal.aborted,
      setSpacePermission: async (root, libraryId, input) => {
        const space = new FileSpace(root)
        try {
          if (space.id !== input.spaceId) throw new Error('[FILE_SPACE_IDENTITY] 空间身份已变化')
          const result = setVersionPermission(space, libraryId, input.permission, input.enabled, input.revision)
          await refreshSpaceWindows(space.id)
          return result
        } finally { space.close() }
      },
      libraries: () => openLibraries().map(target),
      open: async (root, expectedId, background = true) => {
        // 路由现有授权仓库；首次创建另走共用创建服务及其固定初始化配置。
        const folder = classifyFolder(root)
        if (folder !== 'library' && folder !== 'empty') throw new Error('[LIBRARY_OFFLINE] 仓库目录已移动或不是仓库')
        return target(await openLibrary(root, { show: !background, background, expectedId }))
      }
    })
    const revokeCreation = registerCreationAuthority(id, job => access.authorizeCreation(job))
    accesses.set(id, access)
    scope.signal.addEventListener('abort', () => { revokeCreation(); accesses.delete(id) }, { once: true })
    return { access: {
      directorySources: id => scope.track(access.directorySources(id)),
      checkSource: (id, input) => scope.track(access.checkSource(id, input)),
      setSpacePermission: input => scope.track(access.setSpacePermission(input)),
      configFile: access.configFile,
      publishEndpoint: endpoint => access.publishEndpoint(endpoint), settings: input => access.settings(input),
      developmentSources: key => scope.track(access.developmentSources(key)), setDevelopmentGrant: input => scope.track(access.setDevelopmentGrant(input)),
      development: (action, input) => scope.track(access.development(action, input)),
      authorize: input => access.authorize(input), list: () => access.list(),
      status: input => scope.track(access.status(input)), processing: (id, input) => scope.track(access.processing(id, input)),
      workbench: (id, request) => scope.track(access.workbench(id, request)),
      importFiles: (id, input) => scope.track(access.importFiles(id, input)),
      catalog: input => scope.track(access.catalog(input)),
      previewCreation: input => access.previewCreation(input),
      localManagement: input => access.localManagement(input),
      manage: (action, input) => scope.track(access.manage(action, input)),
      creationStatus: id => scope.track(access.creationStatus(id)), resumeCreation: id => scope.track(access.resumeCreation(id)), cancelCreation: id => scope.track(access.cancelCreation(id)),
      open: (id, background) => scope.track(access.open(id, background)), create: input => scope.track(access.create(input)),
      call: (id, method, ...args) => scope.track(access.call(id, method, ...args))
    }, executable(name) {
      if (!executables.some(e => e.id === id && e.name === name)) throw new Error('未声明的独立入口')
      return { command: process.execPath, args: [join(__dirname, `${name}.js`)], env: { ELECTRON_RUN_AS_NODE: '1' } }
    } }
  })
  await runtime.start(new Set(APPLICATION_PLUGINS.map(p => p.id)))
}
export async function registerApplicationLibrary(lib: OpenLibrary) {
  for (const access of accesses.values()) access.register(lib)
}
export const invokeApplicationService = (plugin: string, method: string, input?: unknown) => {
  if (!runtime) throw new Error('应用服务尚未启动')
  return runtime.invoke(plugin, method, input)
}
export const stopApplicationServices = () => runtime?.stop() ?? Promise.resolve()
export function registerApplicationServiceIpc() {
  ipcMain.handle('application:service', (event, plugin: unknown, method: unknown, input: unknown) => {
    trustedWindow(event)
    if (typeof plugin !== 'string' || typeof method !== 'string') throw new Error('无效服务调用')
    return invokeApplicationService(plugin, method, input)
  })
}
