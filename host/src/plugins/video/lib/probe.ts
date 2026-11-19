// 解析 ffprobe 的输出，判断 Chromium 能否直接播放。

import type { BlockData } from '../../../shared/blocks'

interface Stream {
  codec_type?: string
  codec_name?: string
  width?: number
  height?: number
  avg_frame_rate?: string
  r_frame_rate?: string
  tags?: Record<string, string>
  side_data_list?: { rotation?: number }[]
}

export interface Probe {
  streams?: Stream[]
  format?: { format_name?: string; duration?: string }
}

/** 实测（Electron 44）：H.264 / HEVC / VP8 / VP9 / AV1 在 MP4、MOV、MKV、WebM 中可以直接播放；AVI 不行。 */
const VIDEO_OK = new Set(['h264', 'hevc', 'vp8', 'vp9', 'av1'])
const AUDIO_OK = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac'])
const CONTAINER_OK = ['mp4', 'mov', 'matroska', 'webm']

export function codecsPlayable(video: string, audio: string | undefined): boolean {
  return VIDEO_OK.has(video) && (!audio || AUDIO_OK.has(audio))
}

function rate(s: string | undefined): number | undefined {
  if (!s) return undefined
  const [a, b] = s.split('/').map(Number)
  const v = b ? a / b : a
  return Number.isFinite(v) && v > 0 ? Math.round(v * 100) / 100 : undefined
}

export function parseProbe(probe: Probe): BlockData {
  const v = probe.streams?.find((s) => s.codec_type === 'video')
  if (!v?.width || !v.height) throw new Error('没有视频画面')
  const a = probe.streams?.find((s) => s.codec_type === 'audio')

  // 旋转：手机竖拍的视频常见 -90，显示时宽高互换
  const raw = v.side_data_list?.find((d) => typeof d.rotation === 'number')?.rotation ?? Number(v.tags?.rotate ?? 0)
  const rotation = ((Math.round(raw / 90) * 90) % 360 + 360) % 360
  const sideways = rotation === 90 || rotation === 270

  const duration = Number(probe.format?.duration)
  const container = probe.format?.format_name ?? ''
  const codec = v.codec_name ?? 'unknown'
  const audio = a?.codec_name

  return {
    duration: Number.isFinite(duration) ? Math.round(duration * 1000) / 1000 : 0,
    width: sideways ? v.height : v.width,
    height: sideways ? v.width : v.height,
    fps: rate(v.avg_frame_rate) ?? rate(v.r_frame_rate),
    codec,
    audio,
    rotation,
    playable: CONTAINER_OK.some((c) => container.includes(c)) && codecsPlayable(codec, audio)
  }
}
