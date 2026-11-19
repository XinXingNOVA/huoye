import { useState } from 'react'
import type { PluginState } from '../../../shared/rpc'
import type { ExternalBinding, PackageRef, PackageRow } from '../../../shared/external-plugins'
import type { PluginPlan } from '../../../shared/plugin-plan'
import { catalogGroup, matchesPlugin, pluginCategories } from '../../../shared/plugin-presentation'
import { DISTRIBUTION } from '../../../plugins/generated/distribution'
import { PluginDetails } from './PluginDetails'

interface Props {
  plugins: PluginState[]; rows: PackageRow[]; draft: ExternalBinding[]; disabledIds: Set<string>
  retries: Set<string>; plan: PluginPlan; busy: boolean
  onToggle(id: string): void
  onSelect(ref: PackageRef, enabled: boolean): void
  onRetry(hash: string): void
  onEnableRequired(id: string): void
}
/** 功能分类只是目录信息；勾选、依赖预演与版本选择仍共用同一批草稿。 */
export function PluginChoices({ plugins, rows, draft, disabledIds, retries, plan, busy, onToggle, onSelect, onRetry, onEnableRequired }: Props) {
  const [query, setQuery] = useState(''), [category, setCategory] = useState('all'), [filter, setFilter] = useState('all')
  const title = (id: string) => plugins.find(p => p.id === id)?.title ?? draft.find(b => b.manifest.id === id)?.manifest.title ?? rows.find(p => p.manifest.id === id)?.manifest.title ?? DISTRIBUTION.find(p => p.id === id)?.title ?? id
  const entries = [...plugins.map(p => ({ info: p, builtin: p, row: undefined as PackageRow | undefined })),
    ...rows.map(row => ({ info: row.manifest, builtin: undefined as PluginState | undefined, row }))].map(entry => {
      const { info, builtin, row } = entry
      const chosen = draft.find(b => b.manifest.id === info.id)
      const checked = builtin ? !disabledIds.has(info.id) : !!(chosen?.hash === row!.hash && chosen.enabled)
      const current = builtin ? !builtin.chosen : row!.enabled
      const reason = checked ? plan.off.get(info.id) : undefined
      const pending = checked !== current || !!(row && retries.has(row.hash))
      const problem = reason || (row && !row.installed ? '未安装' : row?.enabled ? row.reason : undefined) || builtin?.unavailable
      return { ...entry, checked, pending, reason, problem, group: catalogGroup(builtin ?? info, DISTRIBUTION) }
    })
  const groups = [...pluginCategories, { id: 'support', title: '支持组件' }, { id: 'core', title: '基础能力' }]
  const visible = entries.filter(e => (category === 'all' || category === e.group) && matchesPlugin(e.info, query, DISTRIBUTION) &&
    (filter === 'all' || filter === 'enabled' && e.checked || filter === 'disabled' && !e.checked || filter === 'pending' && e.pending || filter === 'problem' && !!e.problem))
  const activeInfos = [...plugins, ...draft.filter(b => b.enabled).map(b => b.manifest)]
  const enabledCount = entries.filter(e => e.checked && !e.builtin?.required).length
  return <section className="package-settings plugin-catalog">
    <div className="plugin-filters">
      <input type="search" aria-label="搜索插件" placeholder="搜索功能、名称或关键词…" value={query} onChange={e => setQuery(e.target.value)} />
      <select aria-label="插件分类" value={category} onChange={e => setCategory(e.target.value)}><option value="all">全部分类</option>{groups.filter(g => entries.some(e => e.group === g.id)).map(g => <option key={g.id} value={g.id}>{g.title}</option>)}</select>
      <select aria-label="插件状态" value={filter} onChange={e => setFilter(e.target.value)}><option value="all">全部状态（已启用 {enabledCount}）</option><option value="enabled">已勾选</option><option value="disabled">未勾选</option><option value="pending">待应用</option><option value="problem">需要处理</option></select>
    </div>
    {!visible.length && <div className="plugin-empty"><p className="muted">没有符合条件的插件</p><button className="small" onClick={() => { setQuery(''); setCategory('all'); setFilter('all') }}>清除筛选</button></div>}
    {groups.map(group => {
      const items = visible.filter(e => e.group === group.id)
      if (!items.length) return null
      const body = <div className="plugin-group-card">{items.map(({ info, builtin, row, checked, pending, reason, problem }) => {
        const required = !!builtin?.required
        const usedBy = [...new Set(activeInfos.filter(p => p.requires?.includes(info.id)).map(p => p.title))]
        const affected = activeInfos.filter(p => p.requires?.includes(info.id) && !disabledIds.has(p.id)).map(p => p.title)
        return <div key={row?.hash ?? info.id} className={`plugin-row${row ? ' package-row' : ''}${reason ? ' off' : ''}`} data-plugin-id={info.id}
          data-package-id={row ? info.id : undefined} data-package-version={row?.manifest.version}>
          <div className="plugin-main">
            <div className="plugin-row-top">
              <div className="plugin-text">
                <span className="plugin-choice-heading">
                  <strong className="plugin-title">{info.title}</strong>
                  {row && <span className="plugin-version muted">{row.manifest.version}</span>}
                  {row?.development && <span className="package-status">开发中</span>}
                  {required && <span className="plugin-status-pill muted">始终开启</span>}
                  {pending && <span className="package-pending">{checked ? row && retries.has(row.hash) ? '待重试' : '待启用' : '待停用'}</span>}
                </span>
                <span className="plugin-description muted">{info.description}</span>
              </div>
              <label className="plugin-choice package-choice ob-switch" title={required ? '基础能力始终开启' : checked ? '点击停用' : '点击启用'}>
                <input type="checkbox" aria-label={`启用 ${info.title}${row ? ` ${row.manifest.version}` : ''}`} checked={checked} disabled={required || busy || row?.development || !!(row && !row.installed && !checked)}
                  onChange={() => builtin ? onToggle(info.id) : onSelect(row!, !checked)} />
                <span className="ob-switch-slider" aria-hidden="true" />
              </label>
            </div>
            <div className="plugin-row-info">
              {problem && <p className="plugin-warn">{reason ? `应用后：${reason}` : row && !row.installed ? '安装包缺失，请重新安装或取消勾选。' : builtin?.unavailable ? `${builtin.unavailable}，加工暂不可用` : `当前：${row?.reason}`}</p>}
              {pending && !checked && !!affected.length && <p className="plugin-warn">同时影响：{[...new Set(affected)].join('、')}</p>}
              {!!reason && !!info.requires?.length && <button className="small" disabled={busy} onClick={() => onEnableRequired(info.id)}>一并启用依赖</button>}
              {row && !row.development && checked && row.enabled && row.installed && !row.running && <button className="small" disabled={busy} onClick={() => onRetry(row.hash)}>{retries.has(row.hash) ? '取消重试' : '重试启用'}</button>}
              <PluginDetails info={builtin ?? info} version={row?.manifest.version} author={row?.manifest.author} source={builtin ? required ? '应用核心 · 不可关闭或卸载' : '内部功能 · 可关闭，不可卸载' : row!.development ? '本机开发 · 在插件开发区退出' : row!.bundled ? '应用附带 · 可卸载' : '本地安装 · 可卸载'} title={title} plan={plan} usedBy={usedBy} />
            </div>
          </div>
        </div>
      })}</div>
      const heading = <>{group.title}<span className="plugin-group-count">{items.length}</span></>
      return group.id === 'support' || group.id === 'core' ? <details className="plugin-group plugin-secondary" data-plugin-group={group.id} key={group.id} open={query.trim() || category !== 'all' || filter !== 'all' ? true : undefined}><summary>{heading}</summary>{body}</details>
        : <div className="plugin-group" data-plugin-group={group.id} key={group.id}><h3>{heading}</h3>{body}</div>
    })}
  </section>
}
