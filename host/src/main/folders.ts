// 仓库就是一个文件夹（设计文档 13.5）。判断一个文件夹能不能当仓库打开、能不能在里面新建仓库。

import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * library：已经是仓库（有 library.db）；
 * empty：不存在或是空文件夹，可以在这里新建仓库；
 * other：里面有别的东西。仓库是托管的（文件收进库里、按身份存放），不把已有的文件夹原地变成仓库。
 * file：不是文件夹。
 */
export type FolderKind = 'library' | 'empty' | 'other' | 'file'

export function classifyFolder(dir: string): FolderKind {
  if (!existsSync(dir)) return 'empty'
  if (!statSync(dir).isDirectory()) return 'file'
  if (existsSync(join(dir, 'library.db'))) return 'library'
  // 访达留下的 .DS_Store 这类隐藏文件不算
  return readdirSync(dir).some((name) => name !== '.DS_Store') ? 'other' : 'empty'
}
