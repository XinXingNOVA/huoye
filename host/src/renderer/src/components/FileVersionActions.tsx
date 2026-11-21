import { uiText, useUiLocale } from '../../../shared/i18n/interface-display'
import { useEffect, useRef, useState } from 'react'
import type { UiHost } from '../plugin'
import type { SpaceCandidate } from '../../../shared/file-spaces'
import type { FileUpdatePreview } from '../../../shared/file-updates'
import { UpdateComparison } from '../../../plugins/file/UpdateComparison'

/** 接纳已有空间版本；编辑直接创建／复用工作副本。 */
export function FileVersionActions({ file, host, busy, run, refresh, notify }: {
  file: SpaceCandidate; host: UiHost; busy: boolean; run(fn: () => Promise<void>): void; refresh(): Promise<void>; notify(message: string): void
}) {
  useUiLocale()
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
      {pending && <span className="package-pending">{uiText("空间有新版待接纳")}</span>}
      <button className="small" hidden={!file.adoptedVersion} disabled={busy} onClick={() => run(preview)}>{pending ? uiText("预览更新…") : uiText("查看版本信息")}</button>
      <button className="small" disabled={busy} onClick={() => host.editFile(file.collected!)}>{uiText("修改文件…")}</button>
    </div>
    {update && <div ref={confirmation} className="space-confirm" role="group" aria-label={uiText("预览内容更新")}>
      <UpdateComparison preview={update.preview} host={host}/>
      <p className="muted">{uiText("更新本仓库的文件引用与派生内容，保留标签、笔记和名称。")}</p>
      <div className="space-actions"><button className="small" disabled={busy} onClick={() => setUpdate(undefined)}>{uiText("暂不更新")}</button>
        <button className="primary" disabled={busy || update.preview.previous.id === update.preview.current.id} onClick={() => run(async () => {
          const p = update.preview
          await host.core.acceptFileUpdate({ id: p.id, expectedPath: p.expectedPath, contentVersion: p.current.id, revision: p.revision, requestId: update.requestId })
          setUpdate(undefined)
          await refresh(); notify(uiText("本仓库已接纳新版，素材身份和附加数据保留。"))
        })}>{uiText("接纳到本仓库")}</button></div>
    </div>}
  </div>
}
