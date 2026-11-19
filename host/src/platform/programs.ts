import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'

/** 只运行真实程序文件；不经 shell，也不把空 PATH 项解释为当前仓库。 */
export function findProgram(name: string, dirs: string[], platform = process.platform): string | undefined {
  if (!/^[a-zA-Z0-9_-]+(?:\.exe)?$/.test(name)) return undefined
  const names = platform === 'win32' && !name.endsWith('.exe') ? [`${name}.exe`, name] : [name]
  for (const dir of dirs.filter(d => isAbsolute(d))) for (const file of names) {
    const path = join(dir, file)
    try {
      if (!statSync(path).isFile()) continue
      accessSync(path, platform === 'win32' ? constants.F_OK : constants.X_OK)
      return path
    } catch { /* 继续检查下一个程序位置。 */ }
  }
  return undefined
}

export function programDirectories(extra: string[] = []): string[] {
  return [...new Set([...extra, ...(process.env.PATH ?? '').split(delimiter),
    ...(process.platform === 'darwin' ? ['/opt/homebrew/bin', '/usr/local/bin'] : [])].filter(Boolean))]
}
