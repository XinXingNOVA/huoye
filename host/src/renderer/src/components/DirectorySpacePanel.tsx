import { uiText, useUiLocale } from '../../../shared/i18n/interface-display'
import { SpaceItemsButton } from './SpaceItems'
import { FileStorageDialog } from './FileStorageDialog'
import { useEffect, useRef, useState } from 'react'
import { Button, Icon, IconButton } from '../../../plugin-api/ui/kit'
import { DirectoryUpdates } from './DirectoryUpdates'
import { DirectoryCollectionForm } from './DirectoryCollectionForm'
import type { UiHost } from '../../../plugin-api/ui/contracts'
import type { SpaceReferences } from '../../../shared/file-spaces'
import { formatBytes } from '../../../shared/format'
import { directoryImage, directoryPageSize, type DirectoryEntry, type DirectoryPage, type DirectorySpace, type DirectoryVerification, type MissingDirectoryFiles } from '../../../shared/directory-spaces'

function ImagePreview({ spaceId, entry }: { spaceId: string; entry: DirectoryEntry }) {
  useUiLocale()
  const [src, setSrc] = useState(''), [error, setError] = useState('')
  useEffect(() => {
    let active = true
    void window.bridge.spaces.directories.preview(spaceId, entry.id, entry.stamp).then(
      url => { if (active) setSrc(url) },
      e => { if (active) setError(String(e)) })
    return () => { active = false }
  }, [spaceId, entry.id, entry.stamp])
  if (error) return <p role="alert">{error}</p>
  return src ? <img className="directory-image" src={src} alt={entry.name} /> : <p role="status">{uiText("正在读取图片…")}</p>
}

function FileDetails({ spaceId, entry }: { spaceId: string; entry: DirectoryEntry }) {
  useUiLocale()
  const [verified, setVerified] = useState<DirectoryVerification>(), [busy, setBusy] = useState(false), [error, setError] = useState('')
  async function verify() {
    setBusy(true); setError('')
    try { setVerified(await window.bridge.spaces.directories.verify(spaceId, entry.id, entry.stamp)) }
    catch (e) { setError(String(e)) }
    finally { setBusy(false) }
  }
  return <div className="directory-file-detail">
    {directoryImage(entry.name) && <ImagePreview spaceId={spaceId} entry={entry}/>}
    {verified ? <p role="status">{uiText("已核对版本")}{' '}{verified.revision} · SHA-256 <code>{verified.hash}</code></p>
      : <Button size="sm" loading={busy} onClick={() => void verify()}>{uiText("核对内容版本")}</Button>}
    {error && <p role="alert">{error}</p>}
  </div>
}

function MissingFiles({ spaceId }: { spaceId: string }) {
  useUiLocale()
  const [offset, setOffset] = useState(0), [page, setPage] = useState<MissingDirectoryFiles>(), [error, setError] = useState('')
  useEffect(() => {
    let active = true
    window.bridge.spaces.directories.missing(spaceId, offset).then(
      next => { if (active) setPage(next) }, e => { if (active) setError(String(e)) })
    return () => { active = false }
  }, [spaceId, offset])
  if (error) return <p role="alert">{error}</p>
  if (!page) return <p role="status">{uiText("正在读取记录…")}</p>
  return <section aria-label={uiText("原位置缺失")}>
    <ul className="directory-entries">{page.items.map(item => <li key={item.id}><Icon name="history"/><span>{item.path}</span><small>{formatBytes(item.size)}</small></li>)}</ul>
    {page.total > directoryPageSize && <div className="space-actions">
      <Button size="sm" disabled={!page.offset} onClick={() => setOffset(page.offset - directoryPageSize)}>{uiText("上一页")}</Button>
      <span>{page.offset + 1}–{page.offset + page.items.length} / {page.total}</span>
      <Button size="sm" disabled={page.offset + page.items.length >= page.total} onClick={() => setOffset(page.offset + directoryPageSize)}>{uiText("下一页")}</Button>
    </div>}
  </section>
}

export function DirectorySpacePanel({ space, host, initialCollection, onRelocated, onUnlink }: { space: DirectorySpace; host: UiHost; initialCollection: boolean; onRelocated(): Promise<void>; onUnlink(counts: SpaceReferences): Promise<void> }) {
  useUiLocale()
  const [trail, setTrail] = useState<DirectoryEntry[]>([])
  const [request, setRequest] = useState({ offset: 0, refresh: true })
  const [page, setPage] = useState<DirectoryPage>(), [error, setError] = useState('')
  const [selected, setSelected] = useState<DirectoryEntry>()
  const [scanning, setScanning] = useState(false), [notice, setNotice] = useState(''), [showMissing, setShowMissing] = useState(false)
  const [impact, setImpact] = useState<SpaceReferences>(), [checkingImpact, setCheckingImpact] = useState(false)
  const [checked, setChecked] = useState<Record<string, string>>({})
  const [collecting, setCollecting] = useState(false)
  const [updatesOpen, setUpdatesOpen] = useState(false)
  const retry = useRef<{ selection: string; requestId: string } | undefined>(undefined)
  const folderId = trail.at(-1)?.id ?? null
  useEffect(() => window.bridge.spaces.directories.onChanged((id, entriesChanged) => {
    if (id === space.id && entriesChanged) setRequest(r => ({ ...r, refresh: false }))
  }), [space.id])
  useEffect(() => {
    let active = true
    void window.bridge.spaces.directories.page(space.id, folderId, request.offset, request.refresh).then(
      next => {
        if (!active) return
        setPage(next)
        setChecked(old => Object.fromEntries(next.items.filter(i => !i.collected && i.stamp === old[i.id]).map(i => [i.id, i.stamp])))
      },
      e => {
        if (!active) return
        if (folderId && String(e).includes('[DIRECTORY_ENTRY_MISSING]')) {
          setTrail(t => t.slice(0, -1)); load(0, false)
        } else setError(String(e))
      })
    return () => { active = false }
  }, [space.id, folderId, request])
  useEffect(() => host.core.on('fileSpaceChanged', event => {
    if (event.spaceId === space.id) setRequest(r => ({ ...r, refresh: false }))
  }), [host.core, space.id])
  function load(offset = 0, refresh = true) {
    setPage(undefined); setError(''); setSelected(undefined); setChecked({}); setRequest({ offset, refresh })
  }
  async function collect(items: DirectoryEntry[]) {
    if (collecting || !items.length || page?.issue) return
    setCollecting(true); setError(''); setNotice('')
    try {
      const files = items.map(({ id, stamp }) => ({ id, stamp }))
      const selection = JSON.stringify(files)
      if (retry.current?.selection !== selection) retry.current = { selection, requestId: crypto.randomUUID() }
      await host.core.collectSelectedDirectoryFiles({ sourceKind: 'directory', spaceId: space.id, files, requestId: retry.current.requestId })
      retry.current = undefined
      setNotice(uiText("所选 {length} 个文件已在本库", { length: String(files.length) })); setChecked({})
    } catch (e) { setError(String(e)) }
    finally { setCollecting(false); setRequest(r => ({ ...r, refresh: false })) }
  }
  async function refreshTree(retryOnly = false) {
    setScanning(true); setNotice(''); setError('')
    try {
      const r = await window.bridge.spaces.directories.refreshTree(space.id, retryOnly)
      const updates = await host.core.listDirectoryUpdates(space.id, 0)
      setNotice([r.cancelled ? uiText("已停止核对") : uiText("核对完成"), uiText("已检查 {checked} 个目录", { checked: String(r.checked) }), uiText("本库 {total} 项待接纳", { total: String(updates.total) }), r.fileIssues.total ? uiText("空间内 {total} 个文件未能核对", { total: String(r.fileIssues.total) }) : '', r.failed ? uiText("{failed} 个目录未能核对：{firstIssue}", { failed: String(r.failed), firstIssue: String(r.firstIssue) }) : ''].filter(Boolean).join(' · '))
      if (updates.total) setUpdatesOpen(true)
      setRequest(r => ({ ...r, refresh: false }))
    } catch (e) { setError(String(e)) }
    finally { setScanning(false) }
  }
  async function relocate() {
    setError('')
    try {
      const result = await window.bridge.spaces.directories.relocate(space.id)
      if (!result) return
      setTrail([]); load(); await onRelocated()
    } catch (e) { setError(String(e)) }
  }
  return <section className="directory-panel" aria-label={uiText("原地目录")}>
    <header className="space-header-card">
      <div className="space-header-main"><h2>{space.name}</h2><p className="space-path">{space.root}</p></div>
      <SpaceItemsButton host={host} space={space} check={scanning ? undefined : { label: uiText("核对整个空间"), open: () => void refreshTree() }}/>
      <details className="directory-management" key={page?.issue ? 'issue' : 'online'} open={page?.issue ? true : undefined}><summary>{uiText("管理…")}</summary><div className="space-actions">
      <Button size="sm" variant="ghost" disabled={scanning} onClick={() => void relocate()}>{uiText("重新定位根目录…")}</Button>
      <Button size="sm" variant="ghost" disabled={scanning || checkingImpact} onClick={async () => {
        setCheckingImpact(true); setError('')
        try { setImpact(await host.core.directorySpaceReferences(space.id)) } catch (e) { setError(String(e)) }
        finally { setCheckingImpact(false) }
      }}>{uiText("解除目录关联")}</Button>
      </div></details>
    </header>
    {impact && <section className="space-confirm" aria-label={uiText("解除目录关联预览")}>
      <h3>{uiText("解除本仓库与「")}{space.name}{uiText("」的关联？")}</h3>
      <p>{uiText("本库有")}{' '}{impact.active}{' '}{uiText("项在用素材、")}{impact.trashed}{' '}{uiText("项回收站素材引用此空间。解除后这些素材暂时无法打开原件，标签和笔记保留。其他仓库可以继续使用这个目录。")}</p>
      <div className="space-actions">
        <Button size="sm" disabled={checkingImpact} onClick={() => setImpact(undefined)}>{uiText("取消")}</Button>
        <Button size="sm" disabled={checkingImpact} onClick={async () => {
          setCheckingImpact(true)
          try { await onUnlink(impact) } finally { setImpact(undefined); setCheckingImpact(false) }
        }}>{uiText("确认解除关联")}</Button>
      </div>
    </section>}
    <DirectoryCollectionForm spaceId={space.id} host={host} initialOpen={initialCollection}/>
    <DirectoryUpdates key={space.id} open={updatesOpen} onOpen={setUpdatesOpen} host={host} spaceId={space.id} checkedAt={page?.checkedAt} unresolved={page?.fileIssues.total ?? 0}/>
    <div className="space-actions directory-navigation">
      <IconButton size="sm" icon="left" label={uiText("上一级目录")} disabled={!trail.length} onClick={() => { setTrail(t => t.slice(0,-1)); load() }}/>
      <strong>{[space.name, ...trail.map(t => t.name)].join(' / ')}</strong>
      <Button size="sm" disabled={!page && !error} onClick={() => load()}>{uiText("刷新目录")}</Button>
      {scanning ? <Button size="sm" onClick={() => void window.bridge.spaces.directories.stopTree(space.id).catch(e => setError(String(e)))}>{uiText("停止核对")}</Button>
        : <Button size="sm" onClick={() => void refreshTree()}>{uiText("核对整个空间")}</Button>}
    </div>
    {notice && <p role="status">{notice}</p>}
    {error && <p role="alert">{error}</p>}
    {!!page?.fileIssues.total && <section className="space-confirm" aria-label={uiText("未完成的文件核对")}>
      <h3>{page.fileIssues.total}{' '}{uiText("个文件未能核对")}</h3>
      <ul>{page.fileIssues.examples.map(item => <li key={item.path}>{item.path} · {item.reason}</li>)}</ul>
      {page.fileIssues.total > page.fileIssues.examples.length && <p>{uiText("这里只列出前")}{' '}{page.fileIssues.examples.length}{' '}{uiText("项。")}</p>}
      <Button size="sm" disabled={scanning} onClick={() => void refreshTree(true)}>{uiText("重试未完成项")}</Button>
    </section>}
    {page?.issue && <p role="status">{page.issue}{page.checkedAt ? uiText(" · 显示上次浏览的清单") : ''}</p>}
    {!page && !error && <p role="status">{uiText("正在读取目录…")}</p>}
    {page && <>
      {page.missingCount > 0 && <div>
        <Button size="sm" variant="ghost" aria-expanded={showMissing} onClick={() => setShowMissing(v => !v)}>{uiText("原位置缺失 ·")}{' '}{page.missingCount}</Button>
        {showMissing && <MissingFiles key={page.missingCount} spaceId={space.id}/>}
      </div>}
      {!page.total && !page.issue && <p className="muted">{uiText("这个目录是空的。")}</p>}
      {!!Object.keys(checked).length && <Button size="sm" disabled={!!page.issue} loading={collecting} onClick={() => void collect(page.items.filter(i => checked[i.id] === i.stamp))}>{uiText("收录所选")}{' '}{Object.keys(checked).length}{' '}{uiText("项")}</Button>}
      <ul className="directory-entries directory-browser" aria-label={uiText("目录内容")}>
        {page.items.map(item => <li key={item.id}>
          {item.collectionState === 'uncollected' ? <input type="checkbox" aria-label={uiText("选择 ") + item.name} checked={checked[item.id] === item.stamp} disabled={collecting}
            onChange={e => { const on = e.target.checked; setChecked(prev => { const next = { ...prev }; if (on) next[item.id] = item.stamp; else delete next[item.id]; return next }) }}/> : <Icon name={item.folder ? 'folder' : 'text'}/>}
          {item.folder ? <button onClick={() => { setTrail(t => [...t, item]); load() }}>{item.name}</button>
            : <button aria-expanded={selected?.id === item.id} onClick={() => setSelected(selected?.id === item.id ? undefined : item)}>{item.name}</button>}
          <small>{item.folder ? uiText("目录") : formatBytes(item.size)}</small>
          <div className="space-actions">
            {item.collectionState === 'uncollected' && <Button size="sm" variant="ghost" disabled={collecting || !!page.issue} onClick={() => void collect([item])}>{uiText("收录到本库")}</Button>}
            {item.collected && <Button size="sm" variant="ghost" onClick={() => host.openData(item.collected!)}>{item.collectionState === 'trashed' ? uiText("查看回收站记录") : uiText("在库中查看")}</Button>}
            {item.hasUpdate && item.collected && <Button size="sm" onClick={() => host.showDialog(close => <FileStorageDialog host={host} id={item.collected!} close={close} previewOnOpen/>)}>{uiText("预览新版…")}</Button>}
          </div>
          {selected?.id === item.id && <FileDetails key={item.id + item.stamp} spaceId={space.id} entry={item}/>}
        </li>)}
      </ul>
      {page.total > directoryPageSize && <div className="space-actions space-pagination">
        <Button size="sm" disabled={!page.offset} onClick={() => load(Math.max(0, page.offset - directoryPageSize), false)}>{uiText("上一页")}</Button>
        <span>{page.offset + 1}–{page.offset + page.items.length} / {page.total}</span>
        <Button size="sm" disabled={page.offset + page.items.length >= page.total} onClick={() => load(page.offset + directoryPageSize, false)}>{uiText("下一页")}</Button>
      </div>}
    </>}
  </section>
}
