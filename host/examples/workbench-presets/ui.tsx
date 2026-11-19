import { useState, useSyncExternalStore } from 'react'
import type { UiPlugin } from '@resource-manager/plugin-api/ui/contracts'
import type { WorkbenchNode, WorkbenchPresetUiProps } from '@resource-manager/plugin-api/ui/workbench-presets'

function Diagram({ node }: { node: WorkbenchNode }) {
  if (node.type === 'group') return <div style={{ flex: 1, minWidth: 0, minHeight: 0, border: '1px solid currentColor', borderRadius: 3, opacity: 0.65 }} />
  return <div style={{ display: 'flex', flexDirection: node.direction === 'columns' ? 'row' : 'column', gap: 3, width: '100%', height: '100%' }}>
    <div style={{ display: 'flex', flex: `${node.ratio} 1 0`, minWidth: 0, minHeight: 0 }}><Diagram node={node.first} /></div>
    <div style={{ display: 'flex', flex: `${1 - node.ratio} 1 0`, minWidth: 0, minHeight: 0 }}><Diagram node={node.second} /></div>
  </div>
}
function Manager({ host, intent, close }: WorkbenchPresetUiProps) {
  const api = host.workbenchPresets, state = useSyncExternalStore(api.subscribe, api.getSnapshot)
  const [name, setName] = useState('我的布局'), [error, setError] = useState(''), [fail, setFail] = useState(false)
  if (fail) throw new Error('示例：预设管理界面渲染失败')
  const run = (fn: () => void) => { try { fn(); setError('') } catch (e) { setError(String(e)) } }
  return <section data-preset-demo style={{ maxHeight: '75vh', overflow: 'auto' }}>
    <header style={{ display: 'flex', justifyContent: 'space-between' }}><h2>布局预览示例</h2><button className="small" onClick={close}>关闭</button></header>
    <p>这些示意图来自只读快照。显示预览不会切换布局或打开内容。</p>
    <label>名称 <input aria-label="示例预设名称" autoFocus={intent === 'save'} value={name} onChange={e => setName(e.target.value)} /></label>
    <button className="small" onClick={() => run(() => { api.saveCurrent(name) })}>保存当前布局</button>
    {(error || state.catalogError) && <p role="alert">{error || state.catalogError}</p>}
    {state.presets.map(p => <article key={p.id} data-demo-preset={p.id} style={{ padding: 12, borderBottom: '1px solid #555' }}>
      <div role="img" aria-label={`${p.title}分屏示意`} style={{ width: 140, height: 65, display: 'flex', marginBottom: 8 }}><Diagram node={p.layout.root} /></div>
      <strong>{p.title}</strong><span> · {p.source.kind === 'user' ? '我的副本' : '附带原版'}</span>
      {!!(p.issues?.length || p.missingViews.length) && <p>暂不可用：{(p.issues?.length ? p.issues : p.missingViews).join('、')}</p>}
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <button className="small" onClick={() => run(() => api.apply(p.id))}>应用</button>
        <button className="small" onClick={() => run(() => { api.copy(p.id, name) })}>另存副本</button>
      </div>
    </article>)}
    {state.canReturn && <button className="small" onClick={() => run(() => api.back())}>返回切换前布局</button>}
    <button className="small" style={{ marginTop: 12 }} onClick={() => setFail(true)}>演示界面故障</button>
  </section>
}
export const plugin: UiPlugin = {
  id: 'demo-presets',
  // 管理 UI 不直接读取此数组，只使用服务；其他插件提供的预设也自动出现在列表中。
  workbenchPresets: [{ id: 'demo-presets.reading', title: '阅读与笔记', description: '左侧阅读，右上对照，右下笔记；不自动打开任何页面。', layout: {
    version: 1, primary: 'main', panels: { sidebar: false, inspector: true },
    root: { type: 'split', id: 'across', direction: 'columns', ratio: 0.65, first: { type: 'group', id: 'main' },
      second: { type: 'split', id: 'down', direction: 'rows', ratio: 0.5, first: { type: 'group', id: 'reference' }, second: { type: 'group', id: 'notes' } } },
    sidebars: { version: 4, containers: [{ id: 'demo-presets.tools', type: 'tabs', side: 'right', views: ['demo-presets.help'], active: 'demo-presets.help' }], selected: { right: 'demo-presets.tools' }, hidden: [], weights: {} }
  } }, { id: 'demo-presets.organize', title: '素材与空间对照', description: '复用素材集合，准备文件空间；不导入文件、不创建业务记录。', layout: {
    version: 1, primary: 'main', panels: { sidebar: true, inspector: true },
    root: { type: 'split', id: 'compare', direction: 'columns', ratio: 0.6, first: { type: 'group', id: 'main' }, second: { type: 'group', id: 'space' } },
    contents: {
      main: { items: [{ kind: 'page', type: 'collection', target: { presetId: 'all' }, presentation: { layout: 'masonry', options: {}, zoom: 340 } }] },
      space: { items: [{ kind: 'page', type: 'file-spaces', target: {} }], active: 0 }
    },
    sidebars: { version: 4, containers: [
      { id: 'navigation', type: 'tabs', side: 'left', views: ['host.navigation'], active: 'host.navigation' },
      { id: 'context', type: 'context', side: 'left', views: [], active: '', contexts: { collection: { tools: ['host.filters'], active: 'host.filters' } } },
      { id: 'details', type: 'tabs', side: 'right', views: ['host.inspector', 'demo-presets.help'], active: 'host.inspector' }
    ], weights: { navigation: 4, context: 6 }, selected: { left: 'navigation', right: 'details' }, hidden: [] }
  } }],
  workbenchPresetUis: [{ id: 'demo-presets.manager', priority: 100, Component: Manager }],
  toolViews: [{ id: 'demo-presets.help', title: '预设服务', placement: { regions: ['left', 'right'], default: { region: 'right', group: 'demo-presets.tools' } }, order: 0,
    Component: ({ host }) => <button className="small" onClick={() => host.openWorkbenchPresets()}>打开预设管理</button> }]
}
