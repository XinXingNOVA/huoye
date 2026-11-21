import { uiText } from '../../../shared/i18n/interface-display'
import { t, useLanguage } from '../language'
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
  selection: 1, intake: 2, presets: 3, saved: 4, pages: 5, navigation: 6,
  panels: 7, workspace: 8, layouts: 9, plugins: 10, settings: 11, pluginSettings: 12
}

function categoryRank(category: string | undefined, hasSelection: boolean): number {
  if (category === 'selection') return hasSelection ? 0 : 20
  return category ? CATEGORY_ORDER[category] ?? 7 : 7
}

export function CommandPalette({ session, host, onCancel, onExecute }: Props) {
  const { locale } = useLanguage()
  const previousLocale = useRef(locale)
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
    if (previousLocale.current !== locale || refreshTick && (refreshRequest.current?.session !== session || refreshRequest.current.tick !== refreshTick)) {
      previousLocale.current = locale
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
  }, [session, query, refreshTick, locale])

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
      const rankDiff = categoryRank(a.categoryId, hasSelection) - categoryRank(b.categoryId, hasSelection)
      if (rankDiff !== 0) return rankDiff
      return 0
    })
    return copy
  }, [items, query, hasSelection])

  const groups = useMemo(() => {
    const map = new Map<string, CommandItem[]>()
    for (const item of ordered) {
      const key = item.category || t('palette.command')
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
      host.notify(item.disabledReason ?? uiText("此命令当前不可用"))
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
        aria-label={t('palette.title')}
        onKeyDown={onKeyDown}
      >
        <div className="command-palette-header">
          <SearchCommandIcon size={17} className="command-palette-search-icon" />
          <input
            ref={inputRef}
            type="search"
            className="command-palette-input"
            placeholder={t('palette.hint')}
            value={query}
            onChange={e => setQuery(e.target.value)}
            aria-label={t('palette.search')}
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={displayed[activeIndex] ? `${listId}-${activeIndex}` : undefined}
          />
          {hasSelection && (
            <span className="command-context-pill selection" title={t('palette.snap')}>
              <SparklesIcon size={12} />
              {t('palette.selected', { count: session.context.ids.length })}
            </span>
          )}
          <button
            type="button"
            className="command-palette-close"
            aria-label={t('palette.close')}
            title={t('palette.esc')}
            onClick={onCancel}
          >
            <CloseIcon size={15} />
          </button>
        </div>

        {error && (
          <div className="command-palette-error" role="alert">
            <span>{error}</span>
            <button type="button" className="small" onClick={refresh}>
              {t('palette.retry')}
            </button>
          </div>
        )}

        <div className="command-palette-list" ref={listRef} id={listId} role="listbox" aria-label={t('palette.list')}>
          {loading && <div className="command-palette-empty muted" role="status">{t('palette.loading')}</div>}
          {!loading && !displayed.length && !error && (
            <div className="command-palette-empty muted">{t('palette.empty')}</div>
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
            <kbd>↑</kbd> <kbd>↓</kbd> {t('palette.select')}
          </span>
          <span>
            <kbd>↵</kbd> {t('palette.run')}
          </span>
          <span>
            <kbd>{acceleratorLabel('CmdOrCtrl+R')}</kbd> {t('palette.refresh')}
          </span>
          <span>
            <kbd>Esc</kbd> {t('palette.dismiss')}
          </span>
        </div>
      </div>
    </div>
  )
}
