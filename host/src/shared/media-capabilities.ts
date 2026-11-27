import { z } from 'zod'
import { mediaInspectionSchema } from './media-inspection'

const source = z.object({ id: z.string().min(1).max(200), fileSeq: z.number().int().positive() }).strict()
const track = z.number().int().min(0).max(0x7fffffff)
export const MAX_SUBTITLE_BYTES = 2 * 1024 * 1024
const waveform = z.object({
  track, bucketSeconds: z.number().positive(), peaks: z.array(z.number().min(0).max(1)).min(1).max(4096)
})
const subtitle = z.object({ track, format: z.literal('srt'), text: z.string().max(MAX_SUBTITLE_BYTES) })

export const mediaContracts = {
  'media.inspect@1': { input: source, output: mediaInspectionSchema },
  'audio.waveform@1': { input: source.extend({ track, maxPeaks: z.number().int().min(2).max(4096) }), output: waveform },
  'media.subtitle@1': { input: source.extend({ track }), output: subtitle }
}
export type MediaCapability = keyof typeof mediaContracts
export type MediaInput<K extends MediaCapability> = z.infer<(typeof mediaContracts)[K]['input']>
export type MediaOutput<K extends MediaCapability> = z.infer<(typeof mediaContracts)[K]['output']>
