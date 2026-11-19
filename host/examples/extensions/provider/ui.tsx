import { useEffect, useRef, useState } from 'react'
import type { UiPlugin, TabProps } from '@resource-manager/plugin-api/ui/contracts'
import { ExtensionBoundary } from '@resource-manager/plugin-api/ui/extensions'
import type { ExampleAction, ExampleContext } from '@resource-manager/example-extension-contract'

const point = 'demo-extension-provider.actions'
function Page({ params, host, saved, setState }: TabProps<{ name: string }, { count: number }>) {
  const [count, setCount] = useState(saved?.count ?? 0)
  const [failure, setFailure] = useState<ExampleContext['failure']>('none')
  const [message, setMessage] = useState('')
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => setState({ count }), [count, setState])
  const context: ExampleContext = {
    name: params.name, count, failure, isAvailable: () => alive.current,
    add: amount => { if (alive.current) setCount(value => value + amount) }
  }
  const entries = host.extensions.list<ExampleAction>(point, 1)
  return <div data-extension-page={params.name} style={{ padding: 20 }}>
    <h2>扩展示例 · {params.name}</h2><p>本页计数：<output data-extension-count>{count}</output></p>
    <p>下面的动作与附加内容由另一个独立插件提供。</p>
    <label>错误演示 <select aria-label="错误演示" value={failure} onChange={e => setFailure(e.target.value as ExampleContext['failure'])}>
      <option value="none">正常</option><option value="sync">动作同步失败</option><option value="async">动作异步失败</option><option value="render">附加内容失败</option>
    </select></label>
    {!entries.length && <p data-extension-empty>尚无可用贡献；页面本身仍可使用。</p>}
    {entries.map(entry => { const Panel = entry.value.Panel; return <div key={entry.id} data-extension-entry={entry.id}>
      <button className="small" onClick={() => {
        const from = context
        void host.extensions.invoke(entry, value => value.run(from)).then(() => { if (alive.current) setMessage('动作已完成') }, error => { if (alive.current) setMessage(String(error)) })
      }}>{entry.value.title}</button>
      {Panel && <ExtensionBoundary extensions={host.extensions} extension={entry}><Panel context={context}/></ExtensionBoundary>}
    </div> })}
    <p role="status">{message}</p>
    <button className="small" onClick={() => void host.openSettings({ scope: 'library', section: 'plugins' })}>查看插件协作问题</button>
  </div>
}
export const plugin: UiPlugin = {
  id: 'demo-extension-provider',
  extensionPoints: [{ id: point, version: 1, validate(value) {
    const action = value as Partial<ExampleAction> | null
    return !action || typeof action.title !== 'string' || typeof action.run !== 'function' || (action.Panel !== undefined && typeof action.Panel !== 'function') ? '需要 title、run 及可选的 Panel 组件' : undefined
  } }],
  tabTypes: [{ id: 'demo-extension-provider.page', key: params => params.name, Title: ({ params }) => <>扩展 · {params.name}</>, Component: Page }],
  commands: ['A', 'B'].map(name => ({ id: `demo-extension-provider.open-${name}`, title: `打开扩展示例 ${name}`, run: (_context, host) => host.openTab('demo-extension-provider.page', { name }) }))
}
