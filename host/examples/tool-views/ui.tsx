import { useEffect, useState } from 'react'
import { useKeys } from '@resource-manager/plugin-api/ui/hooks'
import type { TabProps, UiPlugin, UiHost, ToolViewProps, CollectionFilterCapability } from '@resource-manager/plugin-api/ui/contracts'

function Draft({ active }: { active: boolean }) {
  const [draft, setDraft] = useState('')
  const [instance] = useState(() => crypto.randomUUID())
  return <div style={{ height: '100%', overflow: 'auto', padding: 12 }} data-demo-instance={instance} data-demo-active={active}>
    <p>移动、折叠或切换视图组，草稿仍然保留。</p>
    <textarea aria-label="布局测试草稿" value={draft} onChange={e => setDraft(e.target.value)} style={{ width: '100%', minHeight: 90 }}/>
    <p>这是本次会话的临时输入，应用重启后不保存。持久数据由插件自行保存。</p>
    <div style={{ height: 1200 }} />
    <p>滚动位置验证</p>
  </div>
}
function Status({ host }: { host: UiHost }) {
  return <div style={{ padding: 12 }}><p>打开视图会遵循用户调整后的位置。</p><button onClick={() => host.showView('demo-tools.draft')}>打开草稿</button>{['A', 'B'].map(name => <button key={name} onClick={() => host.openTab('demo-tools.page', { name })}>打开示例 {name}</button>)}<button onClick={() => host.openTab('demo-tools.limited', { name: 'A' })}>打开多视图示例</button><button onClick={() => host.openTab('demo-tools.single', {})}>打开单例示例</button></div>
}
function InstancePage({ id, params, saved, setState, setParams, host }: TabProps<{ name?: string }, { count: number }>) {
  const [count, setCount] = useState(saved?.count ?? 0)
  return <div data-instance-page={id} style={{ padding: 16 }}>
    <p>每份内容最多两个视图；计数仅属于本视图，不是共享编辑草稿。</p>
    <p>内容：{params.name ?? '单例'}；计数：<span data-local-count>{count}</span></p>
    <button data-local-add onClick={() => { setCount(count + 1); setState({ count: count + 1 }) }}>增加本视图计数</button>
    <button data-new-view onClick={() => host.openTab('demo-tools.limited', { name: 'A' }, { instance: 'new' })}>新建 A 视图</button>
    <button data-reuse-view onClick={() => host.openTab('demo-tools.limited', { name: 'A' })}>普通打开 A</button>
    <button data-other-content onClick={() => host.openTab('demo-tools.limited', { name: 'B' })}>打开内容 B</button>
    <button data-navigate-a onClick={() => setParams({ name: 'A' })}>当前页切到 A</button>
    <button data-single-new onClick={() => host.openTab('demo-tools.single', {}, { instance: 'new' })}>尝试多开单例</button>
  </div>
}
function Page({ params, active, visible, saved, setState, registerKeys, expose, host }: TabProps<{ name: string }, { draft: string; keys: number; hold?: boolean }>) {
  const [draft, setDraft] = useState(saved?.draft ?? '')
  const [hold, setHold] = useState(saved?.hold ?? false)
  const [keys, setKeys] = useState(saved?.keys ?? 0)
  const [instance] = useState(() => crypto.randomUUID())
  useEffect(() => {
    expose({ context: { title: `示例页面 ${params.name}`, capabilities: { 'demo-tools.reading': { count: keys, add: () => { setKeys(keys + 1); setState({ draft, keys: keys + 1, hold }) } } } } })
  }, [params.name, keys, draft, hold, setState, expose])
  useKeys(registerKeys, event => {
    if (event.key !== 'k') return false
    const next = keys + 1; setKeys(next); setState({ draft, keys: next, hold }); return true
  })
  return <div data-demo-page={params.name} data-demo-page-instance={instance} data-active={active} data-visible={visible} style={{ height: '100%', overflow: 'auto', padding: 16 }}>
    <h2>示例页面 {params.name}</h2>
    <textarea aria-label={`页面 ${params.name} 草稿`} value={draft} onChange={e => { setDraft(e.target.value); setState({ draft: e.target.value, keys, hold }) }} style={{ width: '100%', minHeight: 120 }}/>
    <label><input type="checkbox" data-prevent-leave checked={hold} onChange={e => { setHold(e.target.checked); setState({ draft, keys, hold: e.target.checked }) }}/>保留页面（演示结束回调失败；取消勾选可重试）</label>
    <p>本页响应 K 键次数：<span data-key-count>{keys}</span></p>
    <button onClick={async () => { await new Promise(resolve => setTimeout(resolve, 400)); host.openTab('demo-tools.page', { name: '延迟' }) }}>延迟打开同组页面</button>
    <button data-open-other-self onClick={() => host.openTab('demo-tools.page', params, { group: 'other' })}>在另一组打开此页</button>
    <div style={{ height: 1200 }}/><p>滚动位置验证</p>
  </div>
}
function ReadingTool({ context, active }: ToolViewProps) {
  const value = context?.capabilities['demo-tools.reading'] as { count: number; add(): void } | undefined
  const [local, setLocal] = useState('')
  return <div style={{ padding: 12 }} data-context-example={context?.pageId} data-active={active}>
    <p>{context?.title} · <span data-context-count>{value?.count}</span></p>
    <button data-context-add onClick={() => context?.isAvailable() && value?.add()}>计数加一</button>
    <input aria-label="工具局部草稿" value={local} onChange={e => setLocal(e.target.value)}/>
  </div>
}
function CollectionTool({ context }: ToolViewProps) {
  return <div style={{ padding: 12 }} data-context-summary={context?.pageId}>
    <p>服务页面：{context?.title}</p><p>选中 {context?.selection.length ?? 0} 项</p>
    <button data-delayed-filter onClick={() => {
      const filter = context?.capabilities['collection.filter'] as CollectionFilterCapability
      setTimeout(() => { if (context?.isAvailable()) filter.toggleFilter({ op: 'eq', kind: 'file', field: 'ext', value: 'png' }) }, 500)
    }}>延迟筛选 PNG（验证来源）</button>
  </div>
}
export const plugin: UiPlugin = {
  id: 'demo-tools',
  commands: [{ id: 'demo-tools.open-status', title: '布局示例', quickAction: { icon: 'tool', order: 10 }, run: (_context, host) => host.showView('demo-tools.status') }],
  // 专门的示例文件验证回调式打开器继承位置；不影响普通文字文件。
  opens: [{ id: 'demo-tools.route', title: '延迟打开数据详情（示例）', priority: 1, match: v => v.blocks.file?.data.name === '布局路由示例.txt', open: (v, host) => { setTimeout(() => host.openData(v.id), 300) } }],
  tabTypes: [
    { id: 'demo-tools.limited', key: p => p.name, instances: { scope: 'content', max: 2 }, Title: ({ params }) => <>多视图 {params.name}</>, Component: InstancePage },
    { id: 'demo-tools.single', instances: { scope: 'type', max: 1 }, Title: () => <>单例示例</>, Component: InstancePage },
    { id: 'demo-tools.page', key: p => p.name, Title: ({ params }) => <>示例 {params.name}</>, Component: Page, beforeLeave: ({ params, saved, reason, nextParams }) => {
    if (reason === 'navigate' && nextParams?.name === params.name) return
    if (saved?.hold) throw new Error('示例页面暂未允许结束，请取消保留页面后重试')
  } }],
  toolViews: [
    { id: 'demo-tools.reading', title: '阅读工具示例', order: 5, placement: { regions: ['left', 'center', 'right'] }, context: { requires: ['demo-tools.reading'], detachable: { maxInstances: 2 } }, Component: ReadingTool },
    { id: 'demo-tools.summary', title: '集合概况', order: 6, context: { requires: ['collection.filter'], detachable: { maxInstances: 2 } }, Component: CollectionTool },
    { id: 'demo-tools.reading-extra', title: '额外工具示例', order: 7, context: { requires: ['demo-tools.reading'], defaultVisible: false }, Component: ReadingTool },
    { id: 'demo-tools.draft', title: '草稿', order: 10, placement: { regions: ['left', 'center', 'right'] }, Component: Draft },
    { id: 'demo-tools.status', title: '说明', placement: { regions: ['left', 'right'], default: { region: 'right', group: 'demo-tools.tools' } }, order: 20, Component: Status }
  ]
}
