import { useEffect, useId, useRef, useState } from 'react'
import { Overlay } from '../../../plugin-api/ui/widgets'
import { canCleanVersion, groupPackages, type PackageInventory } from '../../../shared/package-catalog'
import { packageText, type PackageLocales } from '../../../shared/package-locales'
import type { ExternalBinding, PackageRef, PackageRow } from '../../../shared/external-plugins'
import type { PluginInfo, PluginPlan } from '../../../shared/plugin-plan'
import type { PluginState } from '../../../shared/rpc'
import { hostLabel, uiText, useUiLocale } from '../../../shared/i18n/interface-display'
import { catalogGroup, matchesPlugin, pluginCategories } from '../../../shared/plugin-presentation'
import { DISTRIBUTION } from '../../../plugins/generated/distribution'
import { PluginDetails } from './PluginDetails'
import { useModalFocus } from './modal-focus'
import './plugin-manager.css'

interface LibraryChoices {
  plugins: PluginState[]; draft: ExternalBinding[]; disabledIds: Set<string>; retries: Set<string>; plan: PluginPlan
  onToggle(id: string): void
  onSelect(ref: PackageRef, enabled: boolean): void
  onRetry(hash: string): void
  onEnableRequired(id: string): void
}
interface PackageActions {
  update(row: PackageRow, target?: PackageRow): void
  remove(row: PackageRow): void
  clean(rows: PackageRow[]): void
}
interface Props {
  rows: PackageRow[]
  library?: LibraryChoices
  inventory?: PackageInventory
  actions?: PackageActions
  suite?: { title: string; ids: string[] }
  clearSuite?(): void
  busy: boolean
}

export function PluginChoices({ rows, library, inventory, actions, suite, clearSuite, busy }: Props) {
  const locale = useUiLocale()
  const [query, setQuery] = useState(''), [category, setCategory] = useState('all'), [filter, setFilter] = useState('all')
  const [detail, setDetail] = useState<string>()
  const inLibrary = !!library
  const drawer = useRef<HTMLDivElement>(null), titleId = useId()
  useModalFocus(drawer, !!detail)
  function present(info: PluginInfo & { locales?: PackageLocales }, builtin: boolean) {
    const translate = (s: string) => builtin ? hostLabel(s) : packageText(info.locales, locale, s)
    const catalog = info.catalog && { ...info.catalog, usage: info.catalog.usage && translate(info.catalog.usage), keywords: info.catalog.keywords?.map(translate) }
    return { ...info, title: translate(info.title), description: translate(info.description), catalog }
  }
  const sources: { builtin?: PluginState; versions: PackageRow[] }[] = [
    ...(library?.plugins ?? []).map(builtin => ({ builtin, versions: [] })),
    ...Array.from(groupPackages(rows).values(), versions => ({ versions }))
  ]
  const entries = sources.map(({ builtin, versions }) => {
    const id = (builtin ?? versions[0].manifest).id
    const saved = versions.find(r => r.selected)
    const choice = library?.draft.find(b => b.manifest.id === id)
    const row = versions.find(r => r.hash === choice?.hash) ?? saved ?? versions.find(r => r.installed) ?? versions[0]
    const info = present(builtin ?? row.manifest, !!builtin)
    const enabled = builtin ? !library!.disabledIds.has(id) : !!choice?.enabled
    const retry = !!row && !!library?.retries.has(row.hash)
    const pending = builtin ? enabled === builtin.chosen : retry || enabled !== !!saved?.enabled || !!choice && choice.hash !== saved?.hash
    const reason = enabled ? library?.plan.off.get(id) : undefined
    const missingArchive = versions.some(v => inventory?.versions[v.hash] && inventory.versions[v.hash].bytes === undefined)
    const issue = reason || builtin?.unavailable || (missingArchive ? uiText("本机安装包缺失") : undefined) || (row && !row.installed ? uiText("安装包缺失，请重新安装或取消勾选。") : row?.reason && row.enabled ? row.reason : undefined)
    const cleanable = versions.filter(v => inventory && canCleanVersion(inventory, v.hash))
    const users = new Set(versions.flatMap(v => inventory?.versions[v.hash]?.libraries.map(l => l.root) ?? []))
    const pendingLabel = retry ? uiText("待重试") : enabled && saved?.enabled && choice?.hash !== saved.hash ? uiText("待切换版本") : enabled ? uiText("待启用") : uiText("待停用")
    return { id, info, builtin, versions, row, saved, enabled, pending, retry, reason, issue, cleanable, users, pendingLabel, group: catalogGroup(info, DISTRIBUTION) }
  })
  const title = (id: string) => entries.find(e => e.id === id)?.info.title ?? id
  const groups = [...pluginCategories, { id: 'support', title: uiText("支持组件") }, { id: 'core', title: uiText("基础能力") }]
  const filters: { id: string; label: string; matches(e: typeof entries[number]): boolean }[] = [
    { id: 'all', label: uiText("全部"), matches: () => true },
    { id: 'multi', label: uiText("多版本"), matches: e => e.versions.length > 1 },
    ...(library ? [
      { id: 'enabled', label: uiText("已勾选"), matches: (e: typeof entries[number]) => e.enabled },
      { id: 'disabled', label: uiText("未勾选"), matches: (e: typeof entries[number]) => !e.enabled },
      { id: 'pending', label: uiText("待应用"), matches: (e: typeof entries[number]) => e.pending }
    ] : [{ id: 'clean', label: uiText("可清理旧版"), matches: (e: typeof entries[number]) => e.cleanable.length > 0 }]),
    { id: 'problem', label: uiText("需要处理"), matches: e => !!e.issue }
  ]
  const inCategory = entries.filter(e => (!suite || suite.ids.includes(e.id)) &&
    (category === 'all' || category === e.group) && matchesPlugin(e.info, query, DISTRIBUTION))
  const visible = inCategory.filter(filters.find(f => f.id === filter)!.matches)
  const [detailUsage, setDetailUsage] = useState<PackageInventory>()
  const [detailError, setDetailError] = useState('')
  useEffect(() => {
    if (!detail || !inLibrary) return
    let live = true
    setDetailUsage(undefined); setDetailError('')
    void window.bridge.packages.inventory().then(result => { if (live) setDetailUsage(result) }, e => { if (live) setDetailError(String(e)) })
    return () => { live = false }
  }, [detail, inLibrary, rows])
  const selected = entries.find(e => e.id === detail)
  const usedBy = (id: string) => entries.filter(e => e.info.requires?.includes(id))
  function perform(fn: () => void) { setDetail(undefined); fn() }
  return <section className="package-settings plugin-catalog">
    {suite && <button className="small" onClick={clearSuite}>{suite.title} ×</button>}
    <div className="plugin-filters">
      <input type="search" aria-label={uiText("搜索插件")} placeholder={uiText("搜索功能、名称或关键词…")} value={query} onChange={e => setQuery(e.target.value)} />
      <select aria-label={uiText("插件分类")} value={category} onChange={e => setCategory(e.target.value)}><option value="all">{uiText("全部分类")}</option>{groups.filter(g => entries.some(e => e.group === g.id)).map(g => <option key={g.id} value={g.id}>{hostLabel(g.title)}</option>)}</select>
    </div>
    <div className="plugin-state-filters" role="group" aria-label={uiText("插件状态")}>
      {filters.map(f => <button key={f.id} className="small" aria-pressed={f.id === filter} data-plugin-filter={f.id}
        onClick={() => setFilter(f.id)}>{f.label} <small>{inCategory.filter(f.matches).length}</small></button>)}
    </div>
    {!visible.length && <div className="plugin-empty"><p className="muted">{uiText("没有符合条件的插件")}</p><button className="small" onClick={() => { setQuery(''); setCategory('all'); setFilter('all'); clearSuite?.() }}>{uiText("清除筛选")}</button></div>}
    {groups.map(g => {
      const items = visible.filter(e => e.group === g.id)
      if (!items.length) return null
      const body = <div className="plugin-tiles">{items.map(({ id, info, builtin, versions, row, enabled, pending, pendingLabel, retry, issue, reason, users, cleanable }) =>
        <article key={id} className={row ? 'plugin-tile package-row' : 'plugin-tile'} data-plugin-id={id} data-package-id={row && id} data-package-version={row?.manifest.version} data-stacked={versions.length > 1 || undefined}>
          <div className="plugin-tile-heading"><button className="plugin-tile-title" data-action="plugin-details" aria-haspopup="dialog" onClick={() => setDetail(id)}>{info.title}</button>
            {versions.length > 1 && <small className="plugin-version-count">{uiText("{n} 版", { n: versions.length })}</small>}
            {row?.development && <small>{uiText("开发中")}</small>}{builtin?.required && <small>{uiText("始终开启")}</small>}</div>
          <p className={issue ? 'plugin-warn' : 'muted'} title={issue || info.description}>{issue || info.description}</p>
          <div className="plugin-tile-foot">
            {library && versions.length > 1 ? <select aria-label={uiText("{name}的版本", { name: info.title })} disabled={busy || row.development} value={row.hash} onChange={e => library.onSelect(versions.find(v => v.hash === e.target.value)!, true)}>
              {versions.map(v => <option key={v.hash} value={v.hash} disabled={!v.installed}>{v.manifest.version}{versions.some(other => other !== v && other.manifest.version === v.manifest.version) ? ' · ' + v.hash.slice(0,8) : ''}</option>)}</select> : row && <small>v{row.manifest.version}</small>}
            {library ? <>{pending && <small className="package-pending">{pendingLabel}</small>}
              <label className="package-choice ob-switch"><input type="checkbox" aria-label={uiText("启用 {title}{value2}", { title: info.title, value2: '' })} checked={enabled} disabled={busy || builtin?.required || row?.development || (!!row && !row.installed && !enabled)} onChange={() => builtin ? library.onToggle(id) : library.onSelect(row, !enabled)} /><span className="ob-switch-slider" /></label></>
              : <small>{cleanable.length ? uiText("可清理旧版") : inventory?.unchecked.length ? uiText("部分仓库未能核对") : inventory && uiText("{n} 个仓库绑定", { n: users.size })}</small>}
          </div>
          {reason && !!info.requires?.length && <button className="small" disabled={busy || row?.development} onClick={() => library?.onEnableRequired(id)}>{uiText("一并启用依赖")}</button>}
          {pending && !enabled && usedBy(id).some(e => e.enabled) && <small className="plugin-warn">{uiText("同时影响：")}{usedBy(id).filter(e => e.enabled).map(e => e.info.title).join('、')}</small>}
          {library && enabled && row?.enabled && row.installed && !row.running && !row.development && <button className="small" disabled={busy} onClick={() => library.onRetry(row.hash)}>{retry ? uiText("取消重试") : uiText("重试启用")}</button>}
        </article>)}</div>
      const heading = <>{hostLabel(g.title)}<span className="plugin-group-count">{items.length}</span></>
      return (g.id === 'support' || g.id === 'core') && library ? <details className="plugin-group plugin-secondary" key={g.id} data-plugin-group={g.id} open={query || filter !== 'all' || category !== 'all' ? true : undefined}><summary>{heading}</summary>{body}</details> :
        <section className="plugin-group" key={g.id} data-plugin-group={g.id}><h3>{heading}</h3>{body}</section>
    })}
    {selected && <Overlay onClose={() => setDetail(undefined)}><div className="plugin-drawer" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} ref={drawer}>
      <header><h2 id={titleId}>{selected.info.title}</h2><button className="small" onClick={() => setDetail(undefined)}>{uiText("关闭")}</button></header>
      <PluginDetails info={selected.info} author={selected.row?.manifest.author} source={selected.builtin ? selected.builtin.required ? uiText("应用核心 · 不可关闭或卸载") : uiText("内部功能 · 可关闭，不可卸载") : selected.row.development ? uiText("本机开发 · 在插件开发区退出") : selected.row.bundled ? uiText("应用附带 · 可卸载") : uiText("本地安装 · 可卸载")} title={title} plan={library?.plan} usedBy={usedBy(selected.id).map(e => e.info.title)} />
      {detailError && <p role="alert">{detailError}</p>}
      {selected.versions.map((v, index) => {
        const usage = inventory ?? detailUsage
        const use = usage?.versions[v.hash]
        return <section className="plugin-version" key={v.hash} data-version={v.manifest.version} data-hash={v.hash}>
          <strong>v{v.manifest.version}</strong> {index === 0 && v.installed && <small>{uiText("最新")}</small>} {v.running && <small>{uiText("本仓库已启用")}</small>} {library && v.selected && <small>{uiText("本库绑定")}</small>} {selected.pending && selected.row.hash === v.hash && <small>{selected.pendingLabel}</small>} {use?.bundledDefault && <small>{uiText("建库默认版本")}</small>}
          <div className="plugin-version-meta"><code title={v.hash}>{v.hash.slice(0, 8)}</code><button className="small" onClick={() => void navigator.clipboard.writeText(v.hash).catch(() => setDetailError(uiText("无法复制摘要")))}>{uiText("复制摘要")}</button>{use?.bytes !== undefined && <small>{Math.ceil(use.bytes / 1024)} KiB</small>}</div>
          {use && <ul>{use.libraries.map(l => <li key={l.root} title={l.root}>{l.name} · {l.running ? uiText("运行中") : l.enabled ? uiText("已启用") : uiText("已停用")}</li>)}{use.tasks.map(t => <li key={t}>{uiText("未完成任务")} · {hostLabel(t)}</li>)}</ul>}
          {use && !use.libraries.length && !use.tasks.length && <small>{usage?.unchecked.length ? uiText("部分仓库未能核对") : uiText("无已知仓库绑定")}</small>}
          {actions && v.installed && <div className="plugin-version-actions"><button className="small" disabled={busy} onClick={() => perform(() => actions.update(v))}>{uiText("更新…")}</button>
            {use?.newer && !!use.libraries.length && <button className="small" disabled={busy} onClick={() => perform(() => actions.update(v, selected.versions.find(other => other.hash === use.replacementHash)))}>{uiText("迁移到 v{version}…", { version: use.newer })}</button>}
            <button className="small" disabled={busy} onClick={() => perform(() => actions.remove(v))}>{uiText("卸载…")}</button></div>}
        </section>
      })}
      {actions && !!selected.cleanable.length && <button className="small" disabled={busy} onClick={() => perform(() => actions.clean(selected.cleanable))}>{uiText("清理此插件的旧版…")}</button>}
    </div></Overlay>}
  </section>
}
