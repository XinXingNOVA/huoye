import { uiText } from '../../shared/i18n/interface-display'
import type { PageWorkbenchAdapter } from '../../plugin-api/ui/workbench-presets'
import type { CollectionParams, CollectionState, LayoutPresentation } from '../../shared/collection'
import type { LayoutDef, PresetView } from '../../plugin-api/ui/contracts'
import { layoutOptions, layoutRecord, layoutZoom, presentationSchema } from '../../shared/browsing-layout'

/** 仅捕获可重建的导航入口；库内保存视图／临时查询留在工作现场，不复制实体引用。 */
export function collectionWorkbench(views: () => PresetView[], layouts: () => LayoutDef[]): PageWorkbenchAdapter<CollectionParams, CollectionState> {
  const capture = (params: CollectionParams, saved: CollectionState | undefined): LayoutPresentation => {
    const preset = views().find(v => v.id === params.presetId)
    const initial = saved?.initialPresentation ?? { layout: preset?.layout ?? 'masonry', options: preset?.options ?? {} }
    const chosen = saved?.presentation ?? { layout: params.layout ?? initial.layout, options: params.options ?? (params.layout ? {} : initial.options) }
    const definition = layouts().find(l => l.id === chosen.layout)
    const zoom = definition ? layoutZoom(definition, saved?.layouts?.[chosen.layout]?.zoom ?? (chosen.layout === saved?.initialPresentation?.layout ? saved.initialPresentation.zoom : undefined)) : saved?.layouts?.[chosen.layout]?.zoom
    return { ...chosen, options: layoutRecord(chosen.options), ...(zoom === undefined ? {} : { zoom }) }
  }
  return {
    describe(target, presentation) {
      const title = views().find(v => v.id === target.presetId)?.title ?? uiText("集合视图")
      const display = presentation && layouts().find(l => l.id === presentation.layout)
      const detail = display ? [display.title, typeof presentation?.zoom === 'number' ? uiText("大小 {zoom}", { zoom: String(presentation.zoom) }) : undefined].filter(Boolean).join(' · ') : undefined
      return { title, detail }
    },
    capture(params, saved) {
      if (params.viewId || !views().some(v => v.id === params.presetId && (!v.tab || v.tab === 'collection'))) return
      return { target: { presetId: params.presetId }, presentation: layoutRecord(capture(params, saved)) }
    },
    resolve(target) {
      if (Object.keys(target).some(k => k !== 'presetId')) throw new Error(uiText("集合预设仅接受导航入口 presetId"))
      const view = views().find(v => v.id === target.presetId && (!v.tab || v.tab === 'collection'))
      if (!view) throw new Error(uiText("集合入口 {value1} 未启用", { value1: String(String(target.presetId)) }))
      return { title: view.title, presetId: view.id, query: structuredClone(view.query) }
    },
    presentation: {
      capture: (params, saved) => ({ ...layoutRecord(capture(params, saved)), inherit: !saved?.presentation }),
      apply(_params, saved, value) {
        if (value.inherit !== undefined && typeof value.inherit !== 'boolean') throw new Error(uiText("呈现继承标志无效"))
        const p = presentationSchema.parse(value), definition = layouts().find(l => l.id === p.layout)
        if (!definition) throw new Error(uiText("显示布局 {layout} 未启用，已保留当前呈现", { layout: String(p.layout) }))
        const options = layoutOptions(definition, layoutRecord(p.options))
        return { filters: [], selection: [], ...saved, presentation: value.inherit === true ? undefined : { layout: p.layout, options }, layouts: {
          ...saved?.layouts, [p.layout]: { ...saved?.layouts?.[p.layout], options, zoom: layoutZoom(definition, p.zoom) }
        } }
      }
    }
  }
}

/** 无参数的仓库级功能页；明确排除正在查看某个实体／空间的实例。 */
export const libraryPageWorkbench: PageWorkbenchAdapter = {
  capture: params => Object.keys(params).length ? undefined : { target: {} },
  resolve: target => { if (Object.keys(target).length) throw new Error(uiText("此功能页不接受预设参数")); return {} }
}
