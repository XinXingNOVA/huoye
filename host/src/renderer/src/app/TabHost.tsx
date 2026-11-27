import { pageImageReads } from './page-image-reads'
import { memo, useLayoutEffect, useMemo } from 'react'
import type { UiHost } from '../plugin'
import { tabOwner, tabTypeOf } from '../ui-registry'
import type { TabEntry } from '../workspace'
import type { TabCallbacks } from './workspace'

export const TabHost = memo(function TabHost({
  entry,
  active,
  visible,
  onActivate,
  host,
  callbacks
}: {
  entry: TabEntry
  active: boolean
  visible: boolean
  onActivate(id: string): void
  host: UiHost
  callbacks: TabCallbacks
}) {
  useLayoutEffect(() => () => callbacks.expose(null), [callbacks])
  const type = tabTypeOf(entry.type)
  const images = useMemo(() => pageImageReads(host.core, host.url, tabOwner(entry.type) ?? ''), [host.core, entry.type, entry.id])
  useLayoutEffect(() => { images.open(); return images.close }, [images])
  if (!type) return null
  // 隐藏的标签页用 visibility 而不是 display:none，保留滚动位置与布局宽度
  return (
    <div className={`tab-pane${visible ? '' : ' hidden'}`} data-tab-content={entry.id} data-tab-focused={active} inert={!visible}
      onPointerDownCapture={() => onActivate(entry.id)} onMouseDownCapture={() => onActivate(entry.id)} onFocusCapture={() => onActivate(entry.id)}>
      <type.Component
        imageReads={images.reads} capabilities={images.capabilities}
        inputs={type.inputs}
        id={entry.id}
        params={entry.params}
        host={host}
        active={active}
        visible={visible}
        saved={entry.state}
        presentationRevision={entry.presentationRevision}
        setState={callbacks.setState}
        setParams={callbacks.setParams}
        setFocus={callbacks.setFocus}
        registerKeys={callbacks.registerKeys}
        expose={callbacks.expose}
      />
    </div>
  )
})
