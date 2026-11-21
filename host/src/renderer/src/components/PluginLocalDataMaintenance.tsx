import { uiText, useUiLocale } from '../../../shared/i18n/interface-display'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { SettingsService } from '../../../plugin-api/ui/settings'
import type { LocalScope } from '../../../plugin-api/local-service'
import type { LocalCategory, LocalDataInfo, LocalDataPreview, LocalDataResult } from '../../../shared/plugin-local'
import { SectionHeader, SettingGroup, SettingRow } from './ui-primitives'
import './plugin-data-maintenance.css'
const titles: Record<LocalCategory, string> = { get settings() { return uiText("本机设置") }, get state() { return uiText("界面偏好") }, get secrets() { return uiText("保存的密钥") } }
const message = (e: unknown) => e instanceof Error ? e.message : String(e)

export function localDataSummary(item: LocalDataInfo) {
  const counts = item.files.filter(file => file.keys.length || file.error)
    .map(file => `${titles[file.category]} ${file.error ? uiText("无法读取") : file.keys.length + uiText(" 项")}`)
  if (item.pending) counts.push(uiText("上次清理待接续"))
  return counts.join(' · ')
}

export function useLocalDataList(scope: LocalScope, active: boolean) {
  const [items, setItems] = useState<LocalDataInfo[]>()
  const [error, setError] = useState('')
  const sequence = useRef(0)
  const refresh = useCallback(async () => {
    const id = ++sequence.current
    try {
      const values = await window.bridge.pluginLocal.list(scope)
      if (id === sequence.current) { setItems(values); setError('') }
    } catch (e) { if (id === sequence.current) setError(message(e)) }
  }, [scope])
  useEffect(() => {
    if (active) void refresh()
    return () => { sequence.current++ }
  }, [active, refresh])
  return { items, error, refresh }
}

export function GlobalPluginDataMaintenance({ settings, active }: { settings: SettingsService; active: boolean }) {
  useUiLocale()
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState<LocalDataInfo>()
  const { items, error, refresh } = useLocalDataList('application', active && open)
  return <details className="global-data-maintenance" onToggle={e => setOpen(e.currentTarget.open)}>
    <summary>{uiText("高级维护 · 全局插件设置与密钥")}</summary>
    <section className="plugin-data-maintenance" data-local-maintenance="application">
      {error && <p role="alert" className="package-error">{error}</p>}
      {selected ? <LocalDataDetail item={items?.find(item => item.pluginId === selected.pluginId) ?? selected} title={selected.pluginId} scope="application" settings={settings}
        refresh={refresh} back={() => { setSelected(undefined); void refresh() }} /> : <>
        <SectionHeader title={uiText("全局本机数据")} subtitle={uiText("这些设置与密钥由此设备上的所有仓库共用。")}
          actions={<button className="small" onClick={() => void refresh()}>{uiText("刷新列表")}</button>} />
        <SettingGroup>{items?.map(item => <SettingRow key={item.pluginId} title={item.pluginId} description={localDataSummary(item)}>
          <button className="small" data-local-plugin={item.pluginId} onClick={() => setSelected(item)}>{uiText("查看与重置…")}</button>
        </SettingRow>)}
        {!items && !error && <p className="muted">{uiText("正在读取…")}</p>}
        {items?.length === 0 && <p className="muted">{uiText("这台设备上没有已保存的全局插件数据。")}</p>}
        </SettingGroup>
      </>}
    </section>
  </details>
}

export function LocalDataDetail({ item, title, scope, settings, refresh, back }: {
  item: LocalDataInfo; title: string; scope: LocalScope; settings: SettingsService; refresh: () => Promise<void>; back: () => void
}) {
  useUiLocale()
  const selected = item.pluginId
  const [categories, setCategories] = useState<LocalCategory[]>(['settings', 'state'])
  const [plan, setPlan] = useState<LocalDataPreview>(), [result, setResult] = useState<LocalDataResult>()
  const [confirmed, setConfirmed] = useState(false), [uncertain, setUncertain] = useState(false)
  const [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const running = useRef(false), mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => settings.registerGuard(`host.plugin-local.${scope}`, { state: () => ({ busy: running.current, message: uiText("本机数据正在处理，请等待结果") }) }), [settings, scope])
  const perform = async (fn: () => Promise<void>) => {
    if (running.current) return
    running.current = true; setBusy(true); setError('')
    try { await fn() } catch(e) { if (mounted.current) setError(message(e)) }
    finally { running.current = false; if (mounted.current) setBusy(false) }
  }
  const preview = () => perform(async () => {
    if (!categories.length) return
    setPlan(undefined); setResult(undefined); setConfirmed(false); setUncertain(false)
    const next = await window.bridge.pluginLocal.preview({ pluginId: selected, scope, categories })
    if (mounted.current) setPlan(next)
  })
  const clean = (retry = false) => perform(async () => {
    if (!retry && (!plan || !confirmed || plan.blocked.length)) return
    try {
      const next = retry ? await window.bridge.pluginLocal.retry({ pluginId: selected, scope }) : await window.bridge.pluginLocal.clean({ pluginId: selected, scope, categories: plan!.categories, token: plan!.token })
      if (mounted.current) { setResult(next); setPlan(undefined); setConfirmed(false); setUncertain(false); await refresh() }
    } catch(e) {
      if (mounted.current && !retry) {
        if (/LOCAL_DATA_CHANGED|LOCAL_DATA_BLOCKED/.test(message(e))) { setPlan(undefined); setConfirmed(false) }
        else setUncertain(true)
      }
      throw e
    }
  })
  const pending = result ? result.items.some(i => i.status === 'pending') : item.pending
  return <div aria-busy={busy}>
    <SectionHeader title={scope === 'application' ? uiText("全局本机数据") : uiText("本库本机偏好")}
      subtitle={scope === 'application' ? uiText("影响这台设备上的所有仓库。") : uiText("只影响当前仓库在这台设备上的设置与偏好。")}
      actions={<button className="small" disabled={busy} onClick={back}>{uiText("返回列表")}</button>} />
    {error && <p role="alert" className="package-error">{error}</p>}
    <div className="plugin-data-detail">
      <h3>{title}</h3>
      {!result && <>
        <div className="plugin-data-modes" role="group" aria-label={uiText("本机清理范围")}>{(Object.keys(titles) as LocalCategory[]).map(category => <label key={category}>
          <input type="checkbox" data-local-category={category} checked={categories.includes(category)} disabled={busy || uncertain} onChange={e => {
            setCategories(old => e.target.checked ? [...old, category] : old.filter(c => c !== category)); setPlan(undefined); setConfirmed(false)
          }} /> {titles[category]}</label>)}</div>
        {!plan && <button className="small" disabled={busy || !categories.length} onClick={() => void preview()}>{uiText("预览影响")}</button>}
      </>}
      {plan && <div data-local-preview>
        {plan.files.map(file => <p key={file.category}><strong>{titles[file.category]}</strong>：{file.keys.length}{' '}{uiText("项")}{file.keys.length > 0 && `（${file.keys.join('、')}）`}{file.error && ` · ${file.error}`}</p>)}
        {plan.blocked.length ? <div role="status">{plan.blocked.map(reason => <p key={reason}>{reason}</p>)}<button className="small" disabled={busy} onClick={() => void preview()}>{uiText("重新检查")}</button></div> : <>
          <p>{uiText("清理不可撤销。界面状态的已迁移标记保留；不会删除保存视图、布局或素材。")}</p>
          {categories.includes('secrets') && <p>{uiText("只移除本机保存的密钥，不会撤销服务商的 Key。这里不读取或展示密钥内容。")}</p>}
          <label className="plugin-data-confirm"><input type="checkbox" data-local-confirm checked={confirmed} disabled={busy || uncertain} onChange={e => setConfirmed(e.target.checked)} />{uiText("我已确认作用范围与清理内容")}</label>
          {uncertain && <p role="status">{uiText("尚未确认结果。重试会核对已提交部分，不重复删除新设置。")}</p>}
          <button className="small danger" data-local-execute disabled={busy || !confirmed} onClick={() => void clean()}>{uncertain ? uiText("重试此次清理") : uiText("确认清理本机数据")}</button>
        </>}
      </div>}
      {result && <div data-local-result role="status"><h4>{result.items.some(i => i.status !== 'done') ? uiText("已处理，部分内容需检查") : uiText("本机数据清理完成")}</h4>
        {result.items.map(item => <p key={item.category}>{titles[item.category]}：{item.status === 'done' ? uiText("已清理") : item.status === 'pending' ? uiText("待重试") : uiText("已保留")}{item.error && ` · ${item.error}`}</p>)}
      </div>}
      {pending && <button className="small" data-local-retry disabled={busy} onClick={() => void clean(true)}>{uiText("接续上次清理")}</button>}
      {busy && <p role="status">{uiText("正在处理…")}</p>}
    </div>
  </div>
}
