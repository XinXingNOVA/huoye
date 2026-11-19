import { useEffect, useRef, useState } from 'react'
import type { UiHost } from '../plugin'
import type { SpaceCandidate } from '../../../shared/file-spaces'
import type { FileUpdatePreview } from '../../../shared/file-updates'

const size = (n: number) => n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`
/** 接纳已有空间版本；编辑直接创建／复用工作副本。 */
export function FileVersionActions({ file, host, busy, run, refresh, notify }: {
  file: SpaceCandidate; host: UiHost; busy: boolean; run(fn: () => Promise<void>): void; refresh(): Promise<void>; notify(message: string): void
}) {
  const [update, setUpdate] = useState<{ preview: FileUpdatePreview; requestId: string }>()
  const confirmation = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!update) return
    confirmation.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    confirmation.current?.querySelector('button')?.focus({ preventScroll: true })
  }, [update])
  const pending = !!file.adoptedVersion && file.contentVersion !== file.adoptedVersion
  const preview = async () => setUpdate({ preview: await host.core.previewFileUpdate(file.collected!), requestId: crypto.randomUUID() })
  return <div className="space-version-actions">
    <div className="space-actions">
      <h3>{file.name}</h3>
      {pending && <span className="package-pending">空间有新版待接纳</span>}
      <button className="small" hidden={!file.adoptedVersion} disabled={busy} onClick={() => run(preview)}>{pending ? '预览更新…' : '查看版本信息'}</button>
      <button className="small" disabled={busy} onClick={() => host.editFile(file.collected!)}>修改文件…</button>
    </div>
    {update && <div ref={confirmation} className="space-confirm" role="group" aria-label="预览内容更新">
      <div className="space-version-compare">{([['本仓库已采用', update.preview.previous], ['空间当前内容', update.preview.current]] as const).map(([label, version]) => <section key={label}>
        <h4>{label} · V{version.ordinal}</h4><p>{size(version.size)} · {new Date(version.createdAt).toLocaleString()}</p>
        <p className="muted space-hash" title={version.hash}>SHA-256 {version.hash.slice(0, 16)}…</p>
        {version.unavailable && <p className="package-error">旧内容不可读取；历史登记保留。{version.unavailable}</p>}
        {!version.unavailable && /\.(png|jpe?g|webp|gif|avif)$/i.test(version.name) && <img src={host.url(version.reference)} alt={`${label}的图片预览`} />}
        {version.sample !== undefined && <pre>{version.sample}{version.size > 4096 ? '\n…（前 4 KB）' : ''}</pre>}
      </section>)}</div>
      <p className="muted">更新本仓库的文件引用与派生内容，保留标签、笔记和名称。</p>
      <div className="space-actions"><button className="small" disabled={busy} onClick={() => setUpdate(undefined)}>暂不更新</button>
        <button className="primary" disabled={busy || update.preview.previous.id === update.preview.current.id} onClick={() => run(async () => {
          const p = update.preview
          await host.core.acceptFileUpdate({ id: p.id, expectedPath: p.expectedPath, contentVersion: p.current.id, revision: p.revision, requestId: update.requestId })
          setUpdate(undefined)
          await refresh(); notify('本仓库已接纳新版，素材身份和附加数据保留。')
        })}>接纳到本仓库</button></div>
    </div>}
  </div>
}
