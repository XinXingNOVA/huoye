// 数字的显示格式：核心进程（导出）和界面共用。

/** 字节 → 1.2 MB。 */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`
}

/** 秒 → m:ss 或 h:mm:ss。 */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return '—'
  const s = Math.round(seconds)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const p = (n: number) => String(n).padStart(2, '0')
  return h ? `${h}:${p(m)}:${p(s % 60)}` : `${m}:${p(s % 60)}`
}
