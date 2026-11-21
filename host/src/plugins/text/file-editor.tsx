import { uiText, useUiLocale } from '../../shared/i18n/interface-display'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { EntityView } from '../../shared/blocks'
import type { UiHost } from '../../plugin-api/ui/contracts'
import type { FileEditCapabilities, FileEditPreview, CommitFileEdit, PrepareFileEdit } from '../../shared/file-edits'
import type { FileStorageInfo } from '../../shared/file-storage'
import { Editor } from './editor'
import './style.css'

type Draft = { text: string; path: string; seq: number }
/** 文件保存为明确版本；本机编辑草稿在重载时保留，未迁移文件须先迁移后编辑。 */
function FileEditorBody({ view, host, initial, done, note }: { view: EntityView; host: UiHost; initial: string; done(): void; note?: string }) {
  useUiLocale()
  const key = `rm-file-editor:${host.url(`cache/draft-${view.id}`)}`
  const [draft, setDraft] = useState<Draft>(() => {
    try { const value = JSON.parse(localStorage.getItem(key) ?? 'null'); if (value && typeof value.text === 'string' && typeof value.path === 'string' && typeof value.seq === 'number') return value } catch { /* 不解释坏草稿 */ }
    return { text: initial, path: String(view.blocks.file.data.path), seq: view.blocks.file.seq }
  })
  const [info, setInfo] = useState<FileStorageInfo>(), [caps, setCaps] = useState<FileEditCapabilities>()
  const [destination, setDestination] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [prepared, setPrepared] = useState<FileEditPreview>()
  const [restoredAttempt] = useState<{ input: PrepareFileEdit; commit?: CommitFileEdit } | undefined>(() => {
    try { const value = JSON.parse(localStorage.getItem(key + ':attempt') ?? 'null'); if (value?.input?.id === view.id) return value } catch { /* 旧或损坏的本机状态不执行 */ }
    return undefined
  })
  const attempt = useRef(restoredAttempt)
  const [editorKey, setEditorKey] = useState(0)
  const [savedText, setSavedText] = useState(initial)
  useEffect(() => { let active = true
    void Promise.all([host.core.fileStorageInfo(view.id),host.core.fileEditCapabilities(view.id)]).then(([i,c])=>{if(active){setInfo(i);setCaps(c);setDestination(i.mode==='private'&&c.publish.allowed?'publish':c.copyTargets[0]?.spaceId??'')}}).catch(e=>{if(active)setError(String(e))})
    return ()=>{active=false}
  },[host,view.id])
  const changed = (text: string) => {
    const next = { ...draft, text }; setDraft(next)
    try { localStorage.setItem(key,JSON.stringify({ ...next, version: 1 })) } catch { setError(uiText("本机草稿保存失败，请保持此页面并复制未保存内容。")) }
  }
  const run = async (fn:()=>Promise<void>) => {if(busy)return;setBusy(true);setError('');try{await fn()}catch(e){setError(String(e))}finally{setBusy(false)}}
  const commit = async () => {
    const current=attempt.current!
    const result=await host.core.commitFileEdit(current.commit!)
    if(result.library.state!=='accepted')throw new Error(uiText("文件已保存，但本库未接纳：{error}。请保留草稿并刷新检查。", { error: String(result.library.error) }))
    const latest=(await host.core.get([view.id]))[0].blocks.file
    const next={text:current.input.content.type==='text'?current.input.content.text:draft.text,path:String(latest.data.path),seq:latest.seq}
    setSavedText(next.text);setDraft(next);localStorage.removeItem(key);localStorage.removeItem(key + ':attempt');attempt.current=undefined;setPrepared(undefined)
    const [i,c]=await Promise.all([host.core.fileStorageInfo(view.id),host.core.fileEditCapabilities(view.id)])
    setInfo(i);setCaps(c);setDestination(i.mode==='private'&&c.publish.allowed?'publish':c.copyTargets[0]?.spaceId??'')
    host.notify(uiText("已保存文件版本；历史内容可在文件空间中恢复。"))
  }
  const prepare = () => run(async()=>{
    if(!destination)throw new Error(uiText("请选择保存方式；没有独享目标时，请先创建或迁移独享空间"))
    attempt.current??={input:{id:view.id,requestId:crypto.randomUUID(),expectedPath:draft.path,expectedSeq:draft.seq,
      destination:destination==='publish'?{mode:'publish'}:{mode:'copy',spaceId:destination},content:{type:'text',text:draft.text}}}
    localStorage.setItem(key + ':attempt',JSON.stringify(attempt.current))
    const p=await host.core.prepareFileEdit(attempt.current.input)
    setPrepared(p);attempt.current.commit??={editId:p.editId,previewToken:p.previewToken,requestId:crypto.randomUUID()}
    localStorage.setItem(key + ':attempt',JSON.stringify(attempt.current))
    if(info?.mode==='private'&&attempt.current.input.destination.mode==='publish')await commit()
  })
  const abandon = () => run(async()=>{
    if(attempt.current){
      await host.core.discardFileEdit({prepareRequestId:attempt.current.input.requestId,requestId:crypto.randomUUID()})
    }
    attempt.current=undefined;localStorage.removeItem(key + ':attempt');setPrepared(undefined)
  })
  if(!info)return <p role="status">{error||uiText("正在检查文件保存方式…")}</p>
  if(!info.contentVersion)return <Editor self={view.id} host={host} initial={draft.text} done={done} save={() => {}} readOnly note={uiText("此文件仍使用旧存储格式，新版已停止读取，请使用归档迁移工具处理副本后再打开。本机草稿保留。")} />
  return <Editor key={editorKey} self={view.id} host={host} initial={draft.text} done={done} manual readOnly={busy||!!attempt.current} onDraft={changed} save={()=>void prepare()}
    note={[note,uiText("文件修改需点击保存或按 ⌘/Ctrl+S；未保存草稿保留在本机。已保存内容通过文件版本恢复。")].filter(Boolean).join('。')}
    actions={<div className="file-editor-actions">
      <div><select aria-label={uiText("文件保存方式")} value={destination} disabled={busy||!!attempt.current} onChange={e=>setDestination(e.target.value)}>
        <option value="">{uiText("选择保存方式")}</option>{caps?.publish.allowed&&<option value="publish">{info.mode==='shared'?uiText("发布共享原件新版"):uiText("保存到独享原件")}</option>}
        {caps?.copyTargets.map(t=><option key={t.spaceId} value={t.spaceId}>{uiText("独立副本 ·")}{' '}{t.name}</option>)}
      </select><button className="small primary" disabled={busy||!!prepared||(!attempt.current&&draft.text===savedText)} onClick={()=>void prepare()}>{busy?uiText("处理中…"):attempt.current?uiText("重试准备"):uiText("保存文件")}</button></div>
      {!caps?.publish.allowed&&<p className="muted">{caps?.publish.reason}</p>}
      {(draft.path!==view.blocks.file.data.path||draft.seq!==view.blocks.file.seq)&&<p role="alert">{uiText("文件信息已变化。保存前请复制草稿，重新打开并核对；不会自动覆盖新版。")}</p>}
      {prepared&&<div><p>{prepared.mode==='copy'?uiText("将另存独立副本并切换本素材引用。"):uiText("将发布原件新版；其他仓库按各自规则接纳。")}{uiText("旧内容与附加数据保留。")}</p><button className="small" disabled={busy} onClick={()=>void abandon()}>{uiText("放弃本次准备")}</button><button className="small primary" disabled={busy} onClick={()=>void run(commit)}>{uiText("确认保存")}</button></div>}
      {!prepared&&attempt.current&&<button className="small" disabled={busy} onClick={()=>void abandon()}>{uiText("放弃准备并保留文字")}</button>}
      {!attempt.current && draft.text!==savedText && <button className="small" disabled={busy} onClick={()=>{
        localStorage.removeItem(key);setDraft({text:initial,path:String(view.blocks.file.data.path),seq:view.blocks.file.seq});setSavedText(initial);setEditorKey(k=>k+1)
      }}>{uiText("丢弃本机草稿并重新读取")}</button>}
      {error&&<p role="alert">{error}</p>}
    </div>}/>
}

// 文件发布仍是单编辑者流程；多个阅读页不制造彼此覆盖的发布草稿。
const fileEditors = new WeakMap<object, Map<string, { owner?: symbol; listeners: Set<() => void> }>>()
export function FileEditor(props: { view: EntityView; host: UiHost; initial: string; done(): void; note?: string }) {
  useUiLocale()
  const [token] = useState(() => Symbol())
  let map = fileEditors.get(props.host.core)
  if (!map) { map = new Map(); fileEditors.set(props.host.core, map) }
  let lock = map.get(props.view.id)
  if (!lock) { lock = { listeners: new Set() }; map.set(props.view.id, lock) }
  const current = lock
  const owner = useSyncExternalStore(listener => { current.listeners.add(listener); return () => { current.listeners.delete(listener) } }, () => current.owner)
  useEffect(() => {
    if (current.owner) return
    current.owner = token; current.listeners.forEach(l => l())
  }, [current, token, owner])
  useEffect(() => () => { if (current.owner === token) { current.owner = undefined; current.listeners.forEach(l => l()) } }, [current, token])
  return owner === token ? <FileEditorBody {...props} /> : <p role="status">{uiText("此文件正在另一视图中编辑。结束那里的编辑后，可在此继续；原文件仍按版本保存。")}</p>
}
