import { z } from 'zod'
import { versionRequestId, type VersionCommit } from './space-versions'

export const prepareFileEditSchema = z.object({
  id: z.string().min(1).max(200), requestId: versionRequestId,
  expectedPath: z.string().optional(), expectedSeq: z.number().int().nonnegative().optional(),
  destination: z.discriminatedUnion('mode', [z.object({ mode: z.literal('publish') }).strict(),
    z.object({ mode: z.literal('copy'), spaceId: z.string().uuid() }).strict()]),
  content: z.discriminatedUnion('type', [z.object({ type: z.literal('current') }).strict(), z.object({ type: z.literal('file'), path: z.string().min(1) }).strict(),
    z.object({ type: z.literal('text'), text: z.string().max(4 * 1024 * 1024) }).strict()])
}).strict()
export type PrepareFileEdit = z.infer<typeof prepareFileEditSchema>
export const commitFileEditSchema = z.object({ editId: z.string().uuid(), previewToken: z.string().regex(/^[a-f0-9]{64}$/), requestId: versionRequestId }).strict()
export type CommitFileEdit = z.infer<typeof commitFileEditSchema>
export const discardFileEditSchema = z.object({ editId: z.string().uuid().optional(), prepareRequestId: versionRequestId.optional(), requestId: versionRequestId }).strict()
  .refine(v => !!v.editId !== !!v.prepareRequestId, '请指定 editId 或 prepareRequestId 之一')
export type DiscardFileEdit = z.infer<typeof discardFileEditSchema>
export interface FileEditCapabilities {
  id: string; publish: { allowed: boolean; reason?: string; spaceId?: string }
  copyTargets: { spaceId: string; name: string }[]; copyReason?: string
}
export interface FileEditPreview {
  editId: string; id: string; mode: 'publish' | 'copy'; spaceId: string
  name: string; size: number; hash: string; previewToken: string
}
export interface FileEditResult {
  space: VersionCommit; library: { state: 'accepted' | 'pending' | 'skipped'; error?: string }
}
