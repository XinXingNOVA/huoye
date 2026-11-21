import { uiText, useUiLocale } from '../../../shared/i18n/interface-display'
import { useCallback, useRef, useState } from 'react'
import { Button, Select } from '../../../plugin-api/ui/kit'
import { useUiEffect } from '../../../plugin-api/ui/hooks'
import { formatBytes } from '../../../shared/format'
import type { DirectoryCatalogInfo, MissingCleanupPreview } from '../../../shared/directory-spaces'

type Action = { kind: 'forget' } | { kind: 'remove'; member: DirectoryCatalogInfo['members'][number] } | { kind: 'missing'; preview: MissingCleanupPreview }
const statusText = { get online() { return uiText("来源在线") }, get offline() { return uiText("来源离线或不可访问") }, get replaced() { return uiText("来源位置已被替换") }, get retiring() { return uiText("登记簿清理待完成") }, get unreadable() { return uiText("登记簿不可读取") } }

function CatalogRow({ row, refresh }: { row: DirectoryCatalogInfo; refresh(): Promise<void> }) {
  useUiLocale()
  const [action, setAction] = useState<Action>(), [days, setDays] = useState(30)
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const api = window.bridge.spaces.directories.maintenance
  async function run(fn: () => Promise<void>) {
    setBusy(true); setError(''); setNotice('')
    try { await fn() } catch (e) { setAction(undefined); setError(String(e)) }
    finally { setBusy(false) }
  }
  async function apply() {
    if (!action) return
    if (action.kind === 'forget') await api.forget(row.id)
    if (action.kind === 'remove') await api.removeMember(row.id, action.member)
    if (action.kind === 'missing') {
      const count = await api.cleanMissing(row.id, action.preview.cutoff, action.preview.token)
      setNotice(uiText("已清理 ") + count + uiText(" 条缺失追踪记录。"))
    }
    setAction(undefined); await refresh()
  }
  return <details className="space-confirm">
    <summary>{row.name} · {statusText[row.status]} · {row.members.length}{' '}{uiText("个仓库 ·")}{' '}{formatBytes(row.bytes)}</summary>
    {row.root && <p className="breakable">{row.root}</p>}
    <p className="muted">{uiText("空间 ID ·")}{' '}<code>{row.id}</code></p>
    {row.error && <p role="alert">{row.error}</p>}
    {row.status !== 'unreadable' && <>
      <p>{row.entries}{' '}{uiText("个已登记文件 ·")}{' '}{row.missing}{' '}{uiText("条缺失记录")}</p>
      {row.members.map(m => <div key={m.id + m.root} className="space-actions">
        <span className="breakable">{m.root} · {m.available ? uiText("仓库可用") : uiText("仓库位置未确认")}</span>
        {!m.available && <Button size="sm" disabled={busy} onClick={() => setAction({ kind: 'remove', member: m })}>{uiText("解除此成员…")}</Button>}
      </div>)}
      {!!row.missing && <div className="space-actions">
        <Select aria-label={uiText("缺失记录保留期")} value={String(days)} disabled={busy} onChange={e => { setDays(Number(e.target.value)); setAction(undefined) }}>
          <option value="30">{uiText("缺失满 30 天")}</option><option value="90">{uiText("缺失满 90 天")}</option><option value="0">{uiText("全部缺失记录")}</option>
        </Select>
        <Button size="sm" disabled={busy} onClick={() => void run(async () => {
          const preview = await api.previewMissing(row.id, days)
          if (preview.count) setAction({ kind: 'missing', preview })
          else { setAction(undefined); setNotice(uiText("所选时段没有可清理的缺失记录。")) }
        })}>{uiText("预览清理缺失记录…")}</Button>
      </div>}
      {!row.members.length && <Button size="sm" disabled={busy} onClick={() => setAction({ kind: 'forget' })}>{row.status === 'retiring' ? uiText("继续清理登记簿…") : uiText("忘记本机登记簿…")}</Button>}
    </>}
    {action && <div className="space-confirm" role="group" aria-label={uiText("确认原地登记维护")}>
      {action.kind === 'forget' && <p>{uiText("忘记「")}{row.name}{uiText("」将移除本机的文件身份和位置记录。已解除关联的仓库可能仍引用这些身份，重新登记同一目录也可能无法接回旧引用。原文件和仓库数据保留。")}</p>}
      {action.kind === 'remove' && <p>{uiText("解除")}{' '}{action.member.root}{' '}{uiText("的来源访问。若仓库在离线硬盘上，下次使用时需要重新关联。")}</p>}
      {action.kind === 'missing' && <><p>{uiText("将清理")}{' '}{action.preview.count}{' '}{uiText("条缺失追踪记录。所有关联仓库将失去这些文件自动接回原身份的线索，已有笔记和标签保留。")}</p>
        <ul>{action.preview.examples.map((path, i) => <li key={i}>{path}</li>)}</ul></>}
      <div className="space-actions"><Button size="sm" disabled={busy} onClick={() => setAction(undefined)}>{uiText("取消")}</Button>
        <Button size="sm" variant="danger" disabled={busy} onClick={() => void run(apply)}>{action.kind === 'forget' ? uiText("确认忘记登记簿") : action.kind === 'remove' ? uiText("确认解除此成员") : uiText("确认清理缺失记录")}</Button></div>
    </div>}
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
  </details>
}

export function DirectoryCatalogSettings({ visible }: { visible: boolean }) {
  useUiLocale()
  const [rows, setRows] = useState<DirectoryCatalogInfo[]>(), [error, setError] = useState('')
  const revision = useRef(0)
  const refresh = useCallback(async () => {
    const ticket = ++revision.current
    try {
      const result = await window.bridge.spaces.directories.maintenance.list()
      if (ticket === revision.current) { setRows(result); setError('') }
    } catch (e) { if (ticket === revision.current) setError(String(e)) }
  }, [])
  useUiEffect(display => {
    if (!visible) return
    void refresh(); display.onWindow('focus', () => void refresh())
    const off = window.bridge.spaces.directories.onChanged(() => void refresh())
    return () => { off(); revision.current++ }
  }, [refresh, visible])
  return <section aria-label={uiText("本机原地目录登记簿")}>
    <div className="space-actions"><h3>{uiText("本机原地目录登记簿")}</h3><Button size="sm" onClick={() => void refresh()}>{uiText("刷新登记簿")}</Button></div>
    {rows?.map(row => <CatalogRow key={row.id} row={row} refresh={refresh}/>)}
    {rows && !rows.length && <p className="muted">{uiText("本机没有原地目录登记簿。")}</p>}
    {error && <p role="alert">{error}</p>}
  </section>
}
