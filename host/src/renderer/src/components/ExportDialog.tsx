import { uiText, useUiLocale } from '../../../shared/i18n/interface-display'
// 导出（设计文档 11.12）：输出撤销不了，所以先预览（会写出什么、多大）、再确认；
// 写的时候显示进度；写完列出失败的，可以在访达中显示。导出到的位置记在这台电脑上。

import { useEffect, useState } from 'react'
import type { ExportPreview, ExportResult } from '../../../shared/rpc'
import type { UiHost } from '../plugin'
import { titleFor } from '../ui-registry'
import { formatBytes, isEnter } from '../widgets'

const PARENT_KEY = 'export.parent'

const remembered = () => {
  try {
    return localStorage.getItem(PARENT_KEY) ?? undefined
  } catch {
    return undefined
  }
}

/** 各个文件夹是什么。 */
const FOLDERS: Record<string, string> = { get 素材() { return uiText("个原文件") }, get 文字() { return uiText("篇 Markdown") }, get 局部() { return uiText("张裁好的局部") } }

export function ExportDialog({ ids, name: initialName, host, onClose }: { ids: string[]; name: string; host: UiHost; onClose(): void }) {
  useUiLocale()
  const [preview, setPreview] = useState<ExportPreview>()
  const [name, setName] = useState(initialName)
  const [parent, setParent] = useState(remembered)
  const [progress, setProgress] = useState<{ done: number; total: number }>()
  const [result, setResult] = useState<ExportResult>()
  const [error, setError] = useState<string>()
  const running = !!progress && !result

  useEffect(() => {
    void host.core.exportPreview(ids).then(setPreview).catch(e => setError(String(e)))
    if (!parent) void window.bridge.downloadsPath().then((p) => setParent((x) => x ?? p))
  }, [host, ids])

  useEffect(() => host.core.on('exporting', (p) => setProgress(p)), [host])

  const choose = async () => {
    const p = await window.bridge.pickExportFolder(parent)
    if (p) setParent(p)
    return p ?? undefined
  }

  const run = async () => {
    const where = parent ?? (await choose())
    if (!where || !name.trim()) return
    try {
      localStorage.setItem(PARENT_KEY, where)
    } catch {
      // 记不住就下次再选
    }
    setProgress({ done: 0, total: ids.length })
    try {
      // 标题用界面上的（标题扩展点仲裁出来的），和卡片上看到的一样
      const views = await host.core.get(ids)
      const titles = Object.fromEntries(views.map((v) => [v.id, titleFor(v)]))
      setResult(await host.core.exportRun({ ids, titles, parent: where, name: name.trim() }))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setProgress(undefined)
    }
  }

  const close = () => {
    if (!running) onClose()
  }

  return (
    <div className="qa-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="quick-attach export-dialog" onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), close())}>
        {result ? (
          <>
            <div className="export-title">{uiText("已导出")}{' '}{result.written}{' '}{uiText("个文件")}</div>
            <div className="export-path muted">{result.dir}</div>
            {result.failed.length > 0 && (
              <div className="export-failed">
                <div>{result.failed.length}{' '}{uiText("项没有导出成功：")}</div>
                <ul>
                  {result.failed.map((f, i) => (
                    <li key={i}>
                      {f.title}：{f.reason}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="export-actions">
              <button className="small" onClick={() => host.reveal(uiText("{dir}/索引.md", { dir: String(result.dir) }))}>{uiText("在访达中显示")}{' '}</button>
              <button className="small primary" autoFocus onClick={onClose}>{uiText("完成")}{' '}</button>
            </div>
          </>
        ) : (
          <>
            <div className="export-title">{uiText("导出")}{' '}{ids.length}{' '}{uiText("项")}</div>
            {!!preview?.problems.length && <div className="export-failed" role="alert">{preview.problems.join('；')}</div>}
            <ul className="export-summary">
              {preview ? (
                <>
                  {preview.folders.map((f) => (
                    <li key={f.folder}>
                      {f.folder}/：{f.count} {FOLDERS[f.folder] ?? uiText("个文件")}
                      {f.bytes ? `，${formatBytes(f.bytes)}` : ''}
                    </li>
                  ))}
                  {preview.locals > 0 && <li>{uiText("还会带上它们的")}{' '}{preview.locals}{' '}{uiText("条批注")}</li>}
                  <li>{uiText("索引.md：每一项的标签、状态、字段、笔记、批注，图片直接显示")}</li>
                  {preview.unsupported > 0 && <li className="export-failed">{preview.unsupported}{' '}{uiText("项缺少格式导出器，其完整内容不会写入这个导出。")}<button className="link" onClick={() => { onClose(); host.takeout(ids, name) }}>{uiText("改用取回数据…")}</button></li>}
                </>
              ) : (
                <li className="muted">{uiText("正在看看会写出什么…")}</li>
              )}
            </ul>
            <label className="export-row">
              <span className="muted">{uiText("名称")}</span>
              <input
                className="field-text"
                autoFocus
                value={name}
                disabled={running}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (isEnter(e) && !running) void run()
                }}
              />
            </label>
            <div className="export-row">
              <span className="muted">{uiText("位置")}</span>
              <span className="export-parent" title={parent}>
                {/* 从左边截断长路径；开头的方向标记让斜杠留在原处 */}
                {parent ? `\u200E${parent}` : '…'}
              </span>
              <button className="small" disabled={running} onClick={() => void choose()}>{uiText("选择…")}{' '}</button>
            </div>
            <div className="export-hint muted">{uiText("会新建一个文件夹，Obsidian、Typora 可以直接打开；已有同名的不会覆盖。")}</div>
            {error && <div className="export-failed">{uiText("导出失败：")}{error}</div>}
            <div className="export-actions">
              {running && progress && (
                <span className="export-progress">
                  <span style={{ width: `${(progress.done / Math.max(1, progress.total)) * 100}%` }} />
                </span>
              )}
              <button className="small" disabled={running} onClick={close}>{uiText("取消")}{' '}</button>
              <button className="small primary" disabled={running || !preview || (preview.unsupported === preview.items + preview.locals) || !name.trim()} onClick={() => void run()}>
                {running ? uiText("正在导出…") : uiText("导出")}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
