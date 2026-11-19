// 全文搜索里核心进程与界面共用的部分：怎么把输入分成词，怎么在一段文字里找出这些词。

/** 用户输入的一串文字 → 词（按空白分开）。 */
export function searchTerms(input: string | undefined): string[] {
  return (input ?? '')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean)
}

/** 一段文字里所有词出现的位置（忽略大小写；不重叠，按先后）。 */
export function marksIn(text: string, terms: string[]): [number, number][] {
  const lower = text.toLowerCase()
  const marks: [number, number][] = []
  for (const t of terms.map((x) => x.toLowerCase())) {
    for (let i = lower.indexOf(t); i >= 0; i = lower.indexOf(t, i + t.length)) marks.push([i, i + t.length])
  }
  marks.sort((a, b) => a[0] - b[0] || b[1] - a[1])
  return marks.filter((m, i) => i === 0 || m[0] >= marks[i - 1][1])
}
