import { createContext, useContext, useMemo, useState, type ReactNode, type Dispatch, type SetStateAction } from 'react'
import type { UiHost } from '@resource-manager/plugin-api/ui/contracts'
import type { Book, Bookmark } from './model'

export interface ReaderSession {
  token: string; id: string; book: Book; chapter: number; bookmarks: Bookmark[]
  go(chapter: number, offset?: number, anchor?: string): void
}
const Context = createContext<{ current: ReaderSession | null; setCurrent: Dispatch<SetStateAction<ReaderSession | null>> } | null>(null)
export function ReaderProvider({ children }: { children: ReactNode; host: UiHost }) {
  const [current, setCurrent] = useState<ReaderSession | null>(null)
  const value = useMemo(() => ({ current, setCurrent }), [current])
  return <Context.Provider value={value}>{children}</Context.Provider>
}
export function useReaderSession() {
  const context = useContext(Context)
  if (!context) throw new Error('电子书窗口上下文未挂载')
  return context
}
export function BookIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M3 4h6a4 4 0 0 1 3 1.5A4 4 0 0 1 15 4h6v15h-6a4 4 0 0 0-3 1.5A4 4 0 0 0 9 19H3zM12 5.5v15"/></svg>
}
export function ContentsPanel({ host }: { host: UiHost; active: boolean }) {
  const { current } = useReaderSession()
  const [mode, setMode] = useState<'toc' | 'bookmarks'>('toc')
  if (!current) return <div className="epub-empty"><BookIcon/><p>打开一本 EPUB</p><span>这里会显示当前书籍的目录和书签。</span></div>
  const { book, bookmarks, go, chapter, id } = current
  return <div className="epub-directory">
    <header><span className="epub-eyebrow">正在阅读</span><strong>{book.title}</strong><span>{book.author || '作者未注明'}</span></header>
    <div className="epub-segments" aria-label="书籍导航">
      <button type="button" aria-pressed={mode === 'toc'} onClick={() => setMode('toc')}>目录 <small>{book.chapters.length}</small></button>
      <button type="button" aria-pressed={mode === 'bookmarks'} onClick={() => setMode('bookmarks')}>书签 <small>{bookmarks.length}</small></button>
    </div>
    <nav aria-label={mode === 'toc' ? '章节目录' : '阅读书签'}>
      {mode === 'toc' ? book.toc.map((entry, index) => <button type="button" className="epub-toc-row" key={index} aria-current={entry.chapter === chapter && !entry.anchor ? 'location' : undefined}
        style={{ paddingLeft: 14 + entry.depth * 14 }} title={entry.title} onClick={() => go(entry.chapter, 0, entry.anchor)}>{entry.title}</button>) :
        bookmarks.length ? bookmarks.map(mark => {
          const at = book.chapters.findIndex(c => c.href === mark.chapter), stale = mark.sourceHash !== book.sourceHash || at < 0
          return <div className="epub-bookmark-row" key={mark.id}>
            <button type="button" disabled={stale} onClick={() => go(at, mark.offset)}><strong>{mark.title}</strong><small>{stale ? '原文件已变化，原位置保留' : book.chapters[at].title}</small></button>
            <button type="button" className="epub-icon-button" aria-label={`删除书签：${mark.title}`} title="删除书签，可撤销" onClick={() => void host.core.run('epub', 'removeBookmark', { id, bookmarkId: mark.id }).catch(e => host.notify(String(e)))}>×</button>
          </div>
        }) : <p className="epub-panel-hint">阅读时点“书签”，记下想再看的地方。</p>}
    </nav>
  </div>
}
