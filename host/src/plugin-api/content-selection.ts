/** 可持久化的内容位置。data 由 provider 的版本化契约解释，不保存 DOM 或屏幕坐标。 */
export interface ContentLocator { provider: string; version: number; data: Record<string, unknown> }
export interface ContentReference { sourceId: string; text: string; locator: ContentLocator }
export function isContentLocator(value: unknown): value is ContentLocator {
  const v = value as ContentLocator | undefined
  return !!v && typeof v.provider === 'string' && /^[a-z][a-z0-9-]*\.[a-z][a-z0-9.-]*$/.test(v.provider) && Number.isSafeInteger(v.version) && v.version > 0 && !!v.data && typeof v.data === 'object' && !Array.isArray(v.data)
}
export interface TextQuote { quote: string; prefix: string; suffix: string; offset: number }
/** 对齐文字片段；上下文优先，旧位置只用于区分重复内容。 */
export function findTextQuote(text: string, q: TextQuote): { from: number; to: number } | undefined {
  if (!q.quote) return
  let best: number | undefined, score = -Infinity
  for (let i = text.indexOf(q.quote);i >= 0;i = text.indexOf(q.quote, i + 1)) {
    let before = 0, after = 0
    while (before < q.prefix.length && i > before && text[i - before - 1] === q.prefix[q.prefix.length - before - 1]) before++
    while (after < q.suffix.length && text[i + q.quote.length + after] === q.suffix[after]) after++
    const next = before + after - Math.abs(i - q.offset) / (text.length + 1)
    if (next > score) { best = i; score = next }
  }
  return best === undefined ? undefined : { from: best, to: best + q.quote.length }
}
