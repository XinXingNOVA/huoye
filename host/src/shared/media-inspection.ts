import { z } from 'zod'

/** media.inspect@1 的输出定义同时用于校验 Provider 和生成 SDK 类型。 */
const tags = z.record(z.string(), z.string())
const positive = z.number().positive().optional()
const pixels = z.number().int().nonnegative().optional()
export const mediaInspectionSchema = z.object({
  format: z.string().optional(), duration: positive, bitRate: positive, tags,
  tracks: z.array(z.object({
    index: z.number().int().nonnegative(), type: z.string(), codec: z.string().optional(), tags,
    width: pixels, height: pixels, fps: positive, rotation: z.number().optional(),
    duration: positive, channels: pixels, sampleRate: positive, bitRate: positive,
    attachedPicture: z.boolean()
  })).max(4096)
})
export type MediaInspection = z.infer<typeof mediaInspectionSchema>
export type MediaTrack = MediaInspection['tracks'][number]
