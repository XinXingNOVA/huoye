/// <reference types="vite/client" />
export {}

declare global {
  interface VaultInfo {
    path: string
    name: string
    openedAt: number
    /** 文件夹还在、还是仓库。 */
    exists: boolean
    /** 已经开着（打开它只是切到它的窗口）。 */
    open: boolean
  }

  type VaultResult = import('../../shared/library-creation').VaultResult

  interface Window {
    bridge: {
      pluginLocal: import('../../shared/plugin-local').LocalDataBridge
      language: import('../../shared/i18n').LanguageBridge
      appearance: import('../../shared/appearance').AppearanceBridge
      platform: string
      auxiliary: import('../../shared/auxiliary-windows').AuxiliaryWindowBridge
      lifecycle: {
        onPrepare(handler: (reason: 'shutdown' | 'reload', recovery: boolean) => Promise<void>, resume: () => void): () => void
        reload(): Promise<void>
      }
      itemDisposal: import('../../shared/item-disposal').ItemDisposalBridge
      spaces: import('../../shared/file-spaces').SpaceBridge
      workbenchControl: { onRequest(handler: (input: import('../../shared/workbench-control').WorkbenchRequest, authorize: () => Promise<void>) => Promise<unknown>): () => void }
      pluginPresets: import('../../shared/plugin-presets').PluginPresetBridge
      packages: import('../../shared/external-plugins').PackageBridge
      application: { service(plugin: string, method: string, input?: unknown): Promise<unknown> }
      services: {
        invoke(plugin: string, method: string, input?: unknown): Promise<unknown>
        stream(id: string, plugin: string, method: string, input: unknown): Promise<void>
      }
      connectCore(): void
      pathForFile(file: File): string
      startDrag(files: string[], icon?: string): void
      reveal(path: string): Promise<void>
      /** 弹出系统的右键菜单，返回点了哪一项的 id；没点是 null。 */
      contextMenu(items: ({ type: 'separator' } | { id: string; label: string; accelerator?: string })[]): Promise<string | null>
      /** 用系统浏览器打开网页链接（只接受 http / https）。 */
      openExternal(url: string): Promise<void>
      /** 系统剪贴板里带着的网页地址（从浏览器复制时）。 */
      clipboardSource(): Promise<{ url: string } | null>
      downloadImage(url: string): Promise<{ input: Extract<import('../../shared/rpc').ImportInput, { type: 'bytes' }> } | { error: string }>
      /** 选一个导出到的文件夹；取消时 null。 */
      pickExportFolder(defaultPath?: string): Promise<string | null>
      downloadsPath(): Promise<string>
      localEditors: import('../../shared/local-editors').LocalEditorsBridge
      fileEditing: import('../../shared/file-editing').FileEditingBridge
      files: {
        openOriginal(id: string): Promise<void>
        openCopy(id: string): Promise<void>
        identify(paths: string[]): (string | null)[]
        resolve(reference: string): string
      }
      creation: import('../../shared/library-creation').CreationBridge
      vaults: {
        list(): Promise<{ recent: VaultInfo[]; defaultParent: string }>
        open(path: string): Promise<VaultResult>
        create(parent: string, name: string, spaceRoot?: string): Promise<VaultResult>
        pick(purpose: 'folder' | 'parent'): Promise<string | null>
        forget(path: string): Promise<void>
        reveal(path: string): Promise<void>
        /** 打开仓库管理窗口。 */
        show(): Promise<void>
        /** 重新加载这个仓库（插件设置改了之后）。 */
        reload(): Promise<void>
      }
      pickImport(): Promise<string[]>
      loadWorkspace(libraryId: string): Promise<unknown>
      saveWorkspace(libraryId: string, data: unknown): Promise<void>
      onMenuCommand(fn: (command: string) => void): () => void
    }
  }
}
