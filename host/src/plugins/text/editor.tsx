import { uiText, useUiLocale } from '../../shared/i18n/interface-display'
import { useUiFrame } from '../../plugin-api/ui/hooks'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { EntityView } from '../../shared/blocks'
import type { UiHost } from '../../plugin-api/ui/contracts'
import { wikiLinkText } from '../../shared/wikilink'
import { caretXY, findTrigger, LinkPicker, usePickerItems, type Trigger } from './picker'
import type { EditSession } from '../../plugin-api/ui/editing'
export interface EditorPosition { start: number; end: number; scroll: number }
const noSubscribe = () => () => {}
const noSnapshot = () => undefined
const SAVE_AFTER = 800
/**
 * 编辑 Markdown 源文。普通数据块自动保存；版本文件使用 manual，由上层显式保存。
 * 输入框保留文字撤销；已经保存的版本文件由空间历史恢复，不参与普通仓库撤销。
 */
export function Editor({
  self,
  host,
  initial,
  save,
  done,
  note, manual = false, onDraft, actions, readOnly = false, session, position, onPosition
}: {
  session?: EditSession
  position?: EditorPosition
  onPosition?(value: EditorPosition): void
  self: string
  host: UiHost
  initial: string
  save(content: string): void
  done(): void
  note?: string
  manual?: boolean
  onDraft?(text: string): void
  actions?: React.ReactNode
  readOnly?: boolean
}) {
  useUiLocale()
  const nextFrame = useUiFrame()
  const [localText, setText] = useState(initial)
  const shared = useSyncExternalStore(session?.subscribe ?? noSubscribe, session?.snapshot ?? noSnapshot)
  const text = shared?.text ?? localText
  const latest = useRef(text)
  latest.current = text
  const saved = useRef(initial)
  const locked = useRef(readOnly)
  locked.current = readOnly
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const saveRef = useRef(save)
  saveRef.current = save
  const area = useRef<HTMLTextAreaElement>(null)
  const ownInput = useRef(false)
  const composing = useRef(false)
  useEffect(() => { if (area.current && session) return host.editing.bindInput(area.current, session, { syncChanges: true }) }, [host.editing, session])

  const flush = () => {
    clearTimeout(timer.current)
    if (session) { void session.save().catch(() => {}); return }
    if (locked.current || (!manual && latest.current === saved.current)) return
    if (!manual) saved.current = latest.current
    saveRef.current(latest.current)
  }
  // 卸下时（切到别的标签页不会卸下；换一篇、关掉会）把没保存的存上
  useEffect(() => () => { if (!manual && !session) flush() }, [])

  const change = (value: string) => {
    if (locked.current) return
    ownInput.current = true
    if (session) { session.change(value); return }
    setText(value)
    latest.current = value
    onDraft?.(value)
    clearTimeout(timer.current)
    if (!manual) timer.current = setTimeout(flush, SAVE_AFTER)
  }
  /** 把 [from, to) 换成一段字，光标放到后面。 */
  const replace = (from: number, to: number, insert: string) => {
    if (locked.current) return
    const value = latest.current
    change(value.slice(0, from) + insert + value.slice(to))
    const caret = from + insert.length
    nextFrame(() => {
      area.current?.focus()
      area.current?.setSelectionRange(caret, caret)
    })
  }

  const localPosition = useRef(position)
  const reportPosition = (el: HTMLTextAreaElement) => {
    localPosition.current = { start: el.selectionStart, end: el.selectionEnd, scroll: el.scrollTop }
    onPosition?.(localPosition.current)
  }
  const positioned = useRef(false)
  useLayoutEffect(() => {
    const el = area.current
    if (!el || composing.current) return
    const p = !positioned.current ? localPosition.current : { start: el.selectionStart, end: el.selectionEnd, scroll: el.scrollTop }
    positioned.current = true
    const nativeInput = ownInput.current && el.value === text
    ownInput.current = false
    if (nativeInput) return
    // 由会话更新 DOM 前采样本页光标；受控 value 会先把失焦 textarea 的光标移到末尾。
    if (el.value !== text) el.value = text
    if (p) { el.setSelectionRange(Math.min(p.start, text.length), Math.min(p.end, text.length)); el.scrollTop = p.scroll }
  }, [text])

  // ---------- [[ 选择器 ----------
  const [trigger, setTrigger] = useState<Trigger>()
  const [index, setIndex] = useState(0)
  /** Esc 关掉的那一个：光标还在它后面时不再弹出来。 */
  const dismissed = useRef<number>(undefined)
  const items = usePickerItems(host, trigger?.query, self)
  const sync = (el: HTMLTextAreaElement) => {
    const t = findTrigger(el.value, el.selectionStart)
    if (!t) dismissed.current = undefined
    if (!t || t.start === dismissed.current) return setTrigger(undefined)
    if (t.start !== trigger?.start || t.query !== trigger.query) setIndex(0)
    setTrigger(t)
  }
  const at = useMemo(() => {
    if (!trigger || !area.current) return undefined
    const c = caretXY(area.current, trigger.start)
    return { x: Math.min(c.x, area.current.clientWidth - 320), y: c.y + c.h + 4 }
  }, [trigger?.start, text])
  const pick = (v: EntityView) => {
    if (!trigger || !area.current) return
    replace(trigger.start, area.current.selectionStart, wikiLinkText(v.id, host.title(v), trigger.embed))
    setTrigger(undefined)
  }

  // ---------- 把卡片拖进来：插入链接（图片、视频这类插入嵌入） ----------
  const dragging = (e: React.DragEvent) => {
    const types = [...e.dataTransfer.types]
    if (!types.includes('Files') && !types.includes('application/x-rm-entities')) return
    e.preventDefault()
    e.stopPropagation()
  }
  const drop = (e: React.DragEvent) => {
    if (locked.current) { e.preventDefault(); e.stopPropagation(); return }
    const ids = host.idsFromDrop(e.dataTransfer)
    // 不是库里的东西：交给窗口照常收录
    if (!ids.length) return
    e.preventDefault()
    e.stopPropagation()
    const caret = area.current?.selectionStart ?? latest.current.length
    void host.core.get(ids).then((views) => {
      const parts = views.map((v) => {
        const embed = !v.blocks.text && !v.blocks.body
        return { text: wikiLinkText(v.id, host.title(v), embed), embed }
      })
      // 嵌入各占一行
      const insert = parts.map((p) => (p.embed ? `\n${p.text}\n` : p.text)).join(' ')
      replace(caret, caret, insert)
    })
  }

  return (
    <>
      {actions}
      {note && <div className="reader-note">{note}</div>}
      <div className="editor-wrap">
      <textarea
        ref={area}
        className="reader-editor"
        readOnly={readOnly}
        autoFocus
        defaultValue={initial}
        spellCheck={false}
        onCompositionStart={() => { composing.current = true }}
        onCompositionEnd={e => { composing.current = false; reportPosition(e.currentTarget) }}
        placeholder={uiText("写点什么……（Markdown：# 标题、**加粗**、- 列表、> 引用；[[ 链接到别的素材，![[ 嵌入）")}
        onChange={(e) => {
          reportPosition(e.target)
          change(e.target.value)
          sync(e.target)
        }}
        onSelect={(e) => { sync(e.currentTarget); reportPosition(e.currentTarget) }}
        onScroll={e => reportPosition(e.currentTarget)}
        onBlur={() => {
          if (!manual) flush()
          setTrigger(undefined)
        }}
        onDragEnter={dragging}
        onDragOver={dragging}
        onDrop={drop}
        onKeyDown={(e) => {
          const mod = e.metaKey || e.ctrlKey
          if (session && mod && (e.key.toLowerCase() === 'z' || e.key.toLowerCase() === 'y') && !e.nativeEvent.isComposing) {
            e.preventDefault(); e.stopPropagation()
            if (e.shiftKey || e.key.toLowerCase() === 'y') session.redo(); else session.undo()
            return
          }
          if (trigger) {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault()
              if (items.length) setIndex((i) => (i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length)
              return
            }
            if ((e.key === 'Enter' || e.key === 'Tab') && items[index] && !e.nativeEvent.isComposing) {
              e.preventDefault()
              pick(items[index])
              return
            }
            if (e.key === 'Escape') {
              e.preventDefault()
              e.stopPropagation()
              dismissed.current = trigger.start
              setTrigger(undefined)
              return
            }
          }
          if (e.key === 'Escape' || (mod && e.key === 'Enter')) {
            e.preventDefault()
            e.stopPropagation()
            if (!manual) flush()
            done()
          } else if (mod && e.key === 's') {
            e.preventDefault()
            flush()
          }
        }}
      />
      {trigger && at && <LinkPicker host={host} trigger={trigger} items={items} index={index} at={at} pick={pick} />}
      </div>
    </>
  )
}
