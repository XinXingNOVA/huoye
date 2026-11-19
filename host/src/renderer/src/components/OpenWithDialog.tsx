import { useState } from 'react'
import type { OpenChoice } from '../openers'
import './open-with.css'

export function OpenWithDialog({ title, choices, preferred, type, other, open, close }: {
  title: string; choices: OpenChoice[]; preferred?: string; type?: string; other: boolean
  open(choice: OpenChoice, remember: boolean, other: boolean): Promise<void>; close(): void
}) {
  const [selected, select] = useState(choices.some(o => o.id === preferred) ? preferred! : 'host.auto')
  const [remember, setRemember] = useState(false), [inOther, setOther] = useState(other)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const choice = choices.find(o => o.id === selected)!
  return <form className="open-with" role="dialog" aria-modal="true" aria-label="打开方式" onSubmit={async e => {
    e.preventDefault(); if (busy) return
    setBusy(true); setError('')
    try { await open(choice, remember && !!type && choice.remember, inOther); close() }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }}>
    <h2>打开方式</h2><p className="open-with-name" title={title}>{title}</p>
    {preferred && !choices.some(o => o.id === preferred) && <p className="open-with-hint">原默认方式暂不可用，当前将自动选择；原偏好仍保留。</p>}
    <fieldset disabled={busy} aria-label="选择打开方式">
      {choices.map(o => <label className="open-with-choice" key={o.id}>
        <input type="radio" autoFocus={selected === o.id} name="opener" value={o.id} checked={selected === o.id} onChange={() => select(o.id)} />
        <span><strong>{o.title}{preferred === o.id && <small>默认</small>}</strong><span>{o.detail}</span></span>
      </label>)}
    </fieldset>
    <label className="open-with-option"><input type="checkbox" checked={inOther} disabled={busy || selected === 'host.system'} onChange={e => setOther(e.target.checked)} />在另一组打开</label>
    <label className="open-with-option"><input type="checkbox" checked={remember && choice.remember && !!type} disabled={busy || !type || !choice.remember} onChange={e => setRemember(e.target.checked)} />{type ? `记住为此仓库 .${type} 文件的默认方式（仅本机）` : '无文件类型的内容仅选择本次打开方式'}</label>
    {remember && selected === 'host.auto' && <p className="open-with-hint">将清除此类型的默认选择，恢复按插件优先级打开。</p>}
    {error && <p role="alert" className="open-with-error">{error}</p>}
    <div className="open-with-actions"><button type="button" onClick={close} disabled={busy}>取消</button><button type="submit" className="primary" disabled={busy}>{busy ? '正在打开…' : '打开'}</button></div>
  </form>
}
