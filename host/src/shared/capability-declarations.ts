import { z } from 'zod'
import { runtimeTargets } from './provider-runtimes.ts'

export const capabilityId = z.string().max(120).regex(/^(?:[a-z][a-z0-9-]*\/)?[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+@[1-9][0-9]{0,5}$/)
const ids = z.array(capabilityId).min(1).max(32).refine(values => new Set(values).size === values.length, '能力 ID 不能重复')

const key = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,47}$/).refine(k => !(k in Object.prototype))
const scalar = z.enum(['text', 'number', 'boolean', 'text[]', 'number[]'])
const recordFields = z.record(key, scalar).refine(v => Object.keys(v).length <= 16)
const field = z.union([scalar, z.object({ type: scalar, optional: z.boolean().optional() }).strict(),
  z.object({ type: z.literal('records'), fields: recordFields, optional: z.boolean().optional() }).strict()])
const fields = z.record(key, field).refine(v => Object.keys(v).length <= 32)
const contract = z.object({
  id: capabilityId.refine(id => id.includes('/')), source: z.enum(['file', 'none']), input: fields, output: fields,
  artifact: z.enum(['png', 'jpeg', 'webp', 'image']).optional(), interactive: z.literal(true).optional()
}).strict()
export type AuthorContract = z.infer<typeof contract>

export const serviceProgramsSchema = z.array(z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/).refine(n => !(n in Object.prototype))).max(16).refine(v => new Set(v).size === v.length)
export const capabilityDeclarationsSchema = z.object({
  version: z.union([z.literal(1), z.literal(2)]),
  runtimes: z.array(z.object({
    program: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/).refine(n => !/^(con|prn|aux|nul|(?:com|lpt)[0-9])$/i.test(n)),
    targets: z.array(z.enum(runtimeTargets)).min(1).max(runtimeTargets.length).refine(values => new Set(values).size === values.length)
  }).strict()).min(1).max(16).optional(),
  implementations: z.array(z.object({
    id: capabilityId, execution: z.literal('local'), via: z.literal('service').optional(), workload: z.enum(['light', 'heavy']).optional(),
    programs: z.array(z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/)).max(8).optional(),
    platforms: z.array(z.enum(['darwin', 'win32', 'linux'])).min(1).max(3).optional()
  }).strict()).max(32).optional(),
  contracts: z.array(contract).max(32).optional(),
  provides: ids.optional(),
  optionalConsumes: ids.optional(),
  consumes: ids.optional()
}).strict().refine(value => value.provides || value.consumes || value.optionalConsumes, '需要声明提供或消费的能力')
.superRefine((value, ctx) => {
  const declared = new Set([...(value.provides ?? []), ...(value.consumes ?? []), ...(value.optionalConsumes ?? [])])
  if (value.optionalConsumes && (value.version !== 2 || value.optionalConsumes.some(id => value.consumes?.includes(id)))) ctx.addIssue({ code: 'custom', message: '可选消费需要 v2，且不能重复声明为必需' })
  const seen = new Set<string>()
  const implementations = new Set<string>()
  for (const spec of value.implementations ?? []) {
    if (value.version !== 2 || implementations.has(spec.id) || !value.provides?.includes(spec.id)) {
      ctx.addIssue({ code: 'custom', message: '实现说明需要 v2、唯一 ID 及对应的 provides' })
    }
    if (spec.via === 'service' && !value.contracts?.some(c => c.id === spec.id && c.source === 'none' && !c.artifact)) ctx.addIssue({ code: 'custom', message: '常驻计算需要无文件输入输出的自定义契约' })
    if (spec.workload === 'light' && (spec.programs?.length || value.contracts?.some(c => c.id === spec.id && c.artifact))) {
      ctx.addIssue({ code: 'custom', message: '原生程序和文件输出须使用重任务队列' })
    }
    implementations.add(spec.id)
  }
  const programs = new Set(value.implementations?.flatMap(spec => spec.programs ?? []))
  const bundled = new Set<string>()
  for (const { program } of value.runtimes ?? []) {
    const key = program.toLowerCase()
    if (value.version !== 2 || !programs.has(program) || bundled.has(key) ||
        [...programs].some(other => other !== program && other.toLowerCase() === key)) {
      ctx.addIssue({ code: 'custom', message: '随包程序需要 v2、唯一名称及对应的本地实现依赖' })
    }
    bundled.add(key)
  }
  for (const c of value.contracts ?? []) {
    if (value.version === 1 && [...Object.values(c.input), ...Object.values(c.output)].some(f => typeof f !== 'string')) {
      ctx.addIssue({ code: 'custom', message: '结构化字段需要能力清单 v2' })
    }
    if (c.interactive && (!c.artifact || c.source !== 'file')) ctx.addIssue({ code: 'custom', message: '交互读取需要原件和图像输出' })
    if (c.artifact && (value.version !== 2 || Object.keys(c.output).length)) ctx.addIssue({ code: 'custom', message: '文件输出需要 v2 和空的 output' })
    if (seen.has(c.id) || !declared.has(c.id)) ctx.addIssue({ code: 'custom', message: '自定义契约重复或未被此包声明' })
    seen.add(c.id)
  }
})
export type CapabilityDeclarations = z.infer<typeof capabilityDeclarationsSchema>

export function consumedCapabilities(value?: CapabilityDeclarations) {
  return [...(value?.consumes ?? []), ...(value?.optionalConsumes ?? [])]
}
