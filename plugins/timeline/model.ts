export type Granularity = 'day' | 'month' | 'year'
export function readOptions(value: Record<string, unknown>) {
  return {
    group: (['day', 'month', 'year'].includes(String(value.group)) ? value.group : 'month') as Granularity,
    ascending: value.ascending === true
  }
}
export interface Group { key: string; label: string; ids: string[] }
export function groupItems(ids: readonly string[], dates: ReadonlyMap<string, number>, group: Granularity, ascending: boolean): Group[] {
  const buckets = new Map<string, Group>()
  // createdAt is immutable. Equal times retain the incoming query order.
  const sorted = ids.map((id, index) => ({ id, index, time: dates.get(id) }))
    .sort((a, b) => {
      const av = a.time, bv = b.time
      const validA = av !== undefined && Number.isFinite(new Date(av).getTime())
      const validB = bv !== undefined && Number.isFinite(new Date(bv).getTime())
      if (!validA || !validB) return Number(validB) - Number(validA) || a.index - b.index
      return (ascending ? 1 : -1) * (av! - bv!) || a.index - b.index
    })
  for (const { id, time } of sorted) {
    const d = new Date(time ?? NaN), valid = Number.isFinite(d.getTime())
    const year = d.getFullYear(), month = d.getMonth() + 1, day = d.getDate()
    const key = valid ? `${group}:${year}${group !== 'year' ? '-' + month : ''}${group === 'day' ? '-' + day : ''}` : 'unknown'
    const label = valid ? `${year}年${group !== 'year' ? month + '月' : ''}${group === 'day' ? day + '日' : ''}` : '日期未知'
    if (!buckets.has(key)) buckets.set(key, { key, label, ids: [] })
    buckets.get(key)!.ids.push(id)
  }
  return [...buckets.values()]
}

export interface Row { top: number; height: number; group: Group; header: boolean; ids: string[] }
export function arrange(groups: Group[], collapsed: ReadonlySet<string>, width: number, size: number) {
  const inner = Math.max(1, width - 32), gap = 12
  const columns = Math.max(1, Math.floor((inner + gap) / (size + gap)))
  const cardWidth = (inner - (columns - 1) * gap) / columns
  const cardHeight = Math.round(cardWidth * 0.7) + 28
  const rows: Row[] = [], positions = new Map<string, number>()
  let top = 4
  for (const group of groups) {
    rows.push({ top, height: 48, group, header: true, ids: [] })
    for (const id of group.ids) positions.set(id, top)
    top += 48
    if (!collapsed.has(group.key)) {
      for (let i = 0; i < group.ids.length; i += columns) {
        const ids = group.ids.slice(i, i + columns)
        rows.push({ top, height: cardHeight + gap, group, header: false, ids })
        for (const id of ids) positions.set(id, top)
        top += cardHeight + gap
      }
    }
    top += 8
  }
  return { rows, positions, height: top + 12, cardWidth, cardHeight }
}
export function rowAt(rows: readonly Row[], top: number) {
  let lo = 0, hi = rows.length
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (rows[mid].top + rows[mid].height <= top) lo = mid + 1; else hi = mid }
  return Math.min(lo, Math.max(0, rows.length - 1))
}
export function readCollapsed(state?: Record<string, unknown>) {
  return new Set(Array.isArray(state?.collapsed) ? state.collapsed.filter((s): s is string => typeof s === 'string' && s.length < 80).slice(0, 512) : [])
}
