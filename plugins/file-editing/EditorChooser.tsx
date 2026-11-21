import { pluginMessages as packageMessages, useLocale as useUiLocale } from '@resource-manager/plugin-api/ui/locale'
import { useEffect, useRef, useState } from 'react'
import type { UiHost } from '@resource-manager/plugin-api/ui/contracts'
import type { FileEditingTask } from '@resource-manager/plugin-api/ui/file-editing'
import type { EditorOptions } from '@resource-manager/plugin-api/ui/file-editing'
import './local-editors.css'

const uiText = packageMessages('file-editing')


const message = (e: unknown) => e instanceof Error ? e.message : String(e)

export function EditorChooser({ host, task, initial, close }: { host: UiHost; task: FileEditingTask; initial: EditorOptions; close(): void }) {
  useUiLocale()
  const [options, setOptions] = useState(initial), [chosen, setChosen] = useState(initial.preferred ?? (initial.systemAllowed ? 'system' : initial.editors[0]?.id ?? ''))
  const [remember, setRemember] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const running = useRef(false), alive = useRef(true), generation = useRef(0)
  useEffect(() => {
    alive.current = true
    const refresh = () => {
      const request = ++generation.current
      void host.fileEditing.editorOptions(task.id).then(value => { if (alive.current && request === generation.current) setOptions(value) }, e => { if (alive.current && request === generation.current) setError(message(e)) })
    }
    const off = host.fileEditing.onChanged(refresh)
    return () => { alive.current = false; generation.current++; off() }
  }, [host.fileEditing, task.id])
  const run = async (fn: () => Promise<void>) => {
    if (running.current) return
    running.current = true; setBusy(true); setError('')
    try { await fn() } catch (e) { if (alive.current) setError(message(e)) }
    finally { running.current = false; if (alive.current) setBusy(false) }
  }
  const valid = chosen === 'system' ? options.systemAllowed : options.editors.some(e => e.id === chosen)
  return <section className="editor-chooser" role="dialog" aria-modal="true" aria-label={uiText("选择编辑器")}>
    <h2>{uiText("选择编辑器")}</h2><p>{task.name}</p>
    <p className="muted">{uiText("打开已有工作副本，更换编辑器不会复制第二份。外部保存并关闭后，再回到应用完成编辑。")}</p>
    <label>{uiText("使用应用")}<select autoFocus aria-label={uiText("编辑器应用")} disabled={busy} value={valid ? chosen : ''} onChange={e => setChosen(e.target.value)}>
      <option value="" disabled>{uiText("请选择编辑器")}</option>
      {options.systemAllowed && <option value="system">{uiText("系统默认应用")}</option>}
      {options.editors.map(editor => <option key={editor.id} value={editor.id}>{editor.title}</option>)}
    </select></label>
    <button disabled={busy} onClick={() => void run(async () => {
      const editor = await host.fileEditing.chooseEditor()
      if (editor && alive.current) {
        const request = ++generation.current, next = await host.fileEditing.editorOptions(task.id)
        if (alive.current) { if (request === generation.current) setOptions(next); setChosen(editor.id) }
      }
    })}>{uiText("选择其他应用…")}</button>
    {options.format ? <label className="editor-remember"><input type="checkbox" checked={remember} disabled={busy} onChange={e => setRemember(e.target.checked)} />{uiText("在当前仓库中，默认用此应用编辑 .")}{options.format}{' '}{uiText("文件")}</label>
      : <p className="muted">{uiText("此文件没有扩展名，本次选择不会应用到其他无扩展名文件。")}</p>}
    {error && <p className="file-editing-error" role="alert">{error}</p>}
    <footer><button disabled={busy} onClick={close}>{uiText("取消")}</button><button className="primary" disabled={busy || !valid} onClick={() => void run(async () => {
      await host.fileEditing.open(task.id, { editorId: chosen, remember })
      if (alive.current) close()
      host.notify(uiText("已打开工作副本；外部保存并关闭后，在“编辑中”完成编辑"))
    })}>{busy ? uiText("正在打开…") : uiText("打开工作副本")}</button></footer>
  </section>
}
