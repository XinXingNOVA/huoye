import { z } from 'zod'
import { queryPageSchema, type QueryDefinition } from '@resource-manager/plugin-api/queries'
export const queries: QueryDefinition[] = [{
  name: 'list_tags', title: '列出已使用标签',
  description: '共享标签词表及精确素材数；不解释分组或父子关系。不含回收站。',
  input: z.object({ prefix: z.string().max(200).default('') }).strict(),
  output: queryPageSchema(z.object({ tag: z.string(), materialCount: z.number().int().nonnegative() })), paginated: true,
  run(ctx, args) { return { ...ctx.page(ctx.facet('tags', 'values').filter(r => r.value.startsWith(String(args.prefix))).map(r => ({ tag: r.value, materialCount: r.count }))) } }
}]
