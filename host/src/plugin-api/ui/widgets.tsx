import { uiText, useUiLocale } from '../../shared/i18n/interface-display'
// 插件界面可以复用的小部件，以及值类型的默认呈现。

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useUiDocument } from './internal/document'
export { useUiDocument } from './internal/document'
import { createPortal } from 'react-dom'
import { useUiEffect } from './hooks'
import { useUiRuntime } from './internal/runtime'
import type { FieldDef } from '../../shared/blocks'
import { formatBytes, formatDuration } from '../../shared/format'

export { formatBytes, formatDuration }
export { SettingGroup, SettingRow } from './internal/setting-rows'

/**
 * 回车提交。用输入法打中文时，确认候选词的那一下回车不算：那时词还没上屏。
 */
export const isEnter = (e: React.KeyboardEvent) => e.key === 'Enter' && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229



export function formatDate(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 值类型的默认显示。 */
export function FieldValue({ def, value, optionLabel }: { def?: FieldDef; value: unknown; optionLabel?(value: string): string }) {
  useUiLocale()
  const runtime = useUiRuntime()
  if (value === undefined || value === null) return <span className="muted">—</span>
  if (Array.isArray(value)) {
    return (
      <span className="values">
        {value.map((v, i) => (
          <FieldValue key={i} def={def ? { ...def, list: false } : undefined} value={v} optionLabel={optionLabel} />
        ))}
      </span>
    )
  }
  switch (def?.type) {
    case 'enum':
      return <span className="value">{optionLabel?.(String(value)) ?? String(value)}</span>
    case 'color':
      return <span className="swatch-inline" style={{ background: String(value) }} title={String(value)} />
    case 'boolean':
      return <span>{value ? uiText("是") : uiText("否")}</span>
    case 'date':
      return <span>{formatDate(Number(value))}</span>
    case 'number':
      if (def.format === 'rating') {
        const n = Math.round(Number(value))
        return (
          <span className="rating-value" title={`${n} / ${def.max ?? 5}`}>
            {'★'.repeat(n)}
            <span className="rating-rest">{'★'.repeat(Math.max(0, (def.max ?? 5) - n))}</span>
          </span>
        )
      }
      if (def.format === 'duration') return <span>{formatDuration(Number(value))}</span>
      if (def.format === 'bytes') return <span>{formatBytes(Number(value))}</span>
      if (def.format === 'px') return <span>{String(value)} px</span>
      return <span className="value">{String(value)}</span>
    case 'json':
      return <code>{JSON.stringify(value)}</code>
    case 'text':
      if (def.format === 'url' && /^https?:\/\//.test(String(value))) {
        return (
          <a
            className="value link"
            href={String(value)}
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              runtime.openExternal(String(value))
            }}
          >
            {String(value)}
          </a>
        )
      }
      return <span className="value">{String(value)}</span>
    default:
      return <span className="value">{typeof value === 'object' ? JSON.stringify(value) : String(value)}</span>
  }
}

/** 自动保存的文本框：停止输入 500ms 或失去焦点时保存。 */
export function AutoSaveText({
  value,
  placeholder,
  onSave,
  rows = 4
}: {
  value: string
  placeholder?: string
  onSave(text: string): void
  rows?: number
}) {
  const [text, setText] = useState(value)
  const latest = useRef(value)
  const dirty = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const save = useRef(onSave)
  save.current = onSave

  // 外部数据变化且本地没有未保存的修改时，同步过来
  useEffect(() => {
    if (!dirty.current) {
      setText(value)
      latest.current = value
    }
  }, [value])

  const flush = () => {
    clearTimeout(timer.current)
    if (!dirty.current) return
    dirty.current = false
    save.current(latest.current)
  }

  // 卸载时（例如切换到别的素材）把没保存的内容存掉
  useEffect(() => flush, [])

  return (
    <textarea
      className="autosave"
      rows={rows}
      value={text}
      placeholder={placeholder}
      onChange={(e) => {
        setText(e.target.value)
        latest.current = e.target.value
        dirty.current = true
        clearTimeout(timer.current)
        timer.current = setTimeout(flush, 500)
      }}
      onBlur={flush}
    />
  )
}

export { acceleratorLabel } from '../../shared/accelerators'

/** 将浮层放到所属内容的显示文档；不跟随其他页面抢走显示位置。 */
export function UiPortal({ children }: { children: ReactNode }) {
  return createPortal(children, useUiDocument().body)
}

/** 盖住整个窗口的透明层：点外面关闭，Esc 关闭。 */
export function Overlay({ children, onClose }: { children: ReactNode; onClose(): void }) {
  useUiEffect(display => {
    display.onWindow('keydown', e => { if (e.key === 'Escape') onClose() }, true)
  }, [onClose])
  return <UiPortal><div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>{children}</div></UiPortal>
}
