import { t, useLanguage } from '../language'
import { useState } from 'react'
import { Button, Input, Select } from '../../../plugin-api/ui/kit'
import type { UiHost } from '../../../plugin-api/ui/contracts'
import type { DirectoryCollectionPreview, DirectoryCollectionResult } from '../../../shared/directory-spaces'

const filterLabels = { images: 'collect.images', documents: 'collect.documents', allFiles: 'collect.allFiles', custom: 'collect.custom' } as const
const filters: Record<string, string[]> = {
  images: ['jpg', 'jpeg', 'png', 'webp', 'avif', 'gif', 'bmp', 'heic', 'heif', 'tif', 'tiff', 'svg'],
  documents: ['pdf', 'md', 'markdown', 'txt', 'epub', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'csv'],
  allFiles: []
}

export function DirectoryCollectionForm({ spaceId, host, initialOpen, standalone, onBusy }: { spaceId: string; host: UiHost; initialOpen: boolean; standalone?: boolean; onBusy?(busy: boolean): void }) {
  useLanguage()
  const [open, setOpen] = useState(initialOpen), [filter, setFilter] = useState('images'), [custom, setCustom] = useState('')
  const [preview, setPreview] = useState<DirectoryCollectionPreview>(), [busy, setBusy] = useState(false)
  const [result, setResult] = useState<DirectoryCollectionResult>()
  const [issueCount, setIssueCount] = useState(0), [error, setError] = useState('')
  const suffixes = filter === 'custom' ? [...new Set(custom.split(/[\s,，;；]+/).map(s => s.replace(/^\./, '').toLowerCase()).filter(Boolean))] : filters[filter]
  function reset() { setPreview(undefined); setResult(undefined); setIssueCount(0); setError('') }
  async function run(confirm: boolean) {
    setBusy(true); onBusy?.(true); setError(''); setResult(undefined); setIssueCount(0)
    try {
      if (confirm && preview) {
        const r = await host.core.collectDirectoryFiles(spaceId, suffixes, preview.token)
        setPreview(undefined)
        setResult(r)
      } else {
        setPreview(undefined)
        const scan = await window.bridge.spaces.directories.refreshTree(spaceId)
        if (scan.failed || scan.cancelled) throw new Error(scan.firstIssue ?? t('collect.stopped'))
        setIssueCount(scan.fileIssues.total)
        setPreview(await host.core.previewDirectoryCollection(spaceId, suffixes))
      }
    } catch (e) { setPreview(undefined); setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false); onBusy?.(false) }
  }
  return <div className="space-confirm directory-collection">
    {!standalone && <Button variant="ghost" size="sm" aria-expanded={open} onClick={() => setOpen(!open)}>{t('collect.byType')}</Button>}
    {open && <section aria-label={t('collect.byType')} aria-busy={busy}>
      <p className="muted">{t('collect.hint')}</p>
      <div className="space-actions">
        <Select aria-label={t('collect.scope')} value={filter} disabled={busy} onChange={e => { setFilter(e.target.value); reset() }}>
          {Object.entries(filterLabels).map(([id, key]) => <option key={id} value={id}>{t(key)}</option>)}
        </Select>
        {filter === 'custom' && <Input aria-label={t('collect.suffix')} placeholder={t('collect.example')} disabled={busy} value={custom} onChange={e => { setCustom(e.target.value); reset() }}/>}
        <Button size="sm" disabled={busy || (filter === 'custom' && !suffixes.length)} onClick={() => void run(false)}>{t('collect.preview')}</Button>
        {preview && preview.pending > 0 && <Button size="sm" variant="primary" disabled={busy} onClick={() => void run(true)}>{t('collect.submit', { count: preview.pending })}</Button>}
      </div>
      {busy && <p role="status">{t('collect.checking')}</p>}
      {preview && <p role="status">{t('collect.counts', preview)}
        {preview.examples.length > 0 && <>（{preview.examples.join('、')}）</>}</p>}
      {result && <p role="status">{t('collect.complete', result)}</p>}
      {!!result?.failed && <p role="alert">{t('collect.failed', { count: result.failed, problems: result.problems.join('; ') })}</p>}
      {issueCount > 0 && <p role="status">{t('collect.retry', { count: issueCount })}</p>}
      {error && <p role="alert">{error}</p>}
    </section>}
  </div>
}
