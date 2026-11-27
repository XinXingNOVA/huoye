import type { MediaInspection, MediaTrack } from '../../plugin-api/core/capabilities'
import type { BlockData } from '../../shared/blocks'

/** 只接受容器明确标记的内嵌图片；多图优先正面封面，不把普通视频帧当封面。 */
export function coverStreams(probe: MediaInspection): number[] {
  const rank = (s: MediaTrack) => {
    const text = Object.values(s.tags ?? {}).join(' ')
    return /\bfront\b|正面/i.test(text) ? 0 : /\bback\b|背面/i.test(text) ? 2 : 1
  }
  return probe.tracks
    .filter(s => s.type === 'video' && s.attachedPicture && Number.isInteger(s.index) && s.index >= 0)
    .sort((a, b) => rank(a) - rank(b) || a.index - b.index)
    .map(s => s.index)
}
export function parseProbe(probe: MediaInspection, ext: string): BlockData {
  const stream = probe.tracks.find(s => s.type === 'audio')
  if (!stream) throw new Error('文件中没有音轨')
  const codec = stream.codec ?? 'unknown'
  // 保守的原文件播放名单；其他容器/编码通过按需副本播放。
  // 设备仍可能拒绝名单内的特殊文件，界面也提供转换入口。
  const playable = (ext === 'mp3' && codec === 'mp3') || (ext === 'flac' && codec === 'flac') ||
    (ext === 'wav' && ['pcm_s16le', 'pcm_s24le', 'pcm_s32le', 'pcm_f32le'].includes(codec)) ||
    (ext === 'm4a' && codec === 'aac') || (ext === 'ogg' && ['vorbis', 'opus'].includes(codec))
  const tags = Object.fromEntries(Object.entries({ ...probe.tags, ...stream.tags }).map(([k, v]) => [k.toLowerCase(), v]))
  return {
    duration: probe.duration ?? stream.duration ?? 0,
    codec, sampleRate: stream.sampleRate, channels: stream.channels,
    bitRate: stream.bitRate ?? probe.bitRate,
    title: tags.title, artist: tags.artist, album: tags.album, playable
  }
}
