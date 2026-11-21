import { uiText, useUiLocale } from '../../../shared/i18n/interface-display'
import { useEffect, useRef, useState } from 'react'
import type { UiHost } from '../plugin'
import type { SpaceCandidate, SpaceInfo } from '../../../shared/file-spaces'
import type { ContentVersion, RestoreVersionInput, SpaceHistoryPage } from '../../../shared/space-versions'

const size = (n: number) => n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`
export function SpaceFileHistory({ space, file, host, busy, run, refresh, notify }: {
  space: SpaceInfo; file: SpaceCandidate; host?: UiHost; busy: boolean
  run(fn: () => Promise<void>): void; refresh(): Promise<void>; notify(text: string): void
}) {
  useUiLocale()
  const [opened, setOpened] = useState(false), [page, setPage] = useState<SpaceHistoryPage>(), [offset, setOffset] = useState(0)
  const [error, setError] = useState(''), [confirmation, setConfirmation] = useState<{ version: ContentVersion; input: RestoreVersionInput }>()
  const confirmRef = useRef<HTMLDivElement>(null), revision = useRef<number | undefined>(undefined)
  useEffect(() => {
    if (!opened) return
    let alive = true
    setPage(undefined); setError(''); setConfirmation(undefined)
    const input = { spaceId: space.id, fileId: file.id, offset, limit: 20, ...(offset ? { revision: revision.current } : {}) }
    const task = host ? host.core.spaceFileHistory(input) : window.bridge.spaces.history(space.root, input)
    void task.then(value => { if (alive) { setPage(value); revision.current = value.revision } }, e => { if (alive) setError(String(e)) })
    return () => { alive = false }
  }, [opened, host, space.id, space.root, file.id, file.revision, offset])
  useEffect(() => {
    if (confirmation) { confirmRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); confirmRef.current?.querySelector('button')?.focus({ preventScroll: true }) }
  }, [confirmation])
  return <section className="space-history" aria-label={uiText("文件历史版本")}>
    <div className="space-actions"><h3>{uiText("历史版本")}</h3><button className="small" disabled={busy} aria-expanded={opened} onClick={() => setOpened(v => !v)}>{opened ? uiText("收起版本列表") : uiText("查看历史版本")}</button></div>
    {opened && <>
      {error && <p className="package-error" role="alert">{error}<button className="small" onClick={() => { setOffset(0); setOpened(false) }}>{uiText("关闭后重新查看")}</button></p>}
      {!page && !error && <p className="muted">{uiText("读取版本列表…")}</p>}
      {page && <>
        {page.blocked && <p className="muted">{page.blocked}</p>}
        <ol className="space-history-list">{page.versions.map(version => <li key={version.id}>
          <div><strong>V{version.ordinal}{version.id === page.currentVersion ? uiText(" · 空间当前版") : ''}{version.id === file.adoptedVersion ? uiText(" · 本库已采用") : ''}</strong>
            <p className="muted">{new Date(version.createdAt).toLocaleString()} · {size(version.size)} · <span className="space-hash" title={version.hash}>{version.hash.slice(0, 12)}</span></p>{version.unavailable && <p className="package-error">{uiText("内容不可用：")}{version.unavailable}</p>}</div>
          <button className="small" disabled={busy || !!confirmation || !page.canRestore || !!version.unavailable || version.id === page.currentVersion} onClick={() => setConfirmation({ version,
            input: { spaceId: space.id, fileId: file.id, contentVersion: version.id, revision: page.revision, requestId: crypto.randomUUID() } })}>{uiText("恢复为新版…")}</button>
        </li>)}</ol>
        <div className="space-actions"><button className="small" disabled={busy || !!confirmation || offset === 0} onClick={() => setOffset(v => Math.max(0, v - 20))}>{uiText("较新版本")}</button><span className="muted">{uiText("共")}{' '}{page.total}{' '}{uiText("个版本")}</span><button className="small" disabled={busy || !!confirmation || page.nextOffset === undefined} onClick={() => setOffset(page.nextOffset!)}>{uiText("更早版本")}</button></div>
      </>}
      {confirmation && <div className="space-confirm" ref={confirmRef} role="group" aria-label={uiText("确认恢复历史内容")}>
        <h3>{uiText("将 V")}{confirmation.version.ordinal}{' '}{uiText("的内容恢复为新版")}</h3>
        <p>{uiText("复制")}{' '}{size(confirmation.version.size)}{' '}{uiText("的历史内容发布为新版，现有版本与本库业务数据保留。")}</p>
        <div className="space-actions"><button className="small" disabled={busy} onClick={() => setConfirmation(undefined)}>{uiText("取消")}</button>
          {busy && <button className="small" onClick={() => void (host ? host.core.cancelSpaceOperation(confirmation.input.requestId) : window.bridge.spaces.cancelOperation(confirmation.input.requestId)).catch(e => setError(String(e)))}>{uiText("取消本次处理")}</button>}
          <button className="primary" disabled={busy} onClick={() => run(async () => {
            const result = host ? await host.core.restoreSpaceVersion(confirmation.input) : await window.bridge.spaces.restoreVersion(space.root, confirmation.input)
            setConfirmation(undefined); await refresh(); notify(uiText("历史内容已发布为新版{value1}。", { value1: String(result.replayed ? uiText("（已核对上次结果）") : '') }))
          })}>{busy ? uiText("校验并发布中…") : uiText("确认恢复为新版")}</button></div>
      </div>}
    </>}
  </section>
}
