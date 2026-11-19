// 改字段类型时，一个值怎么从旧类型变成新类型。转换不了的返回 undefined（这个值会被清空，可以撤销）。

import type { FieldSpec } from '../blocks'

const TRUE = new Set(['是', 'true', '1', 'yes', 'y', '✓', '√', '对'])
const FALSE = new Set(['否', 'false', '0', 'no', 'n', '✗', '×', '不'])

const pad = (n: number) => String(n).padStart(2, '0')

/** 一个值的文本形式（单选的选项、文本里的写法）。 */
export function textOf(v: unknown, from: FieldSpec): string | undefined {
  if (v === undefined || v === null) return undefined
  if (from.type === 'date' && typeof v === 'number') {
    const d = new Date(v)
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  }
  if (typeof v === 'boolean') return v ? '是' : '否'
  const s = String(v).trim()
  return s || undefined
}

/** 值拆成一个个单项：多选是多个，其余是一个。 */
export const itemsOf = (v: unknown): unknown[] =>
  (Array.isArray(v) ? v : [v]).filter((x) => x !== undefined && x !== null && x !== '')

export function convertValue(value: unknown, from: FieldSpec, to: FieldSpec): unknown {
  const items = itemsOf(value)
  if (!items.length) return undefined
  const texts = items.map((v) => textOf(v, from)).filter((s): s is string => !!s)
  const first = items[0]

  switch (to.type) {
    case 'text':
    case 'longtext':
    case 'url':
      return texts.length ? texts.join('、') : undefined
    case 'select':
      return texts[0] !== undefined && (to.options ?? []).includes(texts[0]) ? texts[0] : undefined
    case 'multi': {
      const vs = [...new Set(texts)].filter((t) => (to.options ?? []).includes(t))
      return vs.length ? vs : undefined
    }
    case 'number':
    case 'rating': {
      let n: number | undefined
      if (typeof first === 'number' && from.type !== 'date') n = first
      else if (typeof first === 'string') n = first.trim() === '' ? undefined : Number(first.trim())
      if (n === undefined || !Number.isFinite(n)) return undefined
      if (to.type === 'rating') {
        n = Math.round(n)
        if (n < 1 || n > (to.max ?? 5)) return undefined
      }
      return n
    }
    case 'checkbox': {
      if (typeof first === 'boolean') return first
      if (typeof first === 'number') return first !== 0
      const t = String(first).trim().toLowerCase()
      return TRUE.has(t) ? true : FALSE.has(t) ? false : undefined
    }
    case 'date': {
      if (from.type === 'date' && typeof first === 'number') return first
      if (typeof first !== 'string') return undefined
      const m = /^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})/.exec(first.trim())
      return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime() : undefined
    }
  }
}
