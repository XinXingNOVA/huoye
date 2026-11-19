// 协议入口复用语义 API。externalFileAction 由宿主选择外部调用作用域，不能由远端自报。
import { z } from 'zod'
import { prepareFileEditSchema, commitFileEditSchema, discardFileEditSchema } from './file-edits'
import { acceptFileUpdateSchema } from './file-updates'
import { spaceHistorySchema, restoreVersionSchema, versionRequestId } from './space-versions'
import { spaceMutationPreviewSchema, spaceMutationSchema } from './file-spaces'
export const fileActionSchemas = {
  capabilities: z.object({ id: z.string().min(1).max(200) }).strict(),
  previewUpdate: z.object({ id: z.string().min(1).max(200) }).strict(),
  acceptUpdate: acceptFileUpdateSchema,
  prepare: prepareFileEditSchema, commit: commitFileEditSchema, discard: discardFileEditSchema,
  cancel: z.object({ requestId: versionRequestId }).strict(),
  history: spaceHistorySchema, restoreVersion: restoreVersionSchema,
  previewLifecycle: spaceMutationPreviewSchema, applyLifecycle: spaceMutationSchema,
  editTarget: z.object({ editId: z.string().uuid() }).strict()
} as const
export type FileAction = { [K in keyof typeof fileActionSchemas]: { action: K; input: z.input<(typeof fileActionSchemas)[K]> } }[keyof typeof fileActionSchemas]
export const fileActionSchema = z.discriminatedUnion('action', Object.entries(fileActionSchemas).map(([action, input]) => z.object({ action: z.literal(action), input }).strict()) as any) as z.ZodType<FileAction>
export const fileReadActions = new Set<keyof typeof fileActionSchemas>(['capabilities', 'previewUpdate', 'history', 'previewLifecycle', 'editTarget'])
