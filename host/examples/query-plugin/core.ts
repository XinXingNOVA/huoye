import { z } from 'zod'
import type { CorePlugin } from '@resource-manager/plugin-api/core/contracts'
import { queryPageSchema } from '@resource-manager/plugin-api/queries'

export const plugin: CorePlugin = {
  id: 'demo-query', version: 1,
  queries: [
    {
      name: 'overview', title: '素材概况',
      description: '统计活跃素材和其中带文件的素材，不包含管理记录及回收站。',
      input: z.object({}).strict(),
      output: z.object({ materials: z.number().int().nonnegative(), files: z.number().int().nonnegative() }).strict(),
      run(ctx) { return { materials: ctx.count({}), files: ctx.count({ has: ['file'] }) } }
    },
    {
      name: 'file_formats', title: '文件格式分布',
      description: '按扩展名排序，返回活跃素材中的文件格式及数量；prefix 是扩展名前缀，可为空。',
      input: z.object({ prefix: z.string().max(20).default('') }).strict(),
      output: queryPageSchema(z.object({ extension: z.string(), materialCount: z.number().int().nonnegative() }).strict()),
      paginated: true,
      run(ctx, args) {
        const prefix = args.prefix as string
        const formats = ctx.facet('file', 'ext')
          .filter(row => row.value.startsWith(prefix))
          .map(row => ({ extension: row.value, materialCount: row.count }))
          .sort((a, b) => a.extension < b.extension ? -1 : a.extension > b.extension ? 1 : 0)
        return { ...ctx.page(formats) }
      }
    }
  ]
}
