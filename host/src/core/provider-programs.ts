import { accessSync, constants, realpathSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { InstalledPackage } from '../shared/external-plugins'
import { runtimePath } from '../shared/provider-runtimes'
import { findProgram } from '../platform/programs'

export function providerRuntime(pack: InstalledPackage, id: string, dirs: string[], shared?: import('../shared/shared-runtimes').SharedPrograms) {
  const caps = pack.manifest.capabilities
  const spec = caps?.implementations?.find(p => p.id === id)
  const programs = new Map<string, string>()
  const versions: string[] = []
  const legacyVersions: (string | [string, number, number])[] = []
  const target = process.platform + '-' + process.arch
  let problem: string | undefined
  if (spec?.platforms && !spec.platforms.some(p => p === process.platform)) problem = '引擎不支持当前系统'
  for (const name of spec?.programs ?? []) {
    if (spec?.via === 'service') {
      const program = shared && Object.hasOwn(shared, name) ? shared[name] : undefined
      if (!program || program.problem) problem ??= program?.problem ?? '未启用共享程序 ' + name
      else { programs.set(name, program.path); versions.push(name) }
      continue
    }
    const bundled = caps?.runtimes?.find(r => r.program === name)
    if (bundled) {
      const match = bundled.targets.find(t => t === target)
      if (!match) {
        problem ??= '引擎包没有适用于当前系统和架构的程序'
        continue
      }
      const relative = runtimePath(name, match)
      try {
        const path = join(pack.directory, relative)
        if (realpathSync(path) !== path || !statSync(path).isFile()) throw Error()
        accessSync(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
        programs.set(name, path)
        legacyVersions.push(relative)
        versions.push(relative) // 包摘要已包含程序字节，重装位置和时间不影响加工指纹。
      } catch { problem ??= '随包程序不可用，请检查引擎安装' }
      continue
    }
    const managed = shared && Object.hasOwn(shared, name) ? shared[name] : undefined
    if (managed) {
      if (managed.problem) { problem ??= managed.problem; continue }
      programs.set(name, managed.path)
      versions.push(name)
      legacyVersions.push(managed.digest) // 只用于识别旧版已经写入的加工记录。
      continue
    }
    const path = findProgram(name, dirs)
    if (path) {
      try {
        const stat = statSync(path)
        programs.set(name, path)
        legacyVersions.push([path, stat.size, stat.mtimeMs])
        versions.push(name)
        continue
      } catch { /* 引擎可能正被卸载。 */ }
    }
    problem ??= '找不到 ' + name
  }
  return { pack, programs, versions, legacyVersions, problem, workload: spec?.workload, automatic: spec?.execution === 'local' }
}
