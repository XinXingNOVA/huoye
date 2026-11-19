export function readOptions(value: Record<string, unknown>) {
  return { fit: value.fit === 'cover' ? 'cover' as const : 'contain' as const, strip: value.strip === 'right' ? 'right' as const : 'bottom' as const }
}
export function locate(ids: readonly string[], current?: string, previousIndex = 0) {
  if (!ids.length) return { id: undefined, index: -1 }
  const found = current ? ids.indexOf(current) : -1
  const index = found >= 0 ? found : Math.max(0, Math.min(ids.length - 1, Number.isFinite(previousIndex) ? Math.floor(previousIndex) : 0))
  return { id: ids[index], index }
}
export function windowRange(total: number, offset: number, extent: number, step: number) {
  return { first: Math.max(0, Math.floor(offset / step) - 3), last: Math.min(total, Math.ceil((offset + extent) / step) + 3) }
}
