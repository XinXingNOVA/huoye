import Database from 'better-sqlite3'
import { basename, join, resolve } from 'node:path'
import { statSync } from 'node:fs'
import { app } from 'electron'
import { APPLICATION_PLUGINS } from '../plugins/manifest'
import { bindingSchema } from '../shared/external-plugins'
import { comparePackageVersions, groupPackages, type PackageInventory } from '../shared/package-catalog'
import { packageTaskReferences } from '../plugin-packages/task-references'
import { localPackages } from './plugin-packages'
import { recentVaults } from './vaults'
import { openLibraries } from './libraries'

export function knownPackageRoots() {
  return [...new Set([...localPackages().knownRoots(), ...recentVaults().map(v => v.path), ...openLibraries().map(l => l.root)].map(p => resolve(p)))].sort()
}
export function readPackageBindings(root: string) {
  const db = new Database(join(root, 'library.db'), { readonly: true, fileMustExist: true })
  try {
    const id = db.prepare("SELECT value FROM meta WHERE key='library_id'").pluck().get() as string
    if (!id) throw new Error('没有仓库身份')
    const raw = db.prepare("SELECT value FROM config WHERE key='externalPlugins'").pluck().get() as string | undefined
    return { id, bindings: bindingSchema.array().parse(raw ? JSON.parse(raw) : []) }
  } finally { db.close() }
}

export function packageInventory(): PackageInventory {
  const manager = localPackages(), result: PackageInventory = { versions: {}, unchecked: [] }
  const defaults = new Set(manager.bundled().map(row => row.hash))
  const tasks = packageTaskReferences(app.getPath('userData'), APPLICATION_PLUGINS.map(p => p.id))
  for (const versions of groupPackages(manager.list()).values()) {
    let replacement: typeof versions[number] | undefined
    for (const row of versions) {
      const archive = statSync(join(manager.directory(row.hash), 'package.rmplugin'), { throwIfNoEntry: false })
      if (!replacement && archive?.isFile()) replacement = row
      const newer = replacement && comparePackageVersions(replacement.manifest.version, row.manifest.version) > 0 ? replacement : undefined
      result.versions[row.hash] = { libraries: [], tasks: [...tasks.get(row.hash) ?? []], bundledDefault: defaults.has(row.hash),
        bytes: archive?.isFile() ? archive.size : undefined, newer: newer?.manifest.version, replacementHash: newer?.hash }
    }
  }
  const opened = new Map(openLibraries().map(lib => [resolve(lib.root), lib]))
  for (const root of knownPackageRoots()) {
    const lib = opened.get(root)
    try {
      const { bindings } = readPackageBindings(root)
      const uses = new Map(bindings.map(b => [b.hash, b.enabled]))
      for (const hash of lib?.packageResources ?? []) if (!uses.has(hash)) uses.set(hash, false)
      for (const [hash, enabled] of uses) result.versions[hash]?.libraries.push({ root, name: lib?.name ?? basename(root), enabled, running: !!lib?.packageResources.has(hash) })
    } catch { result.unchecked.push(root) }
  }
  return result
}
