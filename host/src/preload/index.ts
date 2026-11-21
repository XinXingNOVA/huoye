/// <reference lib="dom" />
import { contextBridge, ipcRenderer, webUtils } from 'electron'

contextBridge.exposeInMainWorld('bridge', {
  platform: process.platform,
  language: {
    get: () => ipcRenderer.invoke('language:get'),
    set: value => ipcRenderer.invoke('language:set', value),
    onChanged: fn => {
      const listener = (_event: Electron.IpcRendererEvent, state: import('../shared/i18n').LanguageSnapshot) => fn(state)
      ipcRenderer.on('language:changed', listener)
      return () => { ipcRenderer.off('language:changed', listener) }
    }
  } satisfies import('../shared/i18n').LanguageBridge,
  appearance: {
    load: legacy => ipcRenderer.invoke('appearance:load', legacy),
    change: (scope, action) => ipcRenderer.invoke('appearance:change', scope, action),
    setDecorationImage: (slot, bytes) => ipcRenderer.invoke('appearance:decoration-image', slot, bytes),
    install: (name, bytes) => ipcRenderer.invoke('appearance:install', name, bytes),
    remove: id => ipcRenderer.invoke('appearance:remove', id),
    onChanged: fn => {
      const listener = () => fn()
      ipcRenderer.on('appearance:changed', listener)
      return () => { ipcRenderer.off('appearance:changed', listener) }
    }
  } satisfies import('../shared/appearance').AppearanceBridge,
  workbenchControl: {
    onRequest: (handler: (input: import('../shared/workbench-control').WorkbenchRequest, authorize: () => Promise<void>) => Promise<unknown>) => {
      const listener = (_: Electron.IpcRendererEvent, id: string, input: import('../shared/workbench-control').WorkbenchRequest) => {
        void Promise.resolve().then(() => handler(input, () => ipcRenderer.invoke('workbench:authorize', id))).then(
          value => ipcRenderer.send('workbench:result', id, value), error => ipcRenderer.send('workbench:result', id, undefined, String(error)))
      }
      ipcRenderer.on('workbench:request', listener)
      return () => ipcRenderer.removeListener('workbench:request', listener)
    }
  },
  auxiliary: {
    prepare: (kind: import('../shared/auxiliary-windows').AuxiliaryKind, bounds?: Partial<import('../shared/auxiliary-windows').WindowBounds>) => ipcRenderer.invoke('auxiliary:prepare', kind, bounds),
    show: (kind: import('../shared/auxiliary-windows').AuxiliaryKind) => ipcRenderer.invoke('auxiliary:show', kind),
    focus: (kind: import('../shared/auxiliary-windows').AuxiliaryKind) => ipcRenderer.invoke('auxiliary:focus', kind),
    close: (kind: import('../shared/auxiliary-windows').AuxiliaryKind) => ipcRenderer.invoke('auxiliary:close', kind),
    onDragCancel: (listener: () => void) => {
      const handle = () => listener()
      ipcRenderer.on('auxiliary:drag-cancel', handle)
      return () => ipcRenderer.removeListener('auxiliary:drag-cancel', handle)
    },
    onEvent: (listener: (event: import('../shared/auxiliary-windows').AuxiliaryEvent) => void) => {
      const handle = (_: Electron.IpcRendererEvent, event: import('../shared/auxiliary-windows').AuxiliaryEvent) => listener(event)
      ipcRenderer.on('auxiliary:event', handle)
      return () => ipcRenderer.removeListener('auxiliary:event', handle)
    }
  },
  lifecycle: {
    onPrepare: (handler: (reason: 'shutdown' | 'reload', recovery: boolean) => Promise<void>, resume: () => void) => {
      const listener = (_event: Electron.IpcRendererEvent, request: { id: string; reason: 'shutdown' | 'reload'; recovery?: boolean }) => {
        void Promise.resolve().then(() => handler(request.reason, request.recovery === true)).then(
          () => ipcRenderer.send('page:prepared', { id: request.id }),
          error => ipcRenderer.send('page:prepared', { id: request.id, error: String(error) })
        )
      }
      ipcRenderer.on('page:prepare', listener)
      ipcRenderer.on('page:resume', resume)
      ipcRenderer.send('page:ready', true)
      return () => {
        ipcRenderer.removeListener('page:prepare', listener)
        ipcRenderer.removeListener('page:resume', resume)
        ipcRenderer.send('page:ready', false)
      }
    },
    reload: () => ipcRenderer.invoke('page:reload')
  },
  itemDisposal: {
    preview: (selection: import('../shared/item-disposal').ItemDisposalSelection) => ipcRenderer.invoke('item-disposal:preview', selection),
    execute: (input: import('../shared/item-disposal').ItemDisposalExecution) => ipcRenderer.invoke('item-disposal:execute', input),
    list: () => ipcRenderer.invoke('item-disposal:list')
  },
  spaces: {
    directories: {
      onChanged: listener => {
        const fn = (_event: Electron.IpcRendererEvent, id: string, entriesChanged: boolean) => listener(id, entriesChanged)
        ipcRenderer.on('directory-catalog:changed', fn)
        return () => { ipcRenderer.off('directory-catalog:changed', fn) }
      },
      maintenance: {
        list: () => ipcRenderer.invoke('directory-catalog:list'),
        forget: id => ipcRenderer.invoke('directory-catalog:forget', id),
        removeMember: (id, member) => ipcRenderer.invoke('directory-catalog:remove-member', id, member),
        previewMissing: (id, days) => ipcRenderer.invoke('directory-catalog:preview-missing', id, days),
        cleanMissing: (id, cutoff, token) => ipcRenderer.invoke('directory-catalog:clean-missing', id, cutoff, token)
      },
      refreshTree: (id, retryOnly) => ipcRenderer.invoke('directory-spaces:refresh-tree', id, retryOnly),
      relocate: id => ipcRenderer.invoke('directory-spaces:relocate', id),
      stopTree: id => ipcRenderer.invoke('directory-spaces:stop-tree', id),
      missing: (id, offset) => ipcRenderer.invoke('directory-spaces:missing', id, offset),
      verify: (id, file, stamp) => ipcRenderer.invoke('directory-spaces:verify', id, file, stamp),
      list: () => ipcRenderer.invoke('directory-spaces:list'),
      connections: () => ipcRenderer.invoke('directory-spaces:connections'),
      pick: expected => ipcRenderer.invoke('directory-spaces:pick', expected),
      unlink: (id, expected) => ipcRenderer.invoke('directory-spaces:unlink', id, expected),
      page: (id, folder, offset, refresh) => ipcRenderer.invoke('directory-spaces:page', id, folder, offset, refresh),
      preview: (id, file, stamp) => ipcRenderer.invoke('directory-spaces:preview', id, file, stamp)
    } satisfies import('../shared/directory-spaces').DirectorySpaceBridge,
    disk: {
      check: (root: string, input: import('../shared/space-disk').DiskCheckInput) => ipcRenderer.invoke('spaces:disk-check', root, input),
      page: (root: string, input: import('../shared/space-disk').DiskPageInput) => ipcRenderer.invoke('spaces:disk-page', root, input),
      preview: (root: string, input: import('../shared/space-disk').DiskPreviewInput) => ipcRenderer.invoke('spaces:disk-preview', root, input),
      apply: (root: string, input: import('../shared/space-disk').DiskApplyInput) => ipcRenderer.invoke('spaces:disk-apply', root, input),
      resume: (root: string, spaceId: string, requestId: string) => ipcRenderer.invoke('spaces:disk-resume', root, spaceId, requestId),
      abandon: (root: string, spaceId: string, requestId: string) => ipcRenderer.invoke('spaces:disk-abandon', root, spaceId, requestId),
      cancel: (requestId: string) => ipcRenderer.invoke('spaces:disk-cancel', requestId),
      onProgress: (cb: (progress: import('../shared/space-disk').DiskProgress) => void) => {
        const listener = (_e: Electron.IpcRendererEvent, progress: import('../shared/space-disk').DiskProgress) => cb(progress)
        ipcRenderer.on('spaces:disk-progress', listener)
        return () => ipcRenderer.removeListener('spaces:disk-progress', listener)
      }
    },
    disposal: {
      preview: (root: string, input: import('../shared/space-disposal').DisposalSelection) => ipcRenderer.invoke('spaces:disposal-preview', root, input),
      execute: (root: string, input: import('../shared/space-disposal').DisposalInput) => ipcRenderer.invoke('spaces:disposal-execute', root, input),
      pending: (root: string, spaceId: string) => ipcRenderer.invoke('spaces:disposal-pending', root, spaceId),
      resume: (root: string, spaceId: string, requestId: string) => ipcRenderer.invoke('spaces:disposal-resume', root, spaceId, requestId)
    },
    cancelOperation: (requestId: string) => ipcRenderer.invoke('spaces:cancel-operation', requestId),
    history: (root: string, input: import('../shared/space-versions').SpaceHistoryInput) => ipcRenderer.invoke('spaces:history', root, input),
    restoreVersion: (root: string, input: import('../shared/space-versions').RestoreVersionInput) => ipcRenderer.invoke('spaces:restore-version', root, input),
    setVersionPermission: (root: string, spaceId: string, libraryId: string, permission: 'revise' | 'recycle', enabled: boolean, revision: number) => ipcRenderer.invoke('spaces:set-version-permission', root, spaceId, libraryId, permission, enabled, revision),
    versionPermissions: (root: string, spaceId: string) => ipcRenderer.invoke('spaces:version-permissions', root, spaceId),
    versionReadiness: (root: string, spaceId: string) => ipcRenderer.invoke('spaces:version-readiness', root, spaceId),
    files: (root: string, input: import('../shared/file-spaces').SpacePageInput) => ipcRenderer.invoke('spaces:files', root, input),
    preview: (root: string, input: import('../shared/file-spaces').SpaceMutationPreviewInput) => ipcRenderer.invoke('spaces:preview', root, input),
    mutate: (root: string, input: import('../shared/file-spaces').SpaceMutationInput) => ipcRenderer.invoke('spaces:mutate', root, input),
    list: () => ipcRenderer.invoke('spaces:list'),
    pick: () => ipcRenderer.invoke('spaces:pick'),
    create: (parent: string, name: string, mode: string) => ipcRenderer.invoke('spaces:create', parent, name, mode),
    mode: (root: string, mode: string, revision: number) => ipcRenderer.invoke('spaces:mode', root, mode, revision),
    add: (root: string, paths: string[]) => ipcRenderer.invoke('spaces:add', root, paths)
  },
  pluginPresets: {
    list: () => ipcRenderer.invoke('plugin-presets:list'),
    current: () => ipcRenderer.invoke('plugin-presets:current'),
    save: (title: string, selection?: import('../shared/plugin-presets').PluginSelection, options?: import('../shared/plugin-presets').PluginPresetOptions) => ipcRenderer.invoke('plugin-presets:save', title, selection, options),
    copy: (id: string, title: string) => ipcRenderer.invoke('plugin-presets:copy', id, title),
    pending: () => ipcRenderer.invoke('plugin-presets:pending'),
    retryPending: (id: string) => ipcRenderer.invoke('plugin-presets:retry-pending', id),
    finish: (id: string) => ipcRenderer.invoke('plugin-presets:finish', id),
    cancelPending: (id: string) => ipcRenderer.invoke('plugin-presets:cancel-pending', id),
    rename: (id: string, revision: string, title: string) => ipcRenderer.invoke('plugin-presets:rename', id, revision, title),
    update: (id: string, revision: string, selection?: import('../shared/plugin-presets').PluginSelection, options?: import('../shared/plugin-presets').PluginPresetOptions) => ipcRenderer.invoke('plugin-presets:update', id, revision, selection, options),
    remove: (id: string, revision: string) => ipcRenderer.invoke('plugin-presets:remove', id, revision),
    preview: (id: string, mode: import('../shared/plugin-presets').PluginPresetMode, base?: import('../shared/plugin-presets').PluginSelection, versions?: import('../shared/plugin-presets').PluginSelection['external']) => ipcRenderer.invoke('plugin-presets:preview', id, mode, base, versions),
    apply: (selection: import('../shared/plugin-presets').PluginSelection, revision: string, arrangement?: import('../shared/plugin-presets').PresetArrangement) => ipcRenderer.invoke('plugin-presets:apply', selection, revision, arrangement),
    onChanged: (listener: () => void) => {
      const handle = () => listener()
      ipcRenderer.on('plugin-presets:changed', handle)
      return () => { ipcRenderer.removeListener('plugin-presets:changed', handle) }
    }
  },
  packages: {
    developmentDirectory: () => ipcRenderer.invoke('packages:development-directory'),
    removeDevelopmentDirectory: (directory: string) => ipcRenderer.invoke('packages:remove-development-directory', directory),
    pickDevelopmentDirectory: () => ipcRenderer.invoke('packages:pick-development-directory'),
    pickDevelopmentToolchain: () => ipcRenderer.invoke('packages:pick-development-toolchain'),
    prepareDevelopmentSources: (sources: string[], retry?: boolean) => ipcRenderer.invoke('packages:prepare-development-sources', sources, retry),
    applyDevelopmentDirectory: (selection: import('../shared/external-plugins').DevelopmentSelection) => ipcRenderer.invoke('packages:apply-development-directory', selection),
    clearDevelopmentDirectory: () => ipcRenderer.invoke('packages:clear-development-directory'),
    installed: () => ipcRenderer.invoke('packages:installed'),
    suites: () => ipcRenderer.invoke('packages:suites'),
    removeSuite: (id: string, hash: string) => ipcRenderer.invoke('packages:remove-suite', id, hash),
    onChanged: (listener: () => void) => {
      const handle = () => listener()
      ipcRenderer.on('packages:changed', handle)
      return () => { ipcRenderer.removeListener('packages:changed', handle) }
    },
    list: () => ipcRenderer.invoke('packages:list'),
    pickUpdate: (hash: string) => ipcRenderer.invoke('packages:pick-update', hash),
    startUpdate: (token: string) => ipcRenderer.invoke('packages:start-update', token),
    pendingUpdate: () => ipcRenderer.invoke('packages:pending-update'),
    resumeUpdate: (token: string) => ipcRenderer.invoke('packages:resume-update', token),
    cancelUpdate: (token: string) => ipcRenderer.invoke('packages:cancel-update', token),
    pick: (suiteId?: string) => ipcRenderer.invoke('packages:pick', suiteId),
    install: (token: string, choices?: { index: number; hash: string | null }[]) => ipcRenderer.invoke('packages:install', token, choices),
    cancelInstall: (token: string) => ipcRenderer.invoke('packages:cancel-install', token),
    apply: (settings: import('../shared/external-plugins').PackageChanges) => ipcRenderer.invoke('packages:apply', settings),
    removal: (hash: string) => ipcRenderer.invoke('packages:removal', hash),
    uninstall: (hash: string) => ipcRenderer.invoke('packages:uninstall', hash),
    runtime: () => ipcRenderer.invoke('packages:runtime'),
    failed: (id: string, message: string) => ipcRenderer.invoke('packages:failed', id, message),
    ready: () => ipcRenderer.invoke('packages:ready')
  },
  pluginLocal: {
    list: scope => ipcRenderer.invoke('plugin-local:list', scope),
    preview: input => ipcRenderer.invoke('plugin-local:preview', input),
    clean: input => ipcRenderer.invoke('plugin-local:clean', input),
    retry: input => ipcRenderer.invoke('plugin-local:retry', input),
    state: (plugin, scope, action, key, value) => ipcRenderer.invoke('plugin-local:state', plugin, scope, action, key, value),
    onChanged: listener => { const fn = (_event: Electron.IpcRendererEvent, value: { pluginId: string; scope: import('../plugin-api/local-service').LocalScope; key?: string }) => listener(value); ipcRenderer.on('plugin-local:changed', fn); return () => ipcRenderer.off('plugin-local:changed', fn) }
  } satisfies import('../shared/plugin-local').LocalDataBridge,
  application: { service: (plugin: string, method: string, input?: unknown) => ipcRenderer.invoke('application:service', plugin, method, input) },
  services: {
    invoke: (plugin: string, method: string, input?: unknown) => ipcRenderer.invoke('services:invoke', plugin, method, input),
    stream: (id: string, plugin: string, method: string, input: unknown) => ipcRenderer.invoke('services:stream', id, plugin, method, input)
  },
  /** 请求连接核心进程；端口经 window message 'core:port' 送达。 */
  connectCore: () => ipcRenderer.send('core:connect'),
  pathForFile: (file: File) => webUtils.getPathForFile(file),
  startDrag: (files: string[], icon?: string) => ipcRenderer.send('drag:start', { files, icon }),
  reveal: (path: string) => ipcRenderer.invoke('shell:reveal', path),
  contextMenu: (items: unknown[]) => ipcRenderer.invoke('menu:context', items),
  openExternal: (url: string) => ipcRenderer.invoke('shell:open-external', url),
  clipboardSource: () => ipcRenderer.invoke('clipboard:source'),
  downloadImage: (url: string) => ipcRenderer.invoke('transfer:download-image', url),
  pickExportFolder: (defaultPath?: string) => ipcRenderer.invoke('dialog:exportFolder', defaultPath),
  downloadsPath: () => ipcRenderer.invoke('paths:downloads'),
  pickImport: () => ipcRenderer.invoke('dialog:import') as Promise<string[]>,
  loadWorkspace: (libraryId: string) => ipcRenderer.invoke('workspace:load', libraryId),
  saveWorkspace: (libraryId: string, data: unknown) => ipcRenderer.invoke('workspace:save', libraryId, data),
  /** 仓库：最近的、打开、新建、选择文件夹（仓库管理窗口用）。 */
  localEditors: {
    list: () => ipcRenderer.invoke('local-editors:list'),
    choose: () => ipcRenderer.invoke('local-editors:choose'),
    remove: (id: string) => ipcRenderer.invoke('local-editors:remove', id),
    onChanged: (listener: () => void) => {
      const handle = () => listener()
      ipcRenderer.on('local-editors:changed', handle)
      return () => ipcRenderer.removeListener('local-editors:changed', handle)
    }
  },
  fileEditing: {
    list: () => ipcRenderer.invoke('file-editing:list'),
    start: (input: { id: string; source?: string }) => ipcRenderer.invoke('file-editing:start', input),
    open: (id: string, options?: import('../shared/local-editors').OpenEditingOptions) => ipcRenderer.invoke('file-editing:open', id, options),
    editorOptions: (id: string) => ipcRenderer.invoke('file-editing:editorOptions', id),
    chooseEditor: () => ipcRenderer.invoke('file-editing:chooseEditor'),
    chooseReplacement: (id: string) => ipcRenderer.invoke('file-editing:chooseReplacement', id),
    reveal: (id: string) => ipcRenderer.invoke('file-editing:reveal', id),
    check: (input: { taskId: string; destination: import('../shared/file-editing').EditDestination }) => ipcRenderer.invoke('file-editing:check', input),
    commit: (id: string, token: string) => ipcRenderer.invoke('file-editing:commit', id, token),
    discardPrepared: (id: string) => ipcRenderer.invoke('file-editing:discardPrepared', id),
    inspectEnd: (id: string) => ipcRenderer.invoke('file-editing:inspectEnd', id),
    finish: (input: import('zod').infer<typeof import('../shared/file-editing').finishEditingSchema>) => ipcRenderer.invoke('file-editing:finish', input),
    discard: (id: string, token: string) => ipcRenderer.invoke('file-editing:discard', id, token),
    onChanged: (listener: () => void) => {
      const handle = () => listener()
      ipcRenderer.on('file-editing:changed', handle)
      return () => ipcRenderer.removeListener('file-editing:changed', handle)
    }
  },
  files: {
    openOriginal: (id: string) => ipcRenderer.invoke('files:open-original', id),
    openCopy: (id: string) => ipcRenderer.invoke('files:open-copy', id),
    identify: (paths: string[]): (string | null)[] => {
      const result = ipcRenderer.sendSync('files:identify', paths)
      if (result.error) throw new Error(result.error)
      return result.ids
    },
    resolve: (reference: string): string => {
      const result = ipcRenderer.sendSync('files:resolve', reference)
      if (result.error) throw new Error(result.error)
      return result.path
    }
  },
  creation: {
    preview: (input?: unknown, plugins?: unknown) => ipcRenderer.invoke('creation:preview', input, plugins),
    pickFolder: (purpose: 'open' | 'source') => ipcRenderer.invoke('creation:pick-folder', purpose),
    introduction: () => ipcRenderer.invoke('creation:introduction'),
    dismissIntroduction: (id: string) => ipcRenderer.invoke('creation:dismiss-introduction', id),
    create: (input: unknown, sourceToken?: string) => ipcRenderer.invoke('creation:create', input, sourceToken),
    pending: () => ipcRenderer.invoke('creation:pending'),
    resume: (id: string) => ipcRenderer.invoke('creation:resume', id),
    openBasic: (id: string) => ipcRenderer.invoke('creation:open-basic', id),
    dismiss: (id: string) => ipcRenderer.invoke('creation:dismiss', id)
  },
  vaults: {
    list: () => ipcRenderer.invoke('vaults:list'),
    open: (path: string) => ipcRenderer.invoke('vaults:open', path),
    create: (parent: string, name: string, spaceRoot?: string) => ipcRenderer.invoke('vaults:create', parent, name, spaceRoot),
    pick: (purpose: 'folder' | 'parent') => ipcRenderer.invoke('vaults:pick', purpose),
    forget: (path: string) => ipcRenderer.invoke('vaults:forget', path),
    reveal: (path: string) => ipcRenderer.invoke('vaults:reveal', path),
    show: () => ipcRenderer.invoke('vaults:show'),
    reload: () => ipcRenderer.invoke('vaults:reload')
  },
  /** 菜单命令（⌘T、⌘W、全选……） */
  onMenuCommand: (fn: (command: string) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, command: string) => fn(command)
    ipcRenderer.on('menu:command', listener)
    return () => ipcRenderer.removeListener('menu:command', listener)
  }
})

// MessagePort 不能经 contextBridge 传递，转交给页面
ipcRenderer.on('core:port', (e) => {
  window.postMessage('core:port', '*', e.ports)
})
ipcRenderer.on('core:offline', () => window.postMessage('core:offline', '*'))
ipcRenderer.on('services:port', (event, data) => {
  window.postMessage({ type: 'service:port', id: data.id }, '*', event.ports)
})
