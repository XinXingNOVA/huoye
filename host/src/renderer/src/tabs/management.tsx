import { useEffect, useState } from 'react'
import type { EntityView } from '../../../shared/blocks'
import { managementKind } from '../../../shared/blocks'
import { pluginTitle } from '../../../plugins/manifest'
import type { TabProps, TabType } from '../plugin'
import { useKinds } from '../ui-registry'
import { ManagementDetails } from '../components/DataDetails'

/** 独立只读场景：不注册素材选择、拖入、附加或回收站快捷键。 */
function ManagementTab({ host, setFocus }: TabProps) {
  const kinds = useKinds()
  const [rows, setRows] = useState<EntityView[]>([])
  const [error, setError] = useState<string>()
  const [loaded, setLoaded] = useState(false)
  useEffect(() => { setFocus([]) }, [setFocus])
  useEffect(() => {
    let alive = true, ticket = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = async () => {
      const request = ++ticket
      try {
        const results = await Promise.all([
          host.core.query({ scope: 'all', role: 'management', dir: 'asc' }),
          host.core.query({ scope: 'trash', role: 'management', dir: 'asc' })
        ])
        const views = await host.core.get(results.flatMap(r => r.ids))
        if (alive && request === ticket) { setRows(views); setLoaded(true); setError(undefined) }
      } catch (e) { if (alive && request === ticket) setError(String(e)) }
    }
    void load()
    const off = host.core.on('changed', () => { clearTimeout(timer); timer = setTimeout(() => void load(), 100) })
    return () => { alive = false; clearTimeout(timer); off() }
  }, [host, kinds])
  return <div className="management-tab">
    <header><h1>插件管理数据</h1><p className="muted">只读查看模板、标签分组和保存视图等记录。修改请使用各自的管理入口。</p></header>
    {error && <p className="data-error" role="alert">{error}</p>}
    {!loaded && !error && <p className="muted">正在读取…</p>}
    {loaded && !rows.length && <p className="muted">暂无插件管理数据。</p>}
    {rows.map(view => {
      const def = managementKind(view.blocks, host.kind)
      if (!def) return null
      return <details className="management-row" key={view.id} data-record-id={view.id}>
        <summary><span>{host.title(view)}</span><span className="muted">{pluginTitle(def.plugin)} · {def.title}{def.dormant ? ' · 未启用' : ''}{view.deletedAt ? ' · 旧版已移除' : ''}</span></summary>
        <ManagementDetails view={view} host={host} />
      </details>
    })}
  </div>
}

export const managementTabType: TabType = {
  id: 'management', Title: () => <>插件管理数据</>, key: () => 'management', Component: ManagementTab
}
