import { uiText, useUiLocale } from '../../../shared/i18n/interface-display'
import { useEffect, useState } from 'react'
import type { UiHost } from '../../../plugin-api/ui/contracts'
import { Button } from '../../../plugin-api/ui/kit'
import { directoryPageSize, type DirectoryUpdatesPage } from '../../../shared/directory-spaces'
import { FileStorageDialog } from './FileStorageDialog'

export function DirectoryUpdates({ host, spaceId, checkedAt, unresolved, open, onOpen }: { open: boolean; onOpen(value: boolean): void; host: UiHost; spaceId: string; checkedAt?: number | null; unresolved: number }) {
  useUiLocale()
  const [offset, setOffset] = useState(0)
  const [revision, setRevision] = useState(0), [page, setPage] = useState<DirectoryUpdatesPage>()
  const [error, setError] = useState('')
  useEffect(() => {
    if (!open) return
    let active = true
    const refresh = () => setRevision(v => v + 1)
    const off = host.core.on('fileSpaceChanged', event => { if (event.spaceId === spaceId) refresh() })
    setError('')
    host.core.listDirectoryUpdates(spaceId, offset).then(value => { if (active) setPage(value) },
      e => { if (active) { setPage(undefined); setError(String(e)) } })
    return () => { active = false; off() }
  }, [host, spaceId, open, offset, revision, checkedAt])

  function preview(id: string) {
    host.showDialog(close => <FileStorageDialog id={id} host={host} previewOnOpen close={close} />)
  }

  return <section aria-label={uiText("原地文件更新")}>
    <Button size="sm" variant="ghost" aria-expanded={open} onClick={() => { onOpen(!open); setPage(undefined); setOffset(0) }}>{uiText("本库待接纳更新")}</Button>
    {open && <>
      {error && <p role="alert">{error}</p>}
      {!page && !error && <p role="status">{uiText("正在读取…")}</p>}
      {page && (page.total ? <>
        <ul className="directory-entries">{page.items.map(item => <li key={item.id}>
          <small>V{item.revision}</small><span>{item.path}</span><Button size="sm" onClick={() => preview(item.id)}>{uiText("预览更新…")}</Button>
        </li>)}</ul>
        {page.total > directoryPageSize && <div className="space-actions">
          <Button size="sm" disabled={!page.offset} onClick={() => setOffset(page.offset - directoryPageSize)}>{uiText("上一页")}</Button>
          <span>{page.offset + 1}–{page.offset + page.items.length} / {page.total}</span>
          <Button size="sm" disabled={page.offset + page.items.length >= page.total} onClick={() => setOffset(page.offset + directoryPageSize)}>{uiText("下一页")}</Button>
        </div>}
      </> : <p className="muted">{unresolved ? uiText("目前没有已核对的新版，空间里还有文件等待核对。") : uiText("当前已核对的文件没有待接纳更新。")}</p>)}
    </>}
  </section>
}
