import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { existsSync, realpathSync, statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dialog, type IpcMainInvokeEvent } from 'electron'
import { classifyFolder } from './folders'
import { mainText } from './language'
import { trustedWindow } from './trusted-window'
import { launcherWindow } from './launcher'
import type { LauncherFolder, CreationSource } from '../shared/library-creation'

// 来源只接受这个启动窗口通过原生选择器选过的目录。取消表单不会登记空间。
const choices = new WeakMap<Electron.WebContents, Map<string, CreationSource>>()
export async function pickLauncherFolder(e: IpcMainInvokeEvent, purpose: 'open' | 'source'): Promise<LauncherFolder | null> {
  const win = trustedWindow(e)
  if (win !== launcherWindow()) throw Error('请在启动页选择目录')
  const picked = await dialog.showOpenDialog(win, { title: mainText(purpose === 'source' ? 'create.sourcePicker' : 'common.openLibrary'), properties: ['openDirectory'] })
  if (picked.canceled || !picked.filePaths[0] || win.isDestroyed()) return null
  const path = realpathSync(picked.filePaths[0]), kind = classifyFolder(path)
  if (kind === 'file') throw Error('请选择文件夹')
  const result = { path, name: basename(path), parent: dirname(path), kind }
  if (kind === 'library') return result
  const source = sourceIdentity(path)
  const tokens = choices.get(e.sender) ?? new Map<string, CreationSource>()
  const token = randomUUID()
  if (tokens.size >= 64) tokens.delete(tokens.keys().next().value!)
  tokens.set(token, source); choices.set(e.sender, tokens)
  return { ...result, token }
}

function sourceIdentity(path: string): CreationSource {
  const root = realpathSync(path), st = statSync(root, { bigint: true })
  if (!st.isDirectory() || existsSync(join(root, 'library.db')) || existsSync(join(root, '.file-space.db')))
    throw Error('所选位置是仓库或托管空间，请选择普通素材目录')
  return { root, device: String(st.dev), inode: String(st.ino) }
}

export function chosenSource(e: IpcMainInvokeEvent, token: string) {
  const source = choices.get(e.sender)?.get(token)
  if (!source) throw Error('请重新选择素材来源文件夹')
  return source
}

export function checkCreationSource(source: CreationSource, libraryRoot: string) {
  const current = sourceIdentity(source.root)
  if (source.root !== current.root || source.device !== current.device || source.inode !== current.inode)
    throw Error('素材来源目录已被替换，请恢复原目录或重新选择')
  const rel = relative(current.root, libraryRoot)
  if (!rel || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel)))
    throw Error('仓库保存位置位于素材来源中，请选择来源目录以外的保存位置')
}
