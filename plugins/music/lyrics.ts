export interface LyricLine { time: number; text: string }
export function parseLyrics(raw: string): { lines: LyricLine[]; plain: string; offset: number } {
  const lines: LyricLine[] = []
  let offset = 0
  const plain: string[] = []
  for (const line of raw.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const tag = line.match(/^\[offset:([+-]?\d+)\]/i)
    if (tag) { offset = Math.max(-600, Math.min(600, Number(tag[1]) / 1000)); continue }
    if (/^\[(ar|ti|al|by|re|ve|length):/i.test(line)) continue
    const times = [...line.matchAll(/\[(\d{1,3}):([0-5]\d)(?:[.:](\d{1,3}))?\]/g)]
    const value = line.replace(/\[\d{1,3}:[0-5]\d(?:[.:]\d{1,3})?\]/g, '').trim()
    if (value) plain.push(value)
    for (const time of times) lines.push({ time: Number(time[1]) * 60 + Number(time[2]) + Number(`0.${time[3] ?? '0'}`), text: value || '♪' })
  }
  lines.sort((a, b) => a.time - b.time)
  return { lines, plain: plain.join('\n'), offset }
}
/** 正偏移让歌词稍后出现；多个相同时间戳的行一起高亮。 */
export function currentLine(lines: LyricLine[], seconds: number): number {
  let lo = 0, hi = lines.length
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (lines[mid].time <= seconds) lo = mid + 1; else hi = mid }
  return lo - 1
}
