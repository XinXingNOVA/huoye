import { z } from 'zod'
import type { MediaProvider } from './capabilities'
import { run } from '../plugin-api/core/process'
import type { MediaInspection } from '../plugin-api/core/capabilities'

const tags = z.record(z.string(), z.string()).default({})
const numberText = z.string().optional()
const stream = z.object({
  index: z.number().int().nonnegative(), codec_type: z.string().default('unknown'), codec_name: z.string().optional(),
  width: z.number().int().optional(), height: z.number().int().optional(),
  avg_frame_rate: numberText, r_frame_rate: numberText, sample_rate: numberText, duration: numberText, bit_rate: numberText,
  channels: z.number().int().optional(), tags, disposition: z.object({ attached_pic: z.number().optional() }).optional(),
  side_data_list: z.array(z.object({ rotation: z.number().optional() })).optional()
})
const probe = z.object({
  streams: z.array(stream).max(4096),
  format: z.object({ format_name: z.string().optional(), bit_rate: numberText, duration: numberText, tags })
})

function positive(text?: string) {
  const value = Number(text)
  return Number.isFinite(value) && value > 0 ? value : undefined
}
function frameRate(text?: string) {
  if (!text) return undefined
  const [a, b = '1'] = text.split('/')
  const rate = Number(a) / Number(b)
  return Number.isFinite(rate) && rate > 0 ? rate : undefined
}
function rotationTag(text?: string) {
  const value = text ? Number(text) : NaN
  return Number.isFinite(value) ? value : undefined
}
export function parseMediaInspection(value: unknown): MediaInspection {
  const { streams, format } = probe.parse(value)
  return {
    format: format.format_name, duration: positive(format.duration), bitRate: positive(format.bit_rate), tags: format.tags,
    tracks: streams.map(s => ({
      index: s.index, type: s.codec_type, codec: s.codec_name, duration: positive(s.duration), bitRate: positive(s.bit_rate),
      width: s.width, height: s.height, fps: frameRate(s.avg_frame_rate) ?? frameRate(s.r_frame_rate),
      rotation: s.side_data_list?.find(d => d.rotation !== undefined)?.rotation ?? rotationTag(s.tags.rotate),
      sampleRate: positive(s.sample_rate), channels: s.channels, attachedPicture: s.disposition?.attached_pic === 1, tags: s.tags
    }))
  }
}

export const mediaInputFlags = ['-protocol_whitelist', 'file', '-format_whitelist',
  'mov,matroska,avi,asf,flv,mpeg,mpegvideo,mpegts,ogg,mp3,wav,flac,aac,aiff,ape']
export async function inspectMedia(program: string, path: string, signal: AbortSignal) {
  const out = await run(program, ['-v', 'error', ...mediaInputFlags,
    '-show_entries', 'format=format_name,duration,bit_rate:format_tags:stream=index,codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate,duration,bit_rate,sample_rate,channels:stream_tags:stream_disposition=attached_pic:stream_side_data=rotation',
    '-of', 'json', '-i', path], { signal, maxOutputBytes: 4 * 1024 * 1024 })
  try { return parseMediaInspection(JSON.parse(out.toString())) }
  catch { throw Error('[CAPABILITY_INVALID_OUTPUT] ffprobe 返回的媒体信息无效') }
}

export function ffprobeProvider(program: string | undefined) {
  return {
    id: 'huoye.ffprobe', programs: ['ffprobe'], unavailable: program ? undefined : '找不到 ffprobe',
    execute(path, signal) {
      if (!program) throw Error('[CAPABILITY_UNAVAILABLE] 找不到 ffprobe')
      return inspectMedia(program, path, signal)
    }
  } satisfies MediaProvider<'media.inspect@1'>
}
