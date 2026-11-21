import { uiText } from '../../shared/i18n/interface-display'
import type { EntityView } from '../../shared/blocks'
import type { ArrangementEnvironment } from './workbench-arrangement'
import { tabTypeOf } from './ui-registry'

/** 本库工作现场允许引用保存视图；可分享预设继续排除这些身份。 */
export function localWorkbenchPages(views: EntityView[]): ArrangementEnvironment['page'] {
  return type => {
    const page = tabTypeOf(type), adapter = page?.workbench
    if (type !== 'collection' || !adapter) return page
    return { ...page, workbench: {
      ...adapter,
      capture(params, saved) {
        if (typeof params.viewId !== 'string') return adapter.capture(params, saved)
        return { target: { viewId: params.viewId }, presentation: adapter.presentation?.capture(params, saved) }
      },
      resolve(target) {
        if (!('viewId' in target)) return adapter.resolve(target)
        if (Object.keys(target).length !== 1 || typeof target.viewId !== 'string') throw new Error(uiText("保存视图入口只接受 viewId"))
        const view = views.find(v => v.id === target.viewId && !v.deletedAt), data = view?.blocks.view?.data
        if (!data) throw new Error(uiText("保存视图 {viewId} 不存在或已删除", { viewId: String(target.viewId) }))
        return { viewId: view.id, title: String(data.title), query: data.query, layout: data.layout, options: data.options }
      },
      describe(target, presentation) {
        if (!('viewId' in target)) return adapter.describe?.(target, presentation) ?? { title: uiText("集合视图") }
        return { title: String(views.find(v => v.id === target.viewId)?.blocks.view?.data.title ?? uiText("保存视图")) }
      }
    } }
  }
}
