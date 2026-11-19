import type { BlockData } from '../../shared/blocks'

interface Stream {
  index?: number
  codec_type?: string
  codec_name?: string
  sample_rate?: string
  channels?: number
  bit_rate?: string
  duration?: string
  tags?: Record<string, string>
  disposition?: { attached_pic?: number }
}

/** 只接受容器明确标记的内嵌图片；多图优先正面封面，不把普通视频帧当封面。 */
export function coverStreams(probe: Probe): number[] {
  const rank = (s: Stream) => {
    const text = Object.values(s.tags ?? {}).join(' ')
    return /\bfront\b|正面/i.test(text) ? 0 : /\bback\b|背面/i.test(text) ? 2 : 1
  }
  return (probe.streams ?? [])
    .filter(s => s.codec_type === 'video' && s.disposition?.attached_pic === 1 && Number.isInteger(s.index) && s.index! >= 0)
    .sort((a, b) => rank(a) - rank(b) || a.index! - b.index!)
    .map(s => s.index!)
}
export interface Probe {
  streams?: Stream[]
  format?: { duration?: string; bit_rate?: string; tags?: Record<string, string> }
}

const positive = (value: unknown): number | undefined => {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

export function parseProbe(probe: Probe, ext: string): BlockData {
  const stream = probe.streams?.find(s => s.codec_type === 'audio')
  if (!stream) throw new Error('文件中没有音轨')
  const codec = stream.codec_name ?? 'unknown'
  // 保守的原文件播放名单；其他容器/编码通过按需副本播放。
  // 设备仍可能拒绝名单内的特殊文件，界面也提供转换入口。
  const playable = (ext === 'mp3' && codec === 'mp3') || (ext === 'flac' && codec === 'flac') ||
    (ext === 'wav' && ['pcm_s16le', 'pcm_s24le', 'pcm_s32le', 'pcm_f32le'].includes(codec)) ||
    (ext === 'm4a' && codec === 'aac') || (ext === 'ogg' && ['vorbis', 'opus'].includes(codec))
  const tags = Object.fromEntries(Object.entries({ ...probe.format?.tags, ...stream.tags }).map(([k, v]) => [k.toLowerCase(), v]))
  return {
    duration: positive(probe.format?.duration) ?? positive(stream.duration) ?? 0,
    codec, sampleRate: positive(stream.sample_rate), channels: positive(stream.channels),
    bitRate: positive(stream.bit_rate) ?? positive(probe.format?.bit_rate),
    title: tags.title, artist: tags.artist, album: tags.album, playable
  }
}
