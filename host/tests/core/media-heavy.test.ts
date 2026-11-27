import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WaveEnvelope, heavyMediaProviders } from '../../src/core/media-heavy'
import { MediaSlots } from '../../src/shared/media-slots'
import { programDirectories, findProgram } from '../../src/platform/programs'
import { run } from '../../src/plugin-api/core/process'

it('两个运行名额用满后按序交接，取消排队和重复释放不会额外放行', async () => {
  const pool = new MediaSlots()
  const signal = AbortSignal.timeout(3000)
  const first = await pool.acquire(signal), second = await pool.acquire(signal)
  const cancelled = new AbortController()
  const dropped = pool.acquire(cancelled.signal)
  const order: number[] = []
  const third = pool.acquire(signal).then(release => { order.push(3); return release })
  const fourth = pool.acquire(signal).then(release => { order.push(4); return release })
  cancelled.abort()
  await expect(dropped).rejects.toThrow()
  first(); first()
  const releaseThird = await third
  expect(order).toEqual([3])
  second()
  const releaseFourth = await fourth
  expect(order).toEqual([3, 4])
  releaseThird(); releaseFourth()
})

it('容器时长低估时扩宽峰值分桶，保留中间和尾部的瞬态峰值', () => {
  const env = new WaveEnvelope(3, 1)
  for (const peak of [1, 0, 0.2, 0.4, 0, 0, 0, 0, 0.9]) env.add(peak)
  expect(env.stride).toBe(4)
  expect(env.peaks).toEqual([1, 0, 0.9])
})

it('交互可越过排队中的后台任务，连续四次后后台获得一次执行机会', async () => {
  const pool = new MediaSlots(1), signal = AbortSignal.timeout(3000)
  const busy = await pool.acquire(signal)
  const order: string[] = []
  const submit = (name: string, priority: 'interactive' | 'background') =>
    pool.acquire(signal, priority).then(release => { order.push(name); release() })
  const pending = [submit('background', 'background'), ...Array.from({ length: 5 }, (_, i) => submit(String(i), 'interactive'))]
  busy()
  await Promise.all(pending)
  expect(order).toEqual(['0', '1', '2', '3', 'background', '4'])
})

it('逐行读取保留 stdout 与 stderr 的无换行尾行', async () => {
  const out: string[] = [], err: string[] = []
  await run(process.execPath, ['-e', 'process.stdout.write("首行\\n尾行"); process.stderr.write("警告")'], {
    signal: AbortSignal.timeout(3000), onLine: line => out.push(line), onStderrLine: line => err.push(line)
  })
  expect(out).toEqual(['首行', '尾行'])
  expect(err).toEqual(['警告'])
})

const ffmpeg = findProgram('ffmpeg', programDirectories())
const probe = findProgram('ffprobe', programDirectories())
describe.runIf(!!ffmpeg && !!probe)('原生计算的结束边界', () => {
  it('音频不能用作字幕，运行中取消终止解码，限额结束后管道关闭', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'huoye-native-media-'))
    try {
      const path = join(dir, 'source.wav')
      execFileSync(ffmpeg!, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=duration=60', path])
      const providers = heavyMediaProviders(probe, ffmpeg)
      const source = { id: 'one', fileSeq: 1, track: 0 }
      const task = new AbortController()
      await expect(providers['media.subtitle@1'].execute(path, task.signal, source, () => {})).rejects.toThrow('TRACK_UNSUPPORTED')
      const progress: number[] = []
      await expect(providers['audio.waveform@1'].execute(path, task.signal, { ...source, maxPeaks: 120 }, fraction => {
        progress.push(fraction)
        task.abort()
      })).rejects.toThrow()
      expect(progress[0]).toBeGreaterThan(0)
      expect(progress).not.toContain(1)
      await expect(run(ffmpeg!, ['-v', 'error', '-i', path, '-f', 's16le', 'pipe:1'],
        { signal: AbortSignal.timeout(3000), maxOutputBytes: 4096 })).rejects.toThrow('CAPABILITY_OUTPUT_LIMIT')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
