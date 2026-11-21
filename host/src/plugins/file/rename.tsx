import { uiText, useUiLocale } from '../../shared/i18n/interface-display'
import { acceleratorLabel } from '../../plugin-api/ui/widgets'
// 改名的界面（设计文档 11.14）。一项：改名字，扩展名在旁边、不能改。
// 一批：统一命名加序号，或者替换名字里的文字；下面列出"改之前 → 改之后"，确认了再改。都能撤销。

import { useEffect, useMemo, useRef, useState } from 'react'
import type { EntityView } from '../../shared/blocks'
import type { UiHost, ViewProps } from '../../plugin-api/ui/contracts'
import { isEnter } from '../../plugin-api/ui/widgets'
import { planRenames, renamed, splitName, type RenameRule } from './names'

const nameOf = (v: EntityView) => String(v.blocks.file.data.name)
const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** 把改名交给核心进程（文件插件的命令）：names 是"身份 → 新名字（不含扩展名）"。 */
async function apply(host: UiHost, names: Record<string, string>): Promise<void> {
  await host.core.run('file', 'rename', { names })
  host.notify(uiText("已重命名{value1}，可以撤销（{value2}）", { value1: String(Object.keys(names).length > 1 ? uiText(" {length} 项", { length: String(Object.keys(names).length) }) : ''), value2: String(acceleratorLabel('CmdOrCtrl+Z')) }))
}

export function RenameDialog({ views, host, close }: { views: EntityView[]; host: UiHost; close(): void }) {
  return views.length === 1 ? <RenameOne view={views[0]} host={host} close={close} /> : <RenameMany views={views} host={host} close={close} />
}

export function FileTitleEditor({ view, host, onDone }: ViewProps & { onDone(): void }) {
  return <RenameOne view={view} host={host} close={onDone} inline />
}
function RenameOne({ view, host, close, inline = false }: { view: EntityView; host: UiHost; close(): void; inline?: boolean }) {
  useUiLocale()
  const name = nameOf(view)
  const { base, ext } = splitName(name)
  const [value, setValue] = useState(base)
  const [error, setError] = useState<string>()
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const submitting = useRef(false)
  // 打开就选中名字（不含扩展名），直接打字就是改
  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [])

  const submit = async () => {
    if (submitting.current) return
    submitting.current = true; setBusy(true)
    try {
      if (renamed(name, value) !== name) await apply(host, { [view.id]: value })
      close()
    } catch (e) {
      setError(message(e))
    } finally { submitting.current = false; setBusy(false) }
  }

  if (inline) return <div className="inspector-title-editor" onKeyDown={e => {
    e.stopPropagation()
    if (e.key === 'Escape' && !busy && !e.nativeEvent.isComposing) { e.preventDefault(); close() }
  }}>
    <div className="rename-row">
      <input ref={input} className="field-text" aria-label={uiText("素材名称")} value={value} disabled={busy} spellCheck={false}
        onChange={e => { setValue(e.target.value); setError(undefined) }}
        onKeyDown={e => { if (isEnter(e)) { e.preventDefault(); void submit() } }} />
      {ext && <span className="rename-ext muted">{ext}</span>}
    </div>
    {error && <div className="export-failed" role="alert">{error}</div>}
    <div className="inspector-title-edit-actions"><button className="small" disabled={busy} onClick={close}>{uiText("取消")}</button><button className="small" disabled={busy} onClick={() => void submit()}>{busy ? uiText("保存中…") : uiText("保存")}</button></div>
  </div>

  return (
    <>
      <div className="export-title">{uiText("重命名")}</div>
      <div className="rename-row">
        <input
          ref={input}
          className="field-text"
          value={value}
          spellCheck={false}
          onChange={(e) => {
            setValue(e.target.value)
            setError(undefined)
          }}
          onKeyDown={(e) => {
            if (isEnter(e)) void submit()
          }}
        />
        {ext && <span className="rename-ext muted">{ext}</span>}
      </div>
      {error && <div className="export-failed">{error}</div>}
      <div className="export-hint muted">{uiText("独立文件同时修改磁盘文件名；共享文件只修改本仓库中的名称，导出使用新名称。扩展名不变。")}</div>
      <div className="export-actions">
        <button className="small" onClick={close}>{uiText("取消")}{' '}</button>
        <button className="small primary" onClick={() => void submit()}>{uiText("改名")}{' '}</button>
      </div>
    </>
  )
}

/** 预览里最多列出几项。 */
const SHOW = 8

function RenameMany({ views, host, close }: { views: EntityView[]; host: UiHost; close(): void }) {
  useUiLocale()
  const [mode, setMode] = useState<RenameRule['type']>('number')
  const [base, setBase] = useState('')
  const [start, setStart] = useState(1)
  const [find, setFind] = useState('')
  const [replace, setReplace] = useState('')
  const [error, setError] = useState<string>()

  const plan = useMemo(() => {
    const rule: RenameRule = mode === 'number' ? { type: 'number', base, start } : { type: 'replace', find, with: replace }
    return planRenames(
      views.map((v) => ({ id: v.id, name: nameOf(v) })),
      rule
    )
  }, [views, mode, base, start, find, replace])
  const changes = plan.filter((p) => p.to && p.to !== p.from)
  const bad = plan.filter((p) => p.error)
  // 统一命名要先写个名称：不然一回车就全成了 01、02……
  const unnamed = mode === 'number' && !base.trim()
  const ready = changes.length > 0 && bad.length === 0 && !unnamed

  const submit = async () => {
    if (!ready) return
    try {
      await apply(host, Object.fromEntries(changes.map((p) => [p.id, p.base!])))
      close()
    } catch (e) {
      setError(message(e))
    }
  }
  const enter = (e: React.KeyboardEvent) => {
    if (isEnter(e)) void submit()
  }

  return (
    <>
      <div className="export-title">{uiText("重命名")}{' '}{views.length}{' '}{uiText("项")}</div>
      <div className="rename-modes">
        <button className={`small${mode === 'number' ? ' on' : ''}`} onClick={() => setMode('number')}>{uiText("统一命名，加序号")}{' '}</button>
        <button className={`small${mode === 'replace' ? ' on' : ''}`} onClick={() => setMode('replace')}>{uiText("替换文字")}{' '}</button>
      </div>
      {mode === 'number' ? (
        <div className="rename-row">
          <input className="field-text" autoFocus value={base} placeholder={uiText("名称，例如 海报")} spellCheck={false} onChange={(e) => setBase(e.target.value)} onKeyDown={enter} />
          <span className="muted">{uiText("序号从")}</span>
          <input
            className="field-text rename-start"
            type="number"
            min={0}
            value={start}
            onChange={(e) => setStart(Math.max(0, Math.floor(Number(e.target.value) || 0)))}
            onKeyDown={enter}
          />
          <span className="muted">{uiText("开始")}</span>
        </div>
      ) : (
        <div className="rename-row">
          <span className="muted">{uiText("把")}</span>
          <input className="field-text" autoFocus value={find} placeholder={uiText("名字里的一段字")} spellCheck={false} onChange={(e) => setFind(e.target.value)} onKeyDown={enter} />
          <span className="muted">{uiText("换成")}</span>
          <input className="field-text" value={replace} placeholder={uiText("（留空就是删掉）")} spellCheck={false} onChange={(e) => setReplace(e.target.value)} onKeyDown={enter} />
        </div>
      )}
      <ul className="rename-preview">
        {plan.slice(0, SHOW).map((p) => (
          <li key={p.id} className={p.error ? 'bad' : p.to === p.from ? 'same' : ''}>
            <span className="rename-from">{p.from}</span>
            <span className="muted">→</span>
            <span className="rename-to">{p.error ?? p.to}</span>
          </li>
        ))}
        {plan.length > SHOW && <li className="muted">{uiText("还有")}{' '}{plan.length - SHOW}{' '}{uiText("项")}</li>}
      </ul>
      <div className="export-hint muted">
        {unnamed
          ? uiText("先写一个名称")
          : bad.length > 0
          ? uiText("{length} 项改完不能用，先调整一下", { length: String(bad.length) })
          : uiText("会改 {length} 项{value2}。扩展名不变，能撤销。", { length: String(changes.length), value2: String(plan.length - changes.length ? uiText("，{value1} 项名字不变", { value1: String(plan.length - changes.length) }) : '') })}
      </div>
      {error && <div className="export-failed">{error}</div>}
      <div className="export-actions">
        <button className="small" onClick={close}>{uiText("取消")}{' '}</button>
        <button className="small primary" disabled={!ready} onClick={() => void submit()}>{uiText("改名")}{' '}</button>
      </div>
    </>
  )
}
