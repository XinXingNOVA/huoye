// 最近打开的仓库：存在应用本地（不在任何一个仓库里），像 Obsidian 的仓库列表。
// 还记着退出时开着哪些仓库，下次启动重新打开它们。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { app } from 'electron'
import { classifyFolder } from './folders'

export interface VaultEntry {
  path: string
  name: string
  openedAt: number
}

interface VaultState {
  recent: VaultEntry[]
  /** 退出时开着的仓库。 */
  open: string[]
  background?: string[]
}

const MAX_RECENT = 20
const file = () => join(app.getPath('userData'), 'vaults.json')

let state: VaultState | undefined
const listeners = new Set<() => void>()

function load(): VaultState {
  if (state) return state
  try {
    const data = JSON.parse(readFileSync(file(), 'utf8')) as Partial<VaultState>
    state = { recent: Array.isArray(data.recent) ? data.recent : [], open: Array.isArray(data.open) ? data.open : [], background: Array.isArray(data.background) ? data.background : [] }
  } catch {
    state = { recent: [], open: [] }
  }
  return state
}

function save(): void {
  mkdirSync(dirname(file()), { recursive: true })
  writeFileSync(file(), JSON.stringify(load(), null, 2))
  listeners.forEach((fn) => fn())
}

/** 最近的仓库变了（菜单里的"打开最近"要跟着变）。 */
export function onVaultsChanged(fn: () => void): void {
  listeners.add(fn)
}

export function rememberOpened(path: string): void {
  const s = load()
  s.recent = [{ path, name: basename(path), openedAt: Date.now() }, ...s.recent.filter((v) => v.path !== path)].slice(0, MAX_RECENT)
  save()
}

export function forget(path: string): void {
  const s = load()
  s.recent = s.recent.filter((v) => v.path !== path)
  s.open = s.open.filter((p) => p !== path)
  save()
}

export function setOpenAtQuit(paths: string[], background: string[] = []): void {
  load().open = paths
  load().background = background.filter(p => paths.includes(p))
  save()
}

/** 最近的仓库，标出还在不在（被移走、删掉的显示"找不到"）。 */
export function recentVaults(): (VaultEntry & { exists: boolean })[] {
  return load().recent.map((v) => ({ ...v, exists: existsSync(v.path) && classifyFolder(v.path) === 'library' }))
}

/** 启动时要打开的仓库：上次退出时开着、现在还在的。 */
export function vaultsToReopen(): string[] {
  return load().open.filter((p) => classifyFolder(p) === 'library')
}

export const reopenInBackground = (root: string): boolean => load().background?.includes(root) ?? false
