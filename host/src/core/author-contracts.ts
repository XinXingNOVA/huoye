import { z } from 'zod'
import type { AuthorContract } from '../shared/capability-declarations'
import { mediaContracts } from '../shared/media-capabilities'

const text = z.string().max(32_768)
const types = { text, number: z.number(), boolean: z.boolean(), 'text[]': z.array(text).max(256), 'number[]': z.array(z.number()).max(4096) }
function fields(def: AuthorContract['input']) {
  return z.object(Object.fromEntries(Object.entries(def).map(([k, t]) => {
    if (typeof t === 'string') return [k, types[t]]
    const schema = t.type === 'records' ? z.array(z.object(Object.fromEntries(
      Object.entries(t.fields).map(([name, type]) => [name, types[type]]))).strict()).max(4096) : types[t.type]
    return [k, t.optional ? schema.optional() : schema]
  }))).strict()
}
export function authorSchemas(def: AuthorContract) {
  const params = fields(def.input)
  return { input: def.source === 'file' ? mediaContracts['media.inspect@1'].input.extend({ params }) : z.object({ params }).strict(),
    output: fields(def.output), file: def.source === 'file' }
}
