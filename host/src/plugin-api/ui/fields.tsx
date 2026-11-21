import { fieldTitle, enumTitle } from './locale'
import { uiText, useUiLocale } from '../../shared/i18n/interface-display'
// 值类型自带的编辑器（设计文档 11.4）：没有插件分区负责的数据块、表格的格子都用它们。
// 每种值类型知道怎么显示（widgets.tsx 的 FieldValue）、怎么编辑（这里）。

import { useEffect, useRef, useState } from 'react'
import type { BlockKind, EntityView, FieldDef } from '../../shared/blocks'
import type { UiHost } from './contracts'
import { useUiRuntime } from './internal/runtime'
import { AutoSaveText, FieldValue, isEnter } from './widgets'

/** 能手动编辑的数据块：不可重建、非内容类，插件也启用着（休眠的只能看）。 */
export const editable = (k: BlockKind | undefined): boolean => !!k && !k.rebuildable && !k.content && !k.dormant && !k.management

/** 改一个字段：在核心进程里合并，空值清空字段。 */
export function writeField(host: UiHost, view: EntityView, kind: string, field: string, value: unknown): Promise<void> {
  return host.core.patch(view.id, kind, { [field]: value ?? null })
}

/** 编辑起来要占一块地方的类型：在表格里弹出编辑，不在格子里就地改。 */
export const editsInPopover = (def: FieldDef) => def.type === 'enum' || def.type === 'longtext' || (def.list && def.type === 'text')

/** 直接在显示的地方操作的类型（勾选、点星星），不需要进入编辑。 */
export const editsInPlace = (def: FieldDef) => def.type === 'boolean' || def.format === 'rating'

export interface FieldEditorProps {
  optionLabel?(value: string): string
  def: FieldDef
  value: unknown
  onChange(value: unknown): void
  /** 单选、多选：新建一个选项（例如往模板里加）。不提供时只能从已有的选。 */
  onAddOption?(option: string): Promise<void>
  autoFocus?: boolean
  /** 结束编辑：回车、Esc、失焦（表格的格子用来退出编辑）。 */
  onDone?(): void
}

export function FieldEditor(p: FieldEditorProps) {
  const { def } = p
  if (def.type === 'enum') return <OptionsEditor {...p} />
  if (def.type === 'boolean') return <input type="checkbox" checked={!!p.value} onChange={(e) => p.onChange(e.target.checked ? true : undefined)} />
  if (def.format === 'rating') return <RatingEditor {...p} />
  if (def.type === 'longtext') return <AutoSaveText value={String(p.value ?? '')} rows={3} onSave={(t) => p.onChange(t || undefined)} />
  if (def.list && def.type === 'text') return <ListEditor {...p} />
  if (def.type === 'text' || def.type === 'number' || def.type === 'date') return <InputEditor {...p} />
  return <FieldValue def={def} value={p.value} />
}

const toDateInput = (ms: unknown) => {
  if (typeof ms !== 'number') return ''
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

const fromDateInput = (s: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime() : undefined
}

/** 单行输入：文本、链接、数字、日期。回车或失焦时保存（同一个值只存一次），Esc 放弃。 */
function InputEditor({ def, value, onChange, autoFocus, onDone }: FieldEditorProps) {
  useUiLocale()
  const runtime = useUiRuntime()
  const shown = def.type === 'date' ? toDateInput(value) : value === undefined || value === null ? '' : String(value)
  const [text, setText] = useState(shown)
  /** 最近一次存下的值：回车存过后失焦不再存一遍。外面的值变了就作废。 */
  const sent = useRef<unknown>(value)
  useEffect(() => {
    setText(shown)
    sent.current = value
  }, [shown])

  const parse = (t: string): { ok: boolean; next?: unknown } => {
    if (!t) return { ok: true, next: undefined }
    if (def.type === 'number') {
      const n = Number(t)
      return Number.isFinite(n) ? { ok: true, next: n } : { ok: false }
    }
    if (def.type === 'date') return { ok: true, next: fromDateInput(t) }
    return { ok: true, next: t }
  }

  const commit = () => {
    const { ok, next } = parse(text.trim())
    if (!ok) setText(shown)
    else if (next !== (sent.current ?? undefined)) {
      sent.current = next
      onChange(next)
    }
    onDone?.()
  }

  const cancel = () => {
    setText(shown)
    onDone?.()
  }

  return (
    <span className="field-input">
      <input
        className="field-text"
        type={def.type === 'number' ? 'number' : def.type === 'date' ? 'date' : 'text'}
        value={text}
        autoFocus={autoFocus}
        placeholder={def.format === 'url' ? 'https://' : ''}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (isEnter(e)) commit()
          else if (e.key === 'Escape') cancel()
        }}
        onBlur={commit}
      />
      {def.format === 'url' && typeof value === 'string' && /^https?:\/\//.test(value) && (
        <button className="field-open" title={uiText("在浏览器中打开")} onMouseDown={(e) => e.preventDefault()} onClick={() => runtime.openExternal(value)}>
          ↗
        </button>
      )}
    </span>
  )
}

/** 单选、多选：选项是一排按钮；可以新建选项。 */
function OptionsEditor({ def, value, onChange, onAddOption, onDone, optionLabel }: FieldEditorProps) {
  useUiLocale()
  const options = def.options ?? []
  const selected = def.list ? ((value as string[] | undefined) ?? []) : value === undefined ? [] : [String(value)]
  const [adding, setAdding] = useState<string>()
  const [addError, setAddError] = useState('')

  const toggle = (o: string) => {
    if (def.list) onChange(selected.includes(o) ? selected.filter((x) => x !== o) : [...selected, o])
    else {
      onChange(selected[0] === o ? undefined : o)
      onDone?.()
    }
  }

  const add = async (name: string) => {
    const o = name.trim()
    setAdding(undefined)
    if (!o || !onAddOption) return
    setAddError('')
    try { if (!options.includes(o)) await onAddOption(o) }
    catch (error) { setAddError(error instanceof Error ? error.message : String(error)); return }
    // 新建的选项直接选上
    if (def.list) onChange(selected.includes(o) ? selected : [...selected, o])
    else onChange(o)
  }

  return (
    <div className="field-options">
      {options.map((o) => (
        <button key={o} className={`field-option${selected.includes(o) ? ' active' : ''}`} onClick={() => toggle(o)}>
          {optionLabel?.(o) ?? o}
        </button>
      ))}
      {onAddOption &&
        (adding === undefined ? (
          <button className="field-option add" title={uiText("新建选项")} onClick={() => setAdding('')}>
            +
          </button>
        ) : (
          <input
            className="field-text option-input"
            autoFocus
            value={adding}
            placeholder={uiText("新选项，回车")}
            onChange={(e) => setAdding(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (isEnter(e)) void add(adding)
              else if (e.key === 'Escape') setAdding(undefined)
            }}
            onBlur={() => setAdding(undefined)}
          />
        ))}
      {addError && <p role="alert">{addError}</p>}
      {!options.length && !onAddOption && <span className="muted">{uiText("没有选项")}</span>}
    </div>
  )
}

/** 评分：点第 n 颗星设为 n，再点同一颗清除。 */
function RatingEditor({ def, value, onChange }: FieldEditorProps) {
  const max = def.max ?? 5
  const current = typeof value === 'number' ? value : 0
  const [hover, setHover] = useState(0)
  return (
    <span className="rating" onMouseLeave={() => setHover(0)}>
      {Array.from({ length: max }, (_, i) => i + 1).map((n) => (
        <button
          key={n}
          className={`star${n <= (hover || current) ? ' on' : ''}`}
          onMouseEnter={() => setHover(n)}
          onClick={(e) => {
            e.stopPropagation()
            onChange(n === current ? undefined : n)
          }}
        >
          ★
        </button>
      ))}
    </span>
  )
}

/** 文本列表：一串可以移除的小块，加一个输入框。 */
function ListEditor({ value, onChange }: FieldEditorProps) {
  useUiLocale()
  const values = (value as string[] | undefined) ?? []
  const [input, setInput] = useState('')
  const add = () => {
    const v = input.trim()
    setInput('')
    if (v && !values.includes(v)) onChange([...values, v])
  }
  return (
    <div className="field-options">
      {values.map((v) => (
        <span key={v} className="chip">
          <span className="chip-label">{v}</span>
          <button className="chip-x" onClick={() => onChange(values.filter((x) => x !== v))}>
            ×
          </button>
        </span>
      ))}
      <input
        className="field-text option-input"
        value={input}
        placeholder={uiText("添加，回车")}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (isEnter(e)) add()
        }}
        onBlur={add}
      />
    </div>
  )
}

/** 一整块数据块的编辑：按定义的字段顺序，每个字段一行。 */
export function BlockEditor({
  kind,
  view,
  host,
  onAddOption
}: {
  kind: BlockKind
  view: EntityView
  host: UiHost
  onAddOption?(field: string, option: string): Promise<void>
}) {
  useUiLocale()
  const data = view.blocks[kind.id]?.data ?? {}
  const fields = Object.entries(kind.fields)
  if (!fields.length) return <div className="muted">{uiText("还没有字段")}</div>
  return (
    <dl className="props block-editor">
      {fields.map(([name, def]) => (
        <div key={name} className="prop-row">
          <dt title={fieldTitle(kind, name)}>{fieldTitle(kind, name)}</dt>
          <dd>
            <FieldEditor
              def={def}
              optionLabel={v => enumTitle(kind, name, v)}
              value={data[name]}
              onChange={(v) => void writeField(host, view, kind.id, name, v)}
              onAddOption={onAddOption && ((o) => onAddOption(name, o))}
            />
          </dd>
        </div>
      ))}
    </dl>
  )
}
