import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { CommandItem, CommandSession } from '../../../plugin-api/ui/commands'
import { useModalFocus } from './modal-focus'
import type { UiHost } from '../plugin'
import { acceleratorLabel, isEnter } from '../widgets'
import { CloseIcon, SearchCommandIcon, SparklesIcon } from './icons'

interface Props {
  session: CommandSession
  host: UiHost
  onCancel(): void
  onExecute(session: CommandSession, item: CommandItem): void
}

const CATEGORY_ORDER: Record<string, number> = {
  选中素材: 1,
  创建与导入: 2,
  预设视图: 3,
  保存的视图: 4,
  已打开页面: 5,
  导航: 6,
  侧栏面板: 7,
  工作台: 8,
  工作台布局: 9,
  插件: 10,
  设置: 11
}

function categoryRank(category: string, hasSelection: boolean): number {
  if (category === '选中素材') return hasSelection ? 0 : 20
  if (category in CATEGORY_ORDER) return CATEGORY_ORDER[category]
  if (category.startsWith('插件设置')) return 12
  return 7
}

export function CommandPalette({ session, host, onCancel, onExecute }: Props) {
  const listId = useId()
  const [query, setQuery] = useState('')
  const [items, setItems] = useState<readonly CommandItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  useModalFocus(rootRef)
  const [refreshTick, setRefreshTick] = useState(0)
  const refreshRequest = useRef<{ session: CommandSession; tick: number; promise: ReturnType<CommandSession['refresh']> }>(undefined)
  const listRef = useRef<HTMLDivElement>(null)
  const hasSelection = session.context.ids.length > 0

  useEffect(() => {
    let alive = true
    setLoading(true)
    setError('')
    setItems([])
    if (refreshTick && (refreshRequest.current?.session !== session || refreshRequest.current.tick !== refreshTick)) {
      refreshRequest.current = { session, tick: refreshTick, promise: session.refresh() }
    }
    void (async () => { if (refreshRequest.current?.session === session) await refreshRequest.current.promise; return session.list(query) })().then(
      rows => {
        if (!alive) return
        setItems(rows)
        setLoading(false)
      },
      err => {
        if (!alive) return
        setError(err instanceof Error ? err.message : String(err))
        setLoading(false)
      }
    )
    return () => {
      alive = false
    }
  }, [session, query, refreshTick])

  const refresh = () => setRefreshTick(n => n + 1)

  const ordered = useMemo(() => {
    const q = query.trim().toLocaleLowerCase()
    const copy = [...items]
    copy.sort((a, b) => {
      if (a.enabled !== b.enabled) return a.enabled ? -1 : 1
      if (q) {
        const aExact = a.title.toLocaleLowerCase().startsWith(q) ? 0 : 1
        const bExact = b.title.toLocaleLowerCase().startsWith(q) ? 0 : 1
        if (aExact !== bExact) return aExact - bExact
      }
      const rankDiff = categoryRank(a.category, hasSelection) - categoryRank(b.category, hasSelection)
      if (rankDiff !== 0) return rankDiff
      return 0
    })
    return copy
  }, [items, query, hasSelection])

  const groups = useMemo(() => {
    const map = new Map<string, CommandItem[]>()
    for (const item of ordered) {
      const key = item.category || '命令'
      const group = map.get(key)
      if (group) group.push(item)
      else map.set(key, [item])
    }
    return [...map.entries()]
  }, [ordered])

  // 渲染、鼠标高亮和键盘执行共用分组后的同一序列。
  const displayed = useMemo(() => groups.flatMap(([, rows]) => rows), [groups])

  useEffect(() => {
    const firstEnabled = displayed.findIndex(item => item.enabled)
    setActiveIndex(firstEnabled >= 0 ? firstEnabled : 0)
  }, [displayed])

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-command-index="${activeIndex}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  const trigger = (item: CommandItem | undefined) => {
    if (!item || loading || error) return
    if (!item.enabled) {
      host.notify(item.disabledReason ?? '此命令当前不可用')
      return
    }
    onExecute(session, item)
  }

  const onKeyDown = (e: KeyboardEvent) => {
    e.stopPropagation()
    if (e.nativeEvent.isComposing || e.keyCode === 229) return
    if (e.key === 'Escape') {
      e.preventDefault()
      onCancel()
      return
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'r') {
      e.preventDefault()
      refresh()
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (displayed.length) setActiveIndex(i => (i + 1) % displayed.length)
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (displayed.length) setActiveIndex(i => (i - 1 + displayed.length) % displayed.length)
      return
    }
    if (isEnter(e) && e.target === inputRef.current) {
      e.preventDefault()
      trigger(displayed[activeIndex])
    }
  }

  let flatIndex = -1

  return (
    <div
      className="qa-backdrop command-palette-backdrop"
      onMouseDown={e => {
        if (e.target === e.currentTarget) onCancel()
      }}
    >
      <div
        className="command-palette"
        ref={rootRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="命令面板"
        onKeyDown={onKeyDown}
      >
        <div className="command-palette-header">
          <SearchCommandIcon size={17} className="command-palette-search-icon" />
          <input
            ref={inputRef}
            type="search"
            className="command-palette-input"
            placeholder="搜索命令、跳转视图、执行素材操作或直达设置…"
            value={query}
            onChange={e => setQuery(e.target.value)}
            aria-label="搜索命令"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={displayed[activeIndex] ? `${listId}-${activeIndex}` : undefined}
          />
          {hasSelection && (
            <span className="command-context-pill selection" title="打开命令面板时已固定原选中素材快照">
              <SparklesIcon size={12} />
              已选 {session.context.ids.length} 项
            </span>
          )}
          <button
            type="button"
            className="command-palette-close"
            aria-label="关闭命令面板"
            title="关闭 (Esc)"
            onClick={onCancel}
          >
            <CloseIcon size={15} />
          </button>
        </div>

        {error && (
          <div className="command-palette-error" role="alert">
            <span>{error}</span>
            <button type="button" className="small" onClick={refresh}>
              重试
            </button>
          </div>
        )}

        <div className="command-palette-list" ref={listRef} id={listId} role="listbox" aria-label="可用命令">
          {loading && <div className="command-palette-empty muted" role="status">读取命令…</div>}
          {!loading && !displayed.length && !error && (
            <div className="command-palette-empty muted">没有匹配的命令，换个关键词试试</div>
          )}
          {groups.map(([category, groupItems]) => (
            <div key={category} className="command-group">
              <div className="command-group-title">{category}</div>
              {groupItems.map(item => {
                flatIndex++
                const index = flatIndex
                const isSelected = index === activeIndex
                return (
                  <button
                    key={item.id}
                    id={`${listId}-${index}`}
                    type="button"
                    role="option"
                    tabIndex={-1}
                    aria-selected={isSelected}
                    aria-disabled={!item.enabled}
                    data-command-id={item.id}
                    data-command-index={index}
                    className={`command-item${isSelected ? ' active' : ''}${item.danger ? ' danger' : ''}${item.enabled ? '' : ' disabled'}`}
                    onMouseEnter={() => setActiveIndex(index)}
                    onFocus={() => setActiveIndex(index)}
                    onClick={() => trigger(item)}
                  >
                    <span className="command-item-title">{item.title}</span>
                    <span className="command-item-meta">
                      {!item.enabled && item.disabledReason && (
                        <span className="command-disabled-reason">{item.disabledReason}</span>
                      )}
                      {item.accelerator && (
                        <kbd className="command-kbd">{acceleratorLabel(item.accelerator)}</kbd>
                      )}
                    </span>
                  </button>
                )
              })}
            </div>
          ))}
        </div>

        <div className="command-palette-footer muted">
          <span>
            <kbd>↑</kbd> <kbd>↓</kbd> 选择
          </span>
          <span>
            <kbd>↵</kbd> 执行
          </span>
          <span>
            <kbd>{acceleratorLabel('CmdOrCtrl+R')}</kbd> 刷新
          </span>
          <span>
            <kbd>Esc</kbd> 关闭
          </span>
        </div>
      </div>
    </div>
  )
}
