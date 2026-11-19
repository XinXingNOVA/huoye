// 快速附加（设计文档 11.5）：窗口级的浮层，对当前标签页的焦点（选中的素材、正在播放的视频）附加数据。
// 输入 → 由数据块定义生成的建议 → 回车放入那条建议的查询。可以连续附加，Esc 关闭。

import { useEffect, useMemo, useState } from 'react'
import type { Query } from '../../../shared/query'
import type { UiHost } from '../plugin'
import { suggest, valueFields, type AttachContext, type Suggestion } from '../quick-attach'
import { kindOf, useKinds } from '../ui-registry'
import { isEnter } from '../widgets'

export function QuickAttach({ ids, host, onClose }: { ids: string[]; host: UiHost; onClose(): void }) {
  const kinds = useKinds()
  const [input, setInput] = useState('')
  const [values, setValues] = useState<AttachContext['values']>({})
  const [views, setViews] = useState<AttachContext['views']>([])
  const [active, setActive] = useState(0)
  const [log, setLog] = useState<{ text: string; ok: boolean }[]>([])
  // 每附加一次就重取：新建的标签要出现在建议里
  const [round, setRound] = useState(0)

  useEffect(() => {
    let alive = true
    const fields = valueFields(kinds)
    Promise.all(fields.map((f) => host.core.facet(f.kind, f.field).then((items) => [`${f.kind}.${f.field}`, items.map((i) => i.value)] as const))).then(
      (entries) => alive && setValues(Object.fromEntries(entries))
    )
    return () => {
      alive = false
    }
  }, [host, kinds, round])

  useEffect(() => {
    let alive = true
    host.core
      .query({ scope: 'all', has: ['view'], dir: 'asc' })
      .then((r) => host.core.get(r.ids))
      .then((list) => {
        if (!alive) return
        setViews(
          list.flatMap((v) => {
            const data = v.blocks.view?.data
            return data ? [{ id: v.id, title: String(data.title), query: (data.query ?? {}) as Query }] : []
          })
        )
      })
    return () => {
      alive = false
    }
  }, [host, round])

  const list = useMemo(() => suggest(input, { kinds, values, views, kindOf }), [input, kinds, values, views])
  useEffect(() => setActive(0), [input])

  const apply = async (s: Suggestion) => {
    setInput('')
    try {
      const { accepted, rejected } = await host.core.admit(ids, s.query)
      const reasons = [...new Set(rejected.map((r) => r.reason))].join('、')
      const text = rejected.length
        ? `${s.label}：${accepted.length} 项写上，${rejected.length} 项不满足：${reasons}`
        : `${s.label}${ids.length > 1 ? `（${accepted.length} 项）` : ''}`
      setLog((l) => [...l, { text, ok: !rejected.length }].slice(-4))
    } catch (e) {
      setLog((l) => [...l, { text: `${s.label}：${e instanceof Error ? e.message : String(e)}`, ok: false }].slice(-4))
    }
    setRound((r) => r + 1)
  }

  return (
    <div
      className="qa-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="quick-attach">
        <div className="qa-head muted">附加到 {ids.length} 项</div>
        <input
          className="qa-input"
          autoFocus
          value={input}
          placeholder="状态、标签、模板、字段名 值、配方…"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setActive((i) => Math.min(list.length - 1, i + 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setActive((i) => Math.max(0, i - 1))
            } else if (isEnter(e) && list[active]) {
              e.preventDefault()
              void apply(list[active])
            } else if (e.key === 'Escape') onClose()
          }}
        />
        {list.length > 0 ? (
          <ul className="qa-list">
            {list.map((s, i) => (
              <li
                key={s.key}
                className={i === active ? 'active' : ''}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => {
                  e.preventDefault()
                  void apply(s)
                }}
              >
                <span className="qa-label">{s.label}</span>
                <span className="muted">{s.target}</span>
              </li>
            ))}
          </ul>
        ) : (
          input && <div className="qa-empty muted">没有可以附加的。标签直接输入；其他字段写"字段名 值"</div>
        )}
        {log.length > 0 && (
          <div className="qa-log">
            {log.map((l, i) => (
              <div key={i} className={l.ok ? 'ok' : 'fail'}>
                {l.ok ? '✓' : '!'} {l.text}
              </div>
            ))}
          </div>
        )}
        <div className="qa-foot muted">↑↓ 选择 · 回车附加，可以连续附加 · Esc 关闭</div>
      </div>
    </div>
  )
}
