// 根据公共媒体探测结果判断 Chromium 能否直接播放。

import type { MediaInspection } from '../../../plugin-api/core/capabilities'
import type { BlockData } from '../../../shared/blocks'

/** 实测（Electron 44）：H.264 / HEVC / VP8 / VP9 / AV1 在 MP4、MOV、MKV、WebM 中可以直接播放；AVI 不行。 */
const VIDEO_OK = new Set(['h264', 'hevc', 'vp8', 'vp9', 'av1'])
const AUDIO_OK = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac'])
const CONTAINER_OK = ['mp4', 'mov', 'matroska', 'webm']

export function codecsPlayable(video: string, audio: string | undefined): boolean {
  return VIDEO_OK.has(video) && (!audio || AUDIO_OK.has(audio))
}

export function parseProbe(probe: MediaInspection): BlockData {
  const v = probe.tracks.find((s) => s.type === 'video')
  if (!v?.width || !v.height) throw new Error('没有视频画面')
  const a = probe.tracks.find((s) => s.type === 'audio')

  // 旋转：手机竖拍的视频常见 -90，显示时宽高互换
  const raw = v.rotation ?? 0
  const rotation = ((Math.round(raw / 90) * 90) % 360 + 360) % 360
  const sideways = rotation === 90 || rotation === 270

  const duration = Number(probe.duration)
  const container = probe.format ?? ''
  const codec = v.codec ?? 'unknown'
  const audio = a?.codec

  return {
    duration: Number.isFinite(duration) ? Math.round(duration * 1000) / 1000 : 0,
    width: sideways ? v.height : v.width,
    height: sideways ? v.width : v.height,
    fps: v.fps === undefined ? undefined : Math.round(v.fps * 100) / 100,
    codec,
    audio,
    rotation,
    playable: CONTAINER_OK.some((c) => container.includes(c)) && codecsPlayable(codec, audio)
  }
}
