import { ipcMain, shell } from 'electron'
import { ItemDisposal } from '../application/item-disposal'
import { libraryOf, type OpenLibrary } from './libraries'
import { callCore } from './core-client'
import type { ItemDisposalExecution, ItemDisposalSelection } from '../shared/item-disposal'

/** 仅绑定当前窗口的仓库；应用级物理处置不走仓库 MCP organize/recycle 授权。 */
export function registerItemDisposalIpc(changed: (spaceId: string, fileIds?: string[]) => Promise<void>) {
  const services = new WeakMap<OpenLibrary, ItemDisposal>()
  const get = (event: Electron.IpcMainInvokeEvent) => {
    const lib = libraryOf(event.sender)
    if (!lib) throw new Error('[NO_LIBRARY] 请先打开仓库')
    if (lib.reloading) throw new Error('[LIBRARY_RELOADING] 仓库正在重新加载')
    let service = services.get(lib)
    if (!service) {
      service = new ItemDisposal(lib.root, lib.id, {
        snapshot: ids => callCore(lib.core, 'itemDisposalSnapshot', ids),
        bindings: () => callCore(lib.core, 'listFileSpaces'),
        receipt: input => callCore(lib.core, 'itemLifecycleReceipt', input),
        trash: input => callCore(lib.core, 'applyItemLifecycle', input), changed
      }, { trashDirectory: path => shell.trashItem(path) })
      services.set(lib, service)
    }
    return service
  }
  ipcMain.handle('item-disposal:preview', (e, selection: ItemDisposalSelection) => get(e).preview(selection))
  ipcMain.handle('item-disposal:execute', (e, input: ItemDisposalExecution) => get(e).execute(input))
  ipcMain.handle('item-disposal:list', e => get(e).list())
}
