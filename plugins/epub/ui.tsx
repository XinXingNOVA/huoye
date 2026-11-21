import { pluginMessages as packageMessages, useLocale as useUiLocale } from '@resource-manager/plugin-api/ui/locale'
import { epubLocation } from './selection'
import type { UiPlugin, ViewProps } from '@resource-manager/plugin-api/ui/contracts'
import { useEntity } from '@resource-manager/plugin-api/ui/data'
import { bookOf, positionOf, progressOf } from './model'
import { Reader, type ReaderParams } from './reader'
import { ReaderProvider, ContentsPanel, BookIcon } from './runtime'
import './style.css'

const uiText = packageMessages('epub')


function BookDetails({ view, host }: ViewProps) {
  useUiLocale()
  const book = bookOf(view.blocks.epub?.data)
  if (!book) return null
  const position = positionOf(book, view.blocks.epubreading?.data)
  return <div className="epub-details"><dl>
    <dt>{uiText("书名")}</dt><dd>{book.title}</dd>
    <dt>{uiText("作者")}</dt><dd>{book.author || uiText("未注明")}</dd>
    {book.publisher ? <><dt>{uiText("出版")}</dt><dd>{book.publisher}</dd></> : null}
    <dt>{uiText("章节")}</dt><dd>{book.chapters.length}{' '}{uiText("章")}</dd>
    <dt>{uiText("阅读")}</dt><dd>{view.blocks.epubreading ? `${Math.floor(progressOf(book, position) * 100)}%` : uiText("尚未阅读")}</dd>
  </dl>{book.description ? <details><summary>{uiText("内容简介")}</summary><p>{book.description}</p></details> : null}
  <button className="epub-button" onClick={() => host.open(view.id)}>{uiText("继续阅读 →")}</button></div>
}
function BookPreview({ view, host }: ViewProps) {
  useUiLocale()
  const book = bookOf(view.blocks.epub?.data), cover = view.blocks.thumb?.data.path ?? view.blocks.epub?.data.cover
  return <div className="epub-preview">{cover ? <img src={host.url(String(cover))} alt={book?.title || uiText("书籍封面")}/> : <BookIcon/>}<strong>{book?.title ?? host.title(view)}</strong><span>{book?.author || uiText("EPUB 电子书")}</span><button className="epub-button" onClick={() => host.open(view.id)}>{uiText("打开阅读器")}</button></div>
}
function Cover({ view, host }: ViewProps) {
  const cover = view.blocks.epub?.data.cover
  return cover ? <img className="epub-card-cover" src={host.url(String(cover))} draggable={false} alt=""/> : <div className="epub-card-placeholder"><BookIcon/><span>{String(view.blocks.epub?.data.title ?? 'EPUB')}</span></div>
}
function Title({ params }: { params: ReaderParams }) {
  useUiLocale()
  const view = useEntity(params.id); return <>{String(view?.blocks.epub?.data.title ?? view?.blocks.file?.data.name ?? uiText("电子书"))}</> }
const isEpub = (v: ViewProps['view']) => String(v.blocks.file?.data.ext).toLowerCase() === 'epub'
export const plugin: UiPlugin = {
  id: 'epub',
  contentLocations: [epubLocation],
  windowProviders: [{ id: 'epub.reader-context', order: 30, Component: ReaderProvider }],
  toolViews: [{
    id: 'epub.contents', get title() { return uiText("书籍目录") }, order: 35, Icon: BookIcon, Component: ContentsPanel,
    placement: { regions: ['left', 'right', 'center'], default: { region: 'left' } }
  }],
  views: [{ id: 'epub.books', get title() { return uiText("电子书") }, query: { has: ['epub'] }, order: 65 }],
  tabTypes: [{ id: 'epub.reader', key: (p: ReaderParams) => p.id, Title, Component: Reader }],
  opens: [{ priority: 25, match: isEpub, tab: 'epub.reader', params: (v, list) => ({ id: v.id, list, request: Date.now() }) }],
  covers: [{ priority: 70, match: isEpub, Component: Cover }],
  previews: [{ priority: 25, match: isEpub, Component: BookPreview }],
  embeds: [{ priority: 25, match: isEpub, Component: BookPreview }],
  sections: [{ id: 'epub.details', get title() { return uiText("电子书") }, order: 45, kinds: ['epub', 'epubtext', 'epubreading', 'epubbookmarks'], Component: BookDetails }],
  badges: [{ order: 25, get: v => v.blocks.epub ? { text: 'EPUB', color: '#8a9b7b' } : undefined }]
}
