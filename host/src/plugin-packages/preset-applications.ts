import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { pluginSelectionSchema, presetLayoutSchema, presetTitleSchema, type PluginSelection, type PresetArrangement } from '../shared/plugin-presets'

export const arrangementSchema = z.object({ title: presetTitleSchema, layout: presetLayoutSchema }).strict()
const jobSchema = arrangementSchema.extend({ id: z.string().uuid(), libraryId: z.string().min(1), selection: pluginSelectionSchema }).strict()
export function samePluginSelection(a: PluginSelection, b: PluginSelection): boolean {
  const key = (s: PluginSelection) => JSON.stringify({ disabled: [...s.disabled].sort(), external: [...s.external].sort((a,b) => a.id.localeCompare(b.id)).map(p => ({ id: p.id, hash: p.hash, enabled: p.enabled })) })
  return key(a) === key(b)
}
/** 保存的是一次明确确认的意图，不是插件运行时，也不携带仓库业务数据。 */
export class PresetApplications {
  constructor(private directory: string) {}
  private file(root: string) { return join(this.directory, createHash('sha256').update(root).digest('hex') + '.json') }
  read(root: string, libraryId: string) {
    try {
      const bytes = readFileSync(this.file(root))
      if (bytes.length > 1024 * 1024) throw new Error('方案接续记录过大')
      const job = jobSchema.parse(JSON.parse(bytes.toString('utf8')))
      if (job.libraryId !== libraryId) throw new Error('此路径的仓库身份已改变，未应用原仓库方案')
      return job
    } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw e }
  }
  start(root: string, libraryId: string, selection: PluginSelection, arrangement: PresetArrangement, id: string = randomUUID()) {
    if (this.read(root, libraryId)) throw new Error('还有未完成的方案，请先在插件组合中接续或取消')
    const job = jobSchema.parse({ ...arrangement, id, libraryId, selection })
    const data = JSON.stringify(job)
    if (Buffer.byteLength(data) > 1024 * 1024) throw new Error('方案接续记录过大')
    mkdirSync(this.directory, { recursive: true })
    const file = this.file(root), tmp = file + '.' + randomUUID() + '.tmp'
    try { writeFileSync(tmp, data, { flag: 'wx', mode: 0o600 }); renameSync(tmp, file) }
    finally { rmSync(tmp, { force: true }) }
    return job
  }
  finish(root: string, libraryId: string, id: string, receipt: unknown) {
    if (receipt !== id) throw new Error('工作台尚未保存成功，已保留待接续方案')
    this.cancel(root, libraryId, id)
  }
  cancel(root: string, libraryId: string, id: string) {
    const job = this.read(root, libraryId)
    if (job && job.id !== id) throw new Error('方案接续状态已改变，请刷新')
    rmSync(this.file(root), { force: true })
  }
}
