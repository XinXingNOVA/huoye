import { createContext, useCallback, useContext, useMemo, useState } from 'react'
import type { CollectionParams, CollectionState, LayoutPresentation } from '../../shared/collection'
import { layoutOptions, layoutRecord, layoutZoom, readBrowsingDefault, restoreLayoutStates } from '../../shared/browsing-layout'
import { layoutOf } from './ui-registry'

/** 窗口内部提供仓库身份，插件不用自己找本机配置文件。 */
export const CollectionLibraryContext = createContext('')

export function useCollectionLayout(params: CollectionParams, saved: CollectionState | undefined, notify: (text: string) => void, presentationRevision = 0) {
  const libraryId = useContext(CollectionLibraryContext)
  // 默认值只在首次打开取得；改本库默认不会改变已经打开／恢复的页面。
  const [initialPresentation] = useState<LayoutPresentation>(() => saved?.initialPresentation ?? (params.layout
    ? { layout: params.layout, options: params.options ?? {} } : readBrowsingDefault(localStorage, libraryId)))
  const [presentation, setPresentation] = useState(saved?.presentation)
  const base = useMemo(() => ({ layout: params.layout ?? initialPresentation.layout, options: params.options ?? (params.layout ? {} : initialPresentation.options) }), [params.layout, params.options, initialPresentation])
  const requested = presentation ?? base
  const [layouts, setLayouts] = useState(() => restoreLayoutStates(saved, requested.layout))
  const [adoptedRevision, setAdoptedRevision] = useState(presentationRevision)
  // 宿主只改呈现；在本组件提交前接续，避免旧 effect 把新 saved 覆盖回去。
  if (adoptedRevision !== presentationRevision) {
    setAdoptedRevision(presentationRevision)
    setPresentation(saved?.presentation)
    setLayouts(restoreLayoutStates(saved, saved?.presentation?.layout ?? requested.layout))
  }
  const current = layoutOf(requested.layout)
  const missing = current.id !== requested.layout
  const memory = layouts[current.id]
  const options = useMemo(() => layoutOptions(current, missing ? memory?.options : requested.options), [current, missing, memory?.options, requested.options])
  const zoom = layoutZoom(current, memory?.zoom ?? (current.id === initialPresentation.layout ? initialPresentation.zoom : undefined))
  const patch = useCallback((change: Partial<NonNullable<CollectionState['layouts']>[string]>) => {
    setLayouts(states => ({ ...states, [current.id]: { ...states[current.id], ...change } }))
  }, [current.id])
  const setZoom = useCallback((value: number) => patch({ zoom: layoutZoom(current, value) }), [patch, current])
  const onAnchor = useCallback((anchor: string) => {
    setLayouts(states => states[current.id]?.anchor === anchor ? states : { ...states, [current.id]: { ...states[current.id], anchor } })
  }, [current.id])
  const onState = useCallback((state: Record<string, unknown>) => {
    try { patch({ state: layoutRecord(state) }) } catch (e) { notify(String(e)) }
  }, [patch, notify])
  const setOptions = (value: Record<string, unknown>) => {
    try {
      const options = layoutRecord(value)
      patch({ options })
      // 回退布局只是投影，不能把缺失插件的选择和业务配置覆盖掉。
      if (!missing) setPresentation({ layout: requested.layout, options })
    } catch (e) { notify(String(e)) }
  }
  const setLayout = (id: string) => {
    if (id === requested.layout) return
    if (presentation && !missing) patch({ options })
    setPresentation({ layout: id, options: layoutOptions(layoutOf(id), layouts[id]?.options ?? (id === base.layout ? base.options : undefined)) })
  }
  const reset = () => {
    setPresentation(undefined)
    setLayouts(states => Object.fromEntries(Object.entries(states).map(([id, { options: _, ...state }]) => [id, state])))
  }
  const resetOptions = () => { setOptions(layoutOptions(current)); setZoom(layoutZoom(current)) }
  return { initialPresentation, presentation, layouts, requested, current, missing, options, zoom, memory,
    setLayout, setOptions, setZoom, onAnchor, onState, reset, resetOptions }
}
