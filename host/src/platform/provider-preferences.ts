import { createHash } from 'node:crypto'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { capabilityId } from '../shared/capability-declarations'

const providerId = z.string().regex(/^[a-z][a-z0-9-]{0,79}$/)
const preferences = (library?: string) => z.record(capabilityId, library ? z.union([providerId, z.literal('@auto')]) : providerId)
const location = (home: string, library?: string) => join(home, library
  ? 'capability-providers-' + createHash('sha256').update(library).digest('hex') + '.json' : 'capability-providers.json')
export function readProviders(home: string, library?: string): Record<string, string> {
  const file = location(home, library)
  return existsSync(file) ? preferences(library).parse(JSON.parse(readFileSync(file, 'utf8'))) : {}
}
export function setProvider(home: string, capability: string, provider: string | null, library?: string) {
  const next = readProviders(home, library)
  capabilityId.parse(capability)
  if (provider === null) delete next[capability]
  else next[capability] = provider
  const file = location(home, library)
  writeFileSync(file + '.tmp', JSON.stringify(preferences(library).parse(next)), { mode: 0o600 })
  renameSync(file + '.tmp', file)
}
export function providerConfiguration(home: string, library: string) {
  try {
    const values = readProviders(home)
    for (const [id, value] of Object.entries(readProviders(home, library))) {
      if (value === '@auto') delete values[id]
      else values[id] = value
    }
    return { preferences: values }
  }
  catch (error) {
    console.error('[providers] 无法读取引擎选择', error)
    return { problem: '本机引擎配置无法读取' }
  }
}
