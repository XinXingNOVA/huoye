import { useCallback, useEffect, useRef, useState } from 'react'
import type { UiHost } from '../plugin'
import type { PluginDataInfo, PluginDataPreview, PluginDataCleanupResult } from '../../../shared/plugin-data'
import { SectionHeader, SettingGroup, SettingRow } from './ui-primitives'
import type { LocalDataInfo } from '../../../shared/plugin-local'
import { LocalDataDetail, localDataSummary, useLocalDataList } from './PluginLocalDataMaintenance'
import './plugin-data-maintenance.css'

const message = (error: unknown) => error instanceof Error ? error.message : String(error)
type Mode = PluginDataPreview['mode']

/** 设置仅组合仓库维护服务，不推断数据归属，也不直接卸载或停用插件。 */
export function PluginDataMaintenance({ host, active }: { host: UiHost; active: boolean }) {
  const [items, setItems] = useState<PluginDataInfo[]>()
  const local = useLocalDataList('library', active)
  const [localTarget, setLocalTarget] = useState<LocalDataInfo>()
  const [selected, setSelected] = useState<PluginDataInfo>()
  const [mode, setMode] = useState<Mode>('all')
  const [plan, setPlan] = useState<PluginDataPreview>()
  const [result, setResult] = useState<PluginDataCleanupResult>()
  const [error, setError] = useState('')
  const [listError, setListError] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(false)
  const [confirmed, setConfirmed] = useState(false)
  const [uncertain, setUncertain] = useState(false)
  const alive = useRef(true), action = useRef(false), ticket = useRef(0)
  useEffect(() => { alive.current = true; return () => { alive.current = false; ticket.current++ } }, [])
  useEffect(() => host.settings.registerGuard('host.plugin-data-maintenance', {
    state: () => ({ busy: action.current, message: '正在处理插件数据，请等待结果后再关闭或重载' })
  }), [host.settings])

  const refresh = useCallback(async () => {
    const current = ++ticket.current
    setLoading(true); setListError('')
    try {
      const values = await host.core.listPluginData()
      if (alive.current && current === ticket.current) setItems(values)
    } catch (e) { if (alive.current && current === ticket.current) setListError(message(e)) }
    finally { if (alive.current && current === ticket.current) setLoading(false) }
  }, [host.core])
  useEffect(() => { if (active) void refresh() }, [active, refresh])

  const preview = async (item: PluginDataInfo, nextMode: Mode) => {
    if (action.current) return
    action.current = true; setBusy(true); setSelected(item); setMode(nextMode)
    setPlan(undefined); setResult(undefined); setError(''); setConfirmed(false); setUncertain(false)
    try {
      const value = await host.core.previewPluginDataCleanup({ pluginId: item.pluginId, mode: nextMode })
      if (alive.current) setPlan(value)
    } catch (e) { if (alive.current) setError(message(e)) }
    finally { action.current = false; if (alive.current) setBusy(false) }
  }
  const execute = async (retry = false) => {
    if (action.current || !selected || (!retry && (!plan || !confirmed || plan.blocked.length))) return
    action.current = true; setBusy(true); setError('')
    try {
      const value = retry ? await host.core.retryPluginDataCleanup({ pluginId: selected.pluginId })
        : await host.core.cleanupPluginData({ pluginId: selected.pluginId, mode: plan!.mode, token: plan!.token })
      if (alive.current) { setResult(value); setPlan(undefined); setConfirmed(false); setUncertain(false); await refresh() }
    } catch (e) {
      if (alive.current) {
        const text = message(e)
        setError(text)
        if (/PLUGIN_DATA_CHANGED|PLUGIN_DATA_BLOCKED/.test(text)) { setPlan(undefined); setConfirmed(false); setUncertain(false) }
        else setUncertain(!retry) // 超时可能已经提交；保持原 token，重试读取回执，不重新预览后重复写入。
      }
    } finally { action.current = false; if (alive.current) setBusy(false) }
  }
  const goToPlugins = async () => {
    try { await host.openSettings({ scope: 'library', section: 'plugins' }) }
    catch (e) { setError(message(e)) }
  }
  const back = () => { if (!action.current) { setSelected(undefined); setPlan(undefined); setResult(undefined); setError(''); setUncertain(false); void refresh() } }
  const hasWork = !!plan && (plan.blocks > 0 || plan.entities > 0 || plan.historyOperations > 0 || !!plan.reviewBatches || plan.resetSchema || plan.cacheFiles > 0)
  const current = items?.find(p => p.pluginId === selected?.pluginId) ?? selected
  const pending = result?.pendingCaches.length ?? current?.pendingCaches ?? 0

  const refreshLists = () => { void refresh(); void local.refresh() }

  if (localTarget) return <section className="plugin-data-maintenance" data-local-maintenance="library">
    <LocalDataDetail item={local.items?.find(entry => entry.pluginId === localTarget.pluginId) ?? localTarget}
      title={items?.find(entry => entry.pluginId === localTarget.pluginId)?.title ?? localTarget.pluginId} scope="library" settings={host.settings}
      refresh={local.refresh} back={() => { setLocalTarget(undefined); refreshLists() }} />
  </section>

  return <section className="plugin-data-maintenance" data-local-maintenance="library" aria-label="插件数据与偏好重置" aria-busy={busy}>
    <SectionHeader title={selected ? '插件仓库数据' : '按插件管理'}
      subtitle={selected ? '清理范围限于当前仓库。' : '仓库数据随库保存，本机偏好仅用于这台设备。'}
      actions={selected ? <button className="small" disabled={busy} onClick={back}>返回列表</button>
        : <button className="small" disabled={loading || busy} onClick={refreshLists}>刷新列表</button>} />
    {listError && <p role="alert" className="package-error">仓库数据读取失败 · {listError}</p>}
    {local.error && <p role="alert" className="package-error">本机偏好读取失败 · {local.error}</p>}
    {!selected ? <PluginDataList items={items} localItems={local.items}
      loading={(!items && !listError) || (!local.items && !local.error)} failed={!!listError || !!local.error}
      openData={item => void preview(item, item.protected ? 'derived' : 'all')} openLocal={setLocalTarget} /> : <div className="plugin-data-detail" data-plugin-data-detail={selected.pluginId}>
      <h3>{selected.title}</h3>
      {!selected.declared && selected.persistentBlocks > 0 && <p className="muted">尚无独立记录清理声明。可先安装新版插件并启用一次，再停用重载；无法核验的记录会保留。</p>}
      {!result && <div className="plugin-data-modes" role="group" aria-label="清理范围">
        <button className={`small${mode === 'derived' ? ' active' : ''}`} aria-pressed={mode === 'derived'} disabled={busy || uncertain}
          onClick={() => void preview(selected, 'derived')}>仅派生数据</button>
        <button className={`small${mode === 'all' ? ' active' : ''}`} aria-pressed={mode === 'all'} disabled={busy || uncertain || selected.protected}
          onClick={() => void preview(selected, 'all')}>插件数据与定义</button>
      </div>}
      {error && <p className="package-error" role="alert">{error}</p>}
      {busy && <p className="muted" role="status">正在处理，请稍候…</p>}
      {plan && <div data-plugin-data-preview>
        <p className="muted">{mode === 'derived' ? '保留持久数据和类型定义；下次启用插件后可重新加工。' : '移除可清理的数据；混合记录和仍被引用的内容会保留。'}</p>
        <dl className="plugin-data-counts">
          <dt>移除数据块</dt><dd>{plan.blocks} 个 · 涉及 {plan.preservedEntities} 个保留条目</dd>
          <dt>删除独立记录</dt><dd>{plan.entities} 个</dd>
          <dt>候选缓存文件</dt><dd>{plan.cacheFiles} 个</dd>
          {!!plan.reviewBatches && <><dt>一并清理的批次验收单</dt><dd>{plan.reviewBatches} 张</dd></>}
          <dt>失效的撤销操作</dt><dd>{plan.historyOperations} 笔</dd>
          <dt>重置结构记录</dt><dd>{plan.resetSchema ? '是' : '否'}</dd>
        </dl>
        {plan.removedKinds.length > 0 && <ul className="plugin-data-kinds">{plan.removedKinds.map(k => <li key={k.id}>{k.title}：{k.blocks} 个数据块</li>)}</ul>}
        <Retained items={plan.retained} />
        <details><summary>保留范围与插件说明</summary><ul>{plan.retainedEffects.map((text, i) => <li key={i}>{text}</li>)}</ul></details>
        {plan.blocked.length > 0 ? <div className="plugin-data-blocked" role="status">
          {plan.blocked.map(text => <p key={text}>{text}</p>)}
          {selected.enabled && <button className="small" disabled={busy} onClick={() => void goToPlugins()}>前往功能与方案</button>}
        </div> : hasWork ? <>
          <p className="plugin-data-warning">此操作不可撤销，相关历史将整笔失效。素材原件保留。</p>
          <label className="plugin-data-confirm"><input type="checkbox" checked={confirmed} disabled={busy || uncertain} onChange={e => setConfirmed(e.target.checked)} />我已核对影响范围，确认清理</label>
          {uncertain && <p role="status">尚未确认执行结果。请重试此次清理，已提交的部分不会重复执行。</p>}
          <button className="small danger" data-plugin-data-execute disabled={busy || !confirmed} onClick={() => void execute()}>{uncertain ? '重试此次清理' : '确认清理'}</button>
        </> : <p className="muted" role="status">当前范围没有可清理的数据。</p>}
      </div>}
      {!plan && !result && !busy && <button className="small" onClick={() => void preview(selected, mode)}>重新预览</button>}
      {result && <div data-plugin-data-result role="status">
        <h4>{result.pendingCaches.length ? '数据已处理，缓存待重试' : result.retained.length || result.retainedCaches.length ? '清理已执行，部分内容保留' : '本次清理完成'}</h4>
        <p>移除 {result.blocks} 个数据块，删除 {result.entities} 个独立记录，清理 {result.removedCaches} 个缓存文件。</p>
        <p>{result.resetSchema ? '旧结构记录已重置。' : '结构记录保留。'}{result.historyOperations > 0 && ` ${result.historyOperations} 笔相关撤销操作已失效。`}</p>
        <Retained items={result.retained} />
        {result.pendingCaches.length > 0 && <details open><summary>待重试的缓存（{result.pendingCaches.length}）</summary><ul>{result.pendingCaches.map(c => <li key={c.reference}><code>{c.reference}</code>：{c.error}</li>)}</ul></details>}
        {result.retainedCaches.length > 0 && <details><summary>保留的缓存（{result.retainedCaches.length}）</summary><p>仍有引用、文件已改变，或无法安全核验。</p><ul>{result.retainedCaches.map(ref => <li key={ref}><code>{ref}</code></li>)}</ul></details>}
        <details><summary>本次未处理的范围</summary><ul>{result.retainedEffects.map((text, i) => <li key={i}>{text}</li>)}</ul></details>
      </div>}
      {pending > 0 && <button className="small" data-plugin-data-retry disabled={busy || current?.enabled} onClick={() => void execute(true)}>重试缓存清理</button>}
    </div>}
  </section>
}

type PluginRow = { id: string; data?: PluginDataInfo; local?: LocalDataInfo }

function PluginDataList({ items, localItems, loading, failed, openData, openLocal }: {
  items?: PluginDataInfo[]; localItems?: LocalDataInfo[]; loading: boolean; failed: boolean
  openData: (item: PluginDataInfo) => void; openLocal: (item: LocalDataInfo) => void
}) {
  const byId = new Map<string, PluginRow>()
  for (const data of items ?? []) byId.set(data.pluginId, { id: data.pluginId, data })
  for (const local of localItems ?? []) byId.set(local.pluginId, { ...byId.get(local.pluginId), id: local.pluginId, local })
  const rows = [...byId.values()].sort((a, b) => Number(!!a.data?.enabled) - Number(!!b.data?.enabled)
    || (a.data?.title ?? a.id).localeCompare(b.data?.title ?? b.id))
  const listed: PluginRow[] = [], others: PluginRow[] = []
  for (const row of rows) {
    const data = row.data
    if (row.local || data?.persistentBlocks || data?.derivedBlocks || data?.pendingCaches || data?.hasSchemaContract) listed.push(row)
    else others.push(row)
  }
  const renderRow = ({ id, data, local: entry }: PluginRow) => <SettingRow key={id} data-plugin-data-row={id}
    title={<>{data?.title ?? id}{data && <span className="plugin-data-state">{data.enabled ? '运行中' : '未运行'}{data.protected ? ' · 核心功能' : ''}</span>}</>}
    description={<>
      {data && <span className="plugin-data-summary">持久块 {data.persistentBlocks} · 派生块 {data.derivedBlocks}
        {data.hasSchemaContract && ' · 有结构记录'}{data.pendingCaches > 0 && <strong> · {data.pendingCaches} 个缓存待重试</strong>}</span>}
      {entry && <span className="plugin-data-summary">{localDataSummary(entry)}</span>}
    </>}>
    {data && <button className="small" onClick={() => openData(data)}>仓库数据…</button>}
    {entry && <button className="small" data-local-plugin={id} onClick={() => openLocal(entry)}>本机偏好…</button>}
  </SettingRow>
  return <>
    {loading && <p className="muted">正在读取插件数据…</p>}
    {!loading && !failed && !listed.length && <p className="muted">当前仓库没有已记录的数据块、结构或本机偏好。</p>}
    {listed.length > 0 && <SettingGroup>{listed.map(renderRow)}</SettingGroup>}
    {others.length > 0 && <details className="plugin-data-others"><summary>其余已登记插件（{others.length}）</summary>
      <SettingGroup>{others.map(renderRow)}</SettingGroup>
    </details>}
  </>
}

function Retained({ items }: { items: PluginDataPreview['retained'] }) {
  return items.length ? <details className="plugin-data-retained"><summary>保留的记录（{items.length}）</summary>
    <ul>{items.map(item => <li key={item.id}><code title="记录 ID">{item.id}</code>：{item.reason}</li>)}</ul>
  </details> : null
}
