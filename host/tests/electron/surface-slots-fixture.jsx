// 由侧栏验证器单独打包进临时目录，在真实 Chromium 中验证插槽缺位／替换。
// 独立 React root，不给应用增加测试入口或改写工作区数据。
import { memo, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { SurfaceHost, SurfaceSlot, SurfaceSlots, surfaceSlot } from '../../src/renderer/src/surface-slots'
import { resolveSidebarContainer } from '../../src/renderer/src/components/SidebarContainers'
import { SidebarToolStrip } from '../../src/renderer/src/components/SidebarToolStrip'
import { RetainedSurface } from '../../src/renderer/src/components/RetainedSurface'

export async function verify() {
  const check = (value, message) => { if (!value) throw new Error(message) }
  const group = { id: 'fixture', type: 'context', side: 'left', context: {} }
  const definition = resolveSidebarContainer(group)
  check(definition.source === 'page-context' && resolveSidebarContainer({ ...group, side: 'right' }) === definition, '跨侧装配使用稳定的内置呈现组件')
  check(resolveSidebarContainer({ ...group, type: 'tabs', context: undefined }).source === 'members', '普通组使用已安放的成员')
  for (const invalid of [{ ...group, side: 'center' }, { ...group, context: undefined }]) {
    let rejected = false
    try { resolveSidebarContainer(invalid) } catch { rejected = true }
    check(rejected, '错误区域或内容来源不能交给容器呈现')
  }
  const frame = () => new Promise(resolve => requestAnimationFrame(() => resolve()))
  const parent = document.createElement('div')
  parent.style.cssText = 'position:fixed;left:0;top:0;width:320px;height:220px;z-index:10000;background:#222'
  document.body.appendChild(parent)
  const root = createRoot(parent), key = surfaceSlot('sidebar', 'fixture')
  let layout, mounts = 0, unmounts = 0, surfaceRenders = 0
  function Layout() {
    const [state, set] = useState({ present: false, revision: 0 }); layout = set
    return state.present ? <section key={state.revision} data-slot-shell={state.revision}>
      <article><SurfaceSlot slot={key} className="arbitrary-slot-markup"/></article>
    </section> : null
  }
  function Content() {
    const [count, setCount] = useState(0)
    useEffect(() => { mounts++; return () => { unmounts++ } }, [])
    return <div data-scroll-fixture style={{ height: 100, overflow: 'auto' }}>
      <textarea aria-label="插槽验证草稿" defaultValue=""/>
      <button onClick={() => setCount(n => n + 1)}>{count}</button><div style={{ height: 700 }}/>
    </div>
  }
  const StableSurface = memo(function StableSurface() {
    surfaceRenders++
    return <RetainedSurface slot={key} visible className="fixture-content"><Content/></RetainedSurface>
  })
  try {
    flushSync(() => root.render(<SurfaceHost><Layout/><StableSurface/></SurfaceHost>))
    await frame()
    const input = parent.querySelector('textarea'), scroller = parent.querySelector('[data-scroll-fixture]')
    check(input?.isConnected && input.closest('[data-surface-parking]'), '缺位内容应在隐藏停放区保活')
    check(mounts === 1, '初次内容只挂载一次')
    const renderCount = surfaceRenders
    flushSync(() => layout({ present: true, revision: 0 })); await frame()
    check(parent.querySelector('article textarea') === input, '插槽延迟出现应自动接续原实例')
    input.value = '保留未保存输入'
    parent.querySelector('button').click(); await frame()
    scroller.scrollTop = 80
    flushSync(() => layout({ present: false, revision: 0 })); await frame()
    check(input.isConnected && input.closest('[data-surface-parking]'), '撤下插槽必须先停放，不能滞留在断开的节点')
    flushSync(() => layout({ present: true, revision: 1 })); await frame()
    check(parent.querySelector('article textarea') === input && input.value === '保留未保存输入', '重开插槽保留 DOM 与输入')
    check(scroller.scrollTop === 80 && parent.querySelector('button').textContent === '1', '重开插槽保留滚动与组件状态')
    flushSync(() => layout({ present: true, revision: 2 })); await frame()
    check(parent.querySelector('[data-slot-shell="2"] textarea') === input && scroller.scrollTop === 80, '同身份插槽替换不能重建内容或丢失滚动')
    check(surfaceRenders === renderCount && mounts === 1 && unmounts === 0, '插槽变化不依赖内容重渲染，也不额外挂载')

    const a = new SurfaceSlots(), b = new SurfaceSlots(), first = document.createElement('div'), second = document.createElement('div')
    const old = a.register(key, first), current = a.register(key, second), isolated = b.register(key, first)
    old(); check(a.target(key) === second && b.target(key) === first, '旧 ref 清理不得注销新插槽，登记不得串工作区')
    current(); isolated(); check(!a.target(key) && !b.target(key), '撤销登记应释放节点')
  } finally { flushSync(() => root.unmount()); parent.remove() }
  await frame()
  check(unmounts === 1, '工作区退出只释放一次内容')
  // 窄工具栏的溢出和键盘仍能访问全部工具；不因图标化丢失可访问名称。
  const stripParent = document.createElement('div'); stripParent.style.width = '150px'; document.body.appendChild(stripParent)
  const stripRoot = createRoot(stripParent)
  const tools = ['one', 'two', 'three', 'four'].map((id, i) => ({ id, title: `工具${i + 1}` }))
  function StripFixture() {
    const [active, select] = useState('one')
    return <SidebarToolStrip groupId="fixture" kind="ordinary" items={tools} active={active} onSelect={select} onMenu={() => {}}
      onDragStart={() => {}} onDragEnd={() => {}} contextMenu={async () => 'four'} notify={message => { throw new Error(message) }}/>
  }
  try {
    flushSync(() => stripRoot.render(<StripFixture/>)); await frame(); await frame()
    check(stripParent.querySelectorAll('.sidebar-tool-label:not([hidden])').length === 1, '只展开当前项名称')
    check(stripParent.querySelector('.sidebar-tool-overflow'), '窄栏提供溢出入口')
    stripParent.querySelector('.sidebar-tool-overflow').click(); await frame(); await frame()
    check(stripParent.querySelector('[aria-selected=true]')?.getAttribute('aria-label') === '工具4', '溢出工具可以选中并展开')
    stripParent.querySelector('[aria-selected=true]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })); await frame()
    check(document.activeElement?.getAttribute('aria-label') === '工具1', '键盘跨越溢出项后焦点随选中项接续')
    stripParent.style.width = '340px'; await frame(); await frame()
    check(stripParent.querySelectorAll('[role=tab]').length === 4 && !stripParent.querySelector('.sidebar-tool-overflow'), '变宽后按原顺序恢复图标')
  } finally { flushSync(() => stripRoot.unmount()); stripParent.remove() }
  return { ok: true }
}
