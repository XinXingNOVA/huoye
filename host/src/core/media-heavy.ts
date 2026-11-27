import type { MediaProvider } from './capabilities'
import { inspectMedia, mediaInputFlags } from './media-inspect'
import { run } from '../plugin-api/core/process'
import { MAX_SUBTITLE_BYTES } from '../shared/media-capabilities'

const textCodecs = new Set(['subrip', 'ass', 'ssa', 'webvtt', 'mov_text', 'text', 'ttml', 'sami', 'microdvd'])
const peakKey = 'lavfi.astats.Overall.Peak_level='

/** 输入时长是估计值。超出时两两合并，维持等时宽度与有界内存，不截掉音频尾部。 */
export class WaveEnvelope {
  readonly peaks: number[] = []
  windows = 0
  constructor(private readonly maxPeaks: number, public stride: number) {}
  add(peak: number) {
    let index = Math.floor(this.windows / this.stride)
    if (index >= this.maxPeaks) {
      for (let i = 0; i < this.peaks.length; i += 2) {
        this.peaks[i / 2] = Math.max(this.peaks[i], this.peaks[i + 1] ?? 0)
      }
      this.peaks.length = Math.ceil(this.peaks.length / 2)
      this.stride *= 2
      index = Math.floor(this.windows / this.stride)
    }
    this.peaks[index] = Math.max(this.peaks[index] ?? 0, peak)
    this.windows++
  }
}

function reportTime(duration: number | undefined, progress: (fraction: number) => void) {
  let last = 0
  return (seconds: number) => {
    const now = Date.now()
    if (duration && Number.isFinite(seconds) && seconds >= 0 && now - last >= 150) {
      last = now
      progress(Math.min(0.99, seconds / duration))
    }
  }
}

export function heavyMediaProviders(probe: string | undefined, ffmpeg: string | undefined) {
  const unavailable = !probe ? '找不到 ffprobe' : !ffmpeg ? '找不到 ffmpeg' : undefined
  async function trackInfo(path: string, signal: AbortSignal, index: number, type: string) {
    if (!probe || !ffmpeg) throw Error('[CAPABILITY_UNAVAILABLE] ' + unavailable)
    const media = await inspectMedia(probe, path, signal)
    const track = media.tracks.find(t => t.index === index)
    if (track?.type !== type) throw Error('[CAPABILITY_TRACK_UNSUPPORTED] 媒体中没有指定类型的轨道')
    return { track, duration: track.duration ?? media.duration, program: ffmpeg }
  }
  const waveform: MediaProvider<'audio.waveform@1'> = {
    id: 'huoye.ffmpeg', programs: ['ffprobe', 'ffmpeg'], unavailable,
    async execute(path, signal, input, progress) {
      const { track, duration, program } = await trackInfo(path, signal, input.track, 'audio')
      if (!track.sampleRate) throw Error('[CAPABILITY_TRACK_UNSUPPORTED] 音轨缺少采样率')
      const samples = duration ? Math.ceil(duration * track.sampleRate / input.maxPeaks) : 1024
      const frame = Math.min(8192, Math.max(1, samples))
      const seconds = frame / track.sampleRate
      const envelope = new WaveEnvelope(input.maxPeaks, Math.max(1, Math.ceil(samples / frame)))
      const update = reportTime(duration, progress)
      // FFmpeg 在源采样率下取所有声道的最大峰值。管道只流过分段统计，PCM 留在解码进程。
      const filter = [
        'asetnsamples=n=' + frame + ':p=0',
        'astats=metadata=1:reset=1:measure_perchannel=none:measure_overall=Peak_level',
        'ametadata=mode=print:key=lavfi.astats.Overall.Peak_level:file=-'
      ].join(',')
      await run(program, ['-nostdin', '-v', 'error', '-threads', '2', '-filter_threads', '1', ...mediaInputFlags, '-i', path,
        '-map', '0:' + track.index, '-af', filter, '-f', 'null', '-'], {
        signal, onLine(line) {
          if (!line.startsWith(peakKey)) return
          const raw = line.slice(peakKey.length).trim()
          const db = raw ? Number(raw) : NaN
          envelope.add(Number.isFinite(db) ? Math.min(1, 10 ** (db / 20)) : 0)
          update(envelope.windows * seconds)
        }
      })
      if (!envelope.windows) throw Error('[CAPABILITY_EMPTY_AUDIO] 音轨中没有可解码的采样')
      progress(1)
      return { track: track.index, peaks: envelope.peaks, bucketSeconds: envelope.stride * seconds }
    }
  }
  const subtitle: MediaProvider<'media.subtitle@1'> = {
    id: 'huoye.ffmpeg', programs: ['ffprobe', 'ffmpeg'], unavailable,
    async execute(path, signal, input, progress) {
      const { track, duration, program } = await trackInfo(path, signal, input.track, 'subtitle')
      if (!track.codec || !textCodecs.has(track.codec)) throw Error('[CAPABILITY_TRACK_UNSUPPORTED] 需要受支持的内封文本字幕轨')
      const update = reportTime(duration, progress)
      const bytes = await run(program, ['-nostdin', '-v', 'error', ...mediaInputFlags, '-i', path,
        '-map', '0:' + track.index, '-c:s', 'srt', '-f', 'srt', '-progress', 'pipe:2', 'pipe:1'], {
        signal, maxOutputBytes: MAX_SUBTITLE_BYTES, onStderrLine(line) {
          if (line.startsWith('out_time_us=')) update(Number(line.slice(12)) / 1_000_000)
        }
      })
      progress(1)
      return { track: track.index, format: 'srt', text: bytes.toString('utf8') }
    }
  }
  return { 'audio.waveform@1': waveform, 'media.subtitle@1': subtitle }
}
