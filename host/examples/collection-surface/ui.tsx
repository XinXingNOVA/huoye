import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { UiHost, UiPlugin, TabProps, ViewProps } from '@resource-manager/plugin-api/ui/contracts'
import { ResourceCollection, type CollectionParams, type CollectionState, type CollectionToolbarProps } from '@resource-manager/plugin-api/ui/collection'
import { ResourceBadge } from '@resource-manager/plugin-api/ui/media'
import './ui.css'

const initial: CollectionParams = { title: '动态集合示例', query: { scope: 'content' }, layout: 'masonry' }
const State = createContext({ ids: [] as string[], marked: false, opened: '', limit: 2, error: '', setLimit: (_n: number) => {}, mark: () => {}, open: (_id: string) => {} })
function Provider({ host, children }: { host: UiHost; children: ReactNode }) {
  const [all, setAll] = useState<string[]>([]), [limit, setLimit] = useState(2), [marked, setMarked] = useState(false)
  const [opened, open] = useState(''), [error, setError] = useState('')
  useEffect(() => {
    let generation = 0, active = true
    const refresh = async () => {
      const request = ++generation
      try { const result = await host.core.query({ scope: 'content', role: 'material' }); if (active && request === generation) { setAll(result.ids); setError('') } }
      catch (e) { if (active && request === generation) setError(String(e)) }
    }
    const off = host.core.on('listChanged', () => void refresh()); void refresh()
    return () => { active = false; off() }
  }, [host.core])
  const ids = useMemo(() => all.slice(0, limit), [all, limit])
  return <State.Provider value={{ ids, marked, opened, limit, error, setLimit, mark: () => setMarked(v => !v), open }}>{children}</State.Provider>
}
function Toolbar({ selected }: CollectionToolbarProps) {
  const state = useContext(State)
  return <div className="demo-collection-toolbar">
    <span>已选 {selected.length} 项</span>
    <button onClick={() => state.setLimit(0)}>清空范围</button><button onClick={() => state.setLimit(2)}>恢复范围</button>
    <button onClick={state.mark}>切换本机角标</button>
    {state.opened && <span data-demo-opened={state.opened}>已触发自定义打开</span>}
    {state.error && <span role="alert">{state.error}</span>}
  </div>
}
function Page(props: TabProps<CollectionParams, CollectionState>) {
  const state = useContext(State)
  return <ResourceCollection {...props} scopeIds={state.ids} Toolbar={Toolbar} onOpen={state.open} />
}
function Badge({ view }: ViewProps) {
  const { ids, marked } = useContext(State)
  return ids.includes(view.id) && marked ? <ResourceBadge>本机示例标记</ResourceBadge> : null
}
export const plugin: UiPlugin = {
  id: 'demo-collection',
  windowProviders: [{ id: 'demo-collection.state', order: 100, Component: Provider }],
  navs: [{ id: 'demo-collection.nav', order: 850, Component: ({ host }) => <button className="nav-item" onClick={() => host.openTab('demo-collection.page', initial)}>动态集合示例</button> }],
  tabTypes: [{ id: 'demo-collection.page', key: () => 'demo', Title: () => <>动态集合示例</>, Component: Page,
    inputs: { receive: false, create: false, reason: '动态集合示例只展示临时范围，请到普通视图收录或新建' } }],
  badges: [{ order: 1000, get: v => v.blocks.file ? { text: '静态示例' } : undefined }, { id: 'demo-collection.local', order: 1001, Component: Badge }]
}
