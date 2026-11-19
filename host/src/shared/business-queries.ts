import { z } from 'zod'

export const QUERY_LIMITS = { page: 50, resultBytes: 65536, readBytes: 1048576, calls: 100, items: 10000 } as const
export const executeQuerySchema = z.object({
  query: z.string().regex(/^[a-z][a-z0-9-]{0,79}\.[a-z][a-z0-9_]{0,63}$/),
  args: z.record(z.string(), z.unknown()).default({}),
  limit: z.number().int().min(1).max(QUERY_LIMITS.page).optional(),
  cursor: z.string().min(1).max(2000).optional()
}).strict()
export type ExecuteQueryRequest = z.input<typeof executeQuerySchema>
export interface QueryDescription {
  name: string
  plugin: string
  title: string
  description: string
  inputSchema: Record<string, unknown>
  outputSchema: Record<string, unknown>
  paginated: boolean
}
export interface QueryResponse { query: string; result: Record<string, unknown> }
