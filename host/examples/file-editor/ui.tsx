import { useEffect, useRef, useState } from 'react'
import './ui.css'
import type { UiHost, UiPlugin } from '@resource-manager/plugin-api/ui/contracts'
import type { CommitFileEdit, FileEditCapabilities, FileEditPreview } from '@resource-manager/plugin-api/files'

function Editor({ host }: { host: UiHost }) {
  const [items, setItems] = useState<{ id: string; name: string }[]>([]), [id, setId] = useState(''), [text, setText] = useState('')
  const [caps, setCaps] = useState<FileEditCapabilities>(), [spaceId, setSpaceId] = useState('')
  const [draft, setDraft] = useState<{ preview: FileEditPreview; request: CommitFileEdit }>()
  const [busy, setBusy] = useState(false), [status, setStatus] = useState('')
  const operation = useRef('')
  useEffect(() => {
    let alive = true
    void host.core.searchPage({ query: { has: ['file'] }, limit: 50 }).then(async page => {
      const rows = await host.core.get(page.items.map(i => i.id))
      if (alive) setItems(rows.filter(r => ['txt', 'md'].includes(String(r.blocks.file.data.ext))).map(r => ({ id: r.id, name: String(r.blocks.file.data.name) })))
    }).catch(e => { if (alive) setStatus(String(e)) })
    return () => { alive = false; if (operation.current) void host.core.cancelFileEdit(operation.current) }
  }, [host])
  const run = async (fn: () => Promise<void>) => { setBusy(true); setStatus(''); try { await fn() } catch (e) { setStatus(String(e)) } finally { operation.current = ''; setBusy(false) } }
  const load = () => run(async () => {
    const [row] = await host.core.get([id]), capabilities = await host.core.fileEditCapabilities(id)
    const response = await fetch(host.url(String(row.blocks.file.data.path)))
    if (!response.ok) throw new Error('原件当前不可读')
    const value = await response.text(); if (value.length > 4 * 1024 * 1024) throw new Error('示例只编辑 4M 字符以内的文字文件')
    setText(value); setCaps(capabilities); setSpaceId(capabilities.copyTargets[0]?.spaceId ?? '')
  })
  const prepare = (mode: 'publish' | 'copy') => run(async () => {
    operation.current = crypto.randomUUID()
    const preview = await host.core.prepareFileEdit({ id, requestId: operation.current, content: { type: 'text', text }, destination: mode === 'publish' ? { mode } : { mode, spaceId } })
    setDraft({ preview, request: { editId: preview.editId, previewToken: preview.previewToken, requestId: crypto.randomUUID() } })
  })
  return <section data-file-editor-example>
    <h2>公共文件编辑示例</h2><p>仅用于临时库验证。保存分为准备与确认，不改变其他业务数据，不进入仓库撤销。</p>
    <select className="select" aria-label="示例编辑文件" disabled={busy || !!draft} value={id} onChange={e => { setId(e.target.value); setCaps(undefined) }}><option value="">选择 Markdown / TXT</option>{items.map(i => <option key={i.id} value={i.id}>{i.name}</option>)}</select>
    <button className="small" disabled={busy || !id || !!draft} onClick={() => void load()}>读取原件与能力</button>
    {caps && <><textarea aria-label="示例原文件文字" value={text} disabled={busy || !!draft} rows={8} style={{ width: '100%' }} onChange={e => setText(e.target.value)} />
      <p>{caps.publish.reason}</p><button className="small" disabled={busy || !!draft || !caps.publish.allowed} onClick={() => void prepare('publish')}>准备发布原件新版</button>
      <select className="select" aria-label="示例副本目标" disabled={busy || !!draft} value={spaceId} onChange={e => setSpaceId(e.target.value)}>{caps.copyTargets.map(s => <option key={s.spaceId} value={s.spaceId}>{s.name}</option>)}</select>
      <button className="small" disabled={busy || !!draft || !spaceId} onClick={() => void prepare('copy')}>准备独立副本</button><p>{caps.copyReason}</p></>}
    {draft && <div role="group" aria-label="示例编辑确认"><p>{draft.preview.name} · {draft.preview.size} 字节 · {draft.preview.mode === 'publish' ? '改变空间当前版本，各库按策略接纳' : '保留原件，只让本素材改用独立副本'}</p>
      <button className="small" disabled={busy} onClick={() => void run(async () => { await host.core.discardFileEdit({ editId: draft.preview.editId, requestId: crypto.randomUUID() }); setDraft(undefined) })}>放弃编辑</button>
      <button className="small" disabled={busy} onClick={() => void run(async () => {
        operation.current = draft.preview.editId
        const result = await host.core.commitFileEdit(draft.request)
        setStatus(`文件已保存；本库 ${result.library.state} ${result.library.error ?? ''}`)
        if (result.library.state !== 'pending') { setDraft(undefined); setCaps(undefined) }
      })}>确认保存文件</button></div>}
    {busy && <button className="small" onClick={() => void host.core.cancelFileEdit(operation.current)}>取消处理</button>}
    <p role="status">{status}</p>
  </section>
}
export const plugin: UiPlugin = { id: 'demo-file-editor', settingsSections: [{ id: 'demo-file-editor.settings', scope: 'library', order: 100, Component: Editor }] }
