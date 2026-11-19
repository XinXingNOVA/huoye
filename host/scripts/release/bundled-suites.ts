// 官方套件的固定快照是普通构建的输入；自定义发行目录仍只信任其显式列出的包。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { decodeSuite } from '../../src/plugin-packages/suites'
import { decodePackage } from '../../src/plugin-packages/archive'
import { readBundledPackages } from '../../src/plugin-packages/bundled'
import type { SuiteRegistration } from '../../src/shared/plugin-suites'

const catalogSchema = z.array(z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,79}$/), sha256: z.string().regex(/^[a-f0-9]{64}$/)
}).strict()).max(100)

export function readReleaseBundle(directory: string, overrideDirectory?: string) {
  const catalog = catalogSchema.parse(JSON.parse(readFileSync(join(directory, 'catalog.json'), 'utf8')))
  const suites: SuiteRegistration[] = []
  const packages = new Map<string, { hash: string; bytes: Buffer }>()
  for (const entry of catalog) {
    const { manifest, hash, packages: files } = decodeSuite(readFileSync(join(directory, entry.id + '.hysuite')))
    if (manifest.id !== entry.id || hash !== entry.sha256 || suites.some(s => s.manifest.id === entry.id)) throw new Error(`发行套件重复或与锁定清单不符：${entry.id}`)
    suites.push({ manifest, hash })
    for (const ref of manifest.packages) {
      const previous = packages.get(ref.id)
      if (previous && previous.hash !== ref.hash) throw new Error(`发行套件使用了不同的插件包：${ref.id}`)
      packages.set(ref.id, { hash: ref.hash, bytes: files.get(ref.file)! })
    }
  }
  if (overrideDirectory) {
    packages.clear()
    for (const bytes of readBundledPackages(overrideDirectory)) {
      const { manifest, hash } = decodePackage(bytes)
      packages.set(manifest.id, { hash, bytes })
    }
  }
  return { packages, suites: suites.filter(s => s.manifest.packages.every(p => packages.get(p.id)?.hash === p.hash)) }
}
