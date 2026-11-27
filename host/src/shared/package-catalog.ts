import type { PackageRef } from './external-plugins'

/** Package manifests accept three unsigned decimal components, without prerelease suffixes. */
export function comparePackageVersions(a: string, b: string): number {
  const right = b.split('.')
  for (const [i, part] of a.split('.').entries()) {
    const diff = part.length - right[i].length || (part < right[i] ? -1 : part > right[i] ? 1 : 0)
    if (diff) return diff
  }
  return 0
}

export function groupPackages<T extends PackageRef>(rows: readonly T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>()
  for (const row of rows) {
    const group = groups.get(row.manifest.id)
    if (group) group.push(row)
    else groups.set(row.manifest.id, [row])
  }
  for (const group of groups.values()) group.sort((a, b) => comparePackageVersions(b.manifest.version, a.manifest.version) || a.hash.localeCompare(b.hash))
  return groups
}

export interface PackageUse { root: string; name: string; enabled: boolean; running: boolean }
export interface VersionUsage { libraries: PackageUse[]; tasks: string[]; bytes?: number; newer?: string; replacementHash?: string; bundledDefault: boolean }
export interface PackageInventory { versions: Record<string, VersionUsage>; unchecked: string[] }
export function canCleanVersion(inventory: PackageInventory, hash: string): boolean {
  const version = inventory.versions[hash]
  return !!version?.replacementHash && !version.bundledDefault &&
    !version.libraries.length && !version.tasks.length && !inventory.unchecked.length
}
