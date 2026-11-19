// 工程文件归仓库使用者。本机回执决定哪些源码是宿主为这个授权身份创建的。
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { z } from 'zod'
import { developmentProjectSchema, type DevelopmentTarget } from '../shared/development-access'

const recordSchema = developmentProjectSchema.omit({ libraryId: true }).extend({
  staging: z.string().regex(/^\.new-[a-zA-Z0-9]+$/), directory: z.string().regex(/^plugin-[a-z0-9-]+$/)
}).strict()
type Project = z.infer<typeof recordSchema>
type Identity = Pick<DevelopmentTarget, 'root' | 'libraryId'>
const workspace = (target: Identity) => join(target.root, '.rm-plugin-projects')
const writeJson = (file: string, data: unknown) => writeFileSync(file, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
function checkDirectory(path: string) {
  if (!lstatSync(path).isDirectory() || realpathSync(path) !== path) throw new Error('[SOURCE_CHANGED] 自主开发目录位置已变化')
}
export class DevelopmentProjects {
  constructor(private directory: string) {}
  private file(target: Identity) {
    const scope = createHash('sha256').update(JSON.stringify([target.root, target.libraryId])).digest('hex')
    return join(this.directory, scope + '.json')
  }
  private records(target: Identity) {
    const file = this.file(target)
    return existsSync(file) ? z.array(recordSchema).max(32).parse(JSON.parse(readFileSync(file, 'utf8'))) : []
  }
  sources(target: Identity) {
    return this.records(target).map(p => ({ source: join(workspace(target), p.directory), pluginId: p.pluginId }))
  }
  create(target: Identity, input: z.infer<typeof developmentProjectSchema>) {
    const base = workspace(target), file = this.file(target), records = this.records(target)
    let row = records.find(r => r.requestId === input.requestId)
    if (row && (row.pluginId !== input.pluginId || row.title !== input.title)) throw new Error('[REQUEST_CONFLICT] 此请求已用于其他工程参数')
    checkDirectory(target.root)
    if (!existsSync(base)) mkdirSync(base, { mode: 0o700 })
    checkDirectory(base)
    if (!row) {
      if (records.some(p => p.pluginId === input.pluginId)) throw new Error('[PLUGIN_ID_CONFLICT] 本库已创建同名工程，请从开发状态取得原来源')
      if (records.length >= 32) throw new Error('[PROJECT_LIMIT] 此库已登记 32 个自主开发工程')
      const stage = mkdtempSync(join(base, '.new-'))
      const created: Project = { requestId: input.requestId, pluginId: input.pluginId, title: input.title,
        directory: 'plugin-' + input.pluginId + '-' + randomUUID(), staging: basename(stage) }
      try {
        writeJson(join(stage, 'plugin.json'), { id: input.pluginId, title: input.title, description: input.title, author: '本库开发者', version: '0.1.0',
          apiVersion: 1, coreFeatures: ['operation-effects-v1'], entries: { core: './core.ts' } })
        writeFileSync(join(stage, 'core.ts'), "import type { CorePlugin } from '@resource-manager/plugin-api/core/contracts'\n\n" +
          "export const plugin: CorePlugin = { id: '" + input.pluginId + "', version: 1 }\n", { mode: 0o600 })
        mkdirSync(this.directory, { recursive: true, mode: 0o700 })
        writeJson(file + '.tmp', [...records, created]); renameSync(file + '.tmp', file)
      } catch (error) { rmSync(stage, { recursive: true, force: true }); throw error }
      row = created
    }
    const source = join(base, row.directory), stage = join(base, row.staging)
    if (existsSync(stage)) {
      if (existsSync(source)) throw new Error('[SOURCE_CHANGED] 工程位置已被占用，保留两处内容供检查')
      checkDirectory(stage); renameSync(stage, source)
    }
    if (!existsSync(source)) throw new Error('[SOURCE_CHANGED] 工程目录已移除，请检查原工程')
    checkDirectory(source)
    return source
  }
}
