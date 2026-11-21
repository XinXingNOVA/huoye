import { uiText } from '../../shared/i18n/interface-display'
import { checkToolFeatures, rejectLegacyToolDeclarations } from '../../shared/tool-placement'
import * as React from 'react'
import * as Jsx from 'react/jsx-runtime'
import * as ReactDom from 'react-dom'
import * as data from '../../plugin-api/ui/data'
import * as collection from '../../plugin-api/ui/collection'
import * as media from '../../plugin-api/ui/media'
import * as fields from '../../plugin-api/ui/fields'
import { setPackageLanguages } from '../../plugin-api/ui/internal/locale'
import * as locale from '../../plugin-api/ui/locale'
import * as kit from '../../plugin-api/ui/kit'
import * as widgets from '../../plugin-api/ui/widgets'
import * as localState from '../../plugin-api/ui/local-state'
import * as hooks from '../../plugin-api/ui/hooks'
import * as navigation from '../../plugin-api/ui/navigation'
import * as search from '../../plugin-api/ui/search'
import * as selection from '../../plugin-api/ui/selection'
import * as extensions from '../../plugin-api/ui/extensions'
import * as playback from '../../plugin-api/ui/playback'
import type { UiPlugin } from '../../plugin-api/ui/contracts'
import { checkExternalUi } from './ui-registry'

const sdk = Object.freeze({
  react: React, 'react/jsx-runtime': Jsx, 'react-dom': ReactDom,
  ...Object.fromEntries(Object.entries({ 'local-state': localState, extensions, data, media, collection, fields, locale, kit, widgets, hooks, navigation, search, playback, selection }).map(([key, value]) => [`@resource-manager/plugin-api/ui/${key}`, value]))
})
Object.defineProperty(globalThis, '__rmPluginSdk', { value: sdk })

function guarded(Component: React.ComponentType<any>, id: string) {
  return class PluginBoundary extends React.Component<any, { failed: boolean }> {
    state = { failed: false }
    static getDerivedStateFromError() { return { failed: true } }
    componentDidCatch(error: Error) { void window.bridge.packages.failed(id, error.message).catch(console.error) }
    render() { return this.state.failed ? <p role="alert">{uiText("插件界面出错，正在恢复仓库…")}</p> : <Component {...this.props} /> }
  }
}

export async function loadExternalUi() {
  const runtime = await window.bridge.packages.runtime()
  setPackageLanguages(runtime.packages)
  const plugins: UiPlugin[] = []
  for (const pack of runtime.packages) {
    if (!pack.manifest.entries.ui) continue
    try {
      const base = `${runtime.base}${pack.hash}/`
      const module = await import(/* @vite-ignore */ `${base}${pack.manifest.entries.ui}`) as { plugin: UiPlugin }
      if (!module.plugin || module.plugin.id !== pack.manifest.id) throw new Error(uiText("UI 导出 ID 与声明不一致"))
      if ((module.plugin.extensionPoints?.length || module.plugin.extensions?.length) && !pack.manifest.uiFeatures?.includes('ui-extension-points-v1')) throw new Error(uiText("自定义扩展点需要声明 ui-extension-points-v1"))
      rejectLegacyToolDeclarations(module.plugin)
      if (module.plugin.settingsSections?.some(section => section.category === 'appearance') && !pack.manifest.uiFeatures?.includes('settings-appearance-v1')) throw new Error(uiText("插件外观分区需要声明 settings-appearance-v1"))
      if (module.plugin.facets?.some(f => f.source === 'blocks') && !pack.manifest.uiFeatures?.includes('block-facets-v1')) throw new Error(uiText("数据块分面需要声明 block-facets-v1"))
      checkToolFeatures(module.plugin.toolViews ?? [], pack.manifest.uiFeatures)
      if (module.plugin.toolViews?.some(v => v.context?.detachable) && !pack.manifest.uiFeatures?.includes('bound-context-tools-v1')) throw new Error(uiText("固定上下文工具需要声明 bound-context-tools-v1 界面能力"))
      if (module.plugin.toolViews?.some(v => v.context) && !pack.manifest.uiFeatures?.includes('context-tools-v1')) throw new Error(uiText("上下文工具需要声明 context-tools-v1 界面能力"))
      if (module.plugin.blockSections?.length && !pack.manifest.uiFeatures?.includes('block-sections-v1')) throw new Error(uiText("逐块详情需要声明 block-sections-v1 界面能力"))
      if ((module.plugin.selectionActions?.length || module.plugin.selectionLayers?.length || module.plugin.contentLocations?.length) && !pack.manifest.uiFeatures?.includes('content-selection-v1')) throw new Error(uiText("内容选区需要声明 content-selection-v1 界面能力"))
      if (module.plugin.tabTypes?.some(t => t.beforeLeave) && !pack.manifest.uiFeatures?.includes('page-lifecycle-v1')) throw new Error(uiText("页面结束回调需要声明 page-lifecycle-v1 界面能力"))
      if (module.plugin.tabTypes?.some(t => t.instances) && !pack.manifest.uiFeatures?.includes('page-instances-v1')) throw new Error(uiText("页面数量规则需要声明 page-instances-v1 界面能力"))
      if (module.plugin.tabTypes?.some(t => t.inputs) && !pack.manifest.uiFeatures?.includes('page-inputs-v1')) throw new Error(uiText("页面输入规则需要声明 page-inputs-v1"))
      if (module.plugin.badges?.some(b => b.Component) && !pack.manifest.uiFeatures?.includes('reactive-badges-v1')) throw new Error(uiText("动态角标需要声明 reactive-badges-v1"))
      if ((module.plugin.tabTypes?.some(t => t.workbench) || module.plugin.workbenchPresets?.some(p => p.layout.contents)) && !pack.manifest.uiFeatures?.includes('workbench-content-v1')) throw new Error(uiText("工作台内容编排需要声明 workbench-content-v1"))
      if ((module.plugin.workbenchPresets?.length || module.plugin.workbenchPresetUis?.length) && !pack.manifest.uiFeatures?.includes('workbench-presets-v1')) throw new Error(uiText("工作台预设需要声明 workbench-presets-v1"))
      if (module.plugin.fileEditingUis?.length && !pack.manifest.uiFeatures?.includes('file-working-copy-ui-v1')) throw new Error(uiText("文件编辑界面需要声明 file-working-copy-ui-v1"))
      if (module.plugin.layouts?.some(l => l.size !== undefined || l.defaultOptions !== undefined || l.description !== undefined) && !pack.manifest.uiFeatures?.includes('browsing-layout-v1')) throw new Error(uiText("布局配置需要声明 browsing-layout-v1"))
      if (module.plugin.commands?.some(c => c.quickAction) && !pack.manifest.uiFeatures?.includes('quick-actions-v1')) throw new Error(uiText("快捷操作入口需要声明 quick-actions-v1 界面能力"))
      if (module.plugin.commands?.length && !pack.manifest.uiFeatures?.includes('ui-commands-v1')) throw new Error(uiText("UI 命令需要声明 ui-commands-v1"))
      checkExternalUi([...plugins, module.plugin], runtime.manifest)
      await Promise.all(pack.manifest.styles.map(path => new Promise<void>((resolve, reject) => {
        const link = document.createElement('link')
        const timer = setTimeout(() => reject(new Error(uiText("插件样式加载超时"))), 8000)
        link.rel = 'stylesheet'; link.href = base + path
        link.onload = () => { clearTimeout(timer); resolve() }
        link.onerror = () => { clearTimeout(timer); reject(new Error(uiText("插件样式无法加载"))) }
        document.head.appendChild(link)
      })))
      // 预设管理由宿主专用边界原位回退；界面故障不撤下该插件提供的预设。
      const plugin = Object.fromEntries(Object.entries(module.plugin).map(([key, value]) => [key, Array.isArray(value)
        ? value.map(item => item && typeof item === 'object' && item.Component && key !== 'workbenchPresetUis' ? guardContribution(item, module.plugin.id) : item)
        : value])) as unknown as UiPlugin
      plugins.push(plugin)
    } catch (e) {
      await window.bridge.packages.failed(pack.manifest.id, e instanceof Error ? e.message : String(e))
      return undefined // 主进程重载会撤下整个失败插件，核心与 UI 保持同一装配。
    }
  }
  return { plugins, manifest: runtime.manifest }
}

/** Preserve lazy display labels when wrapping a package's component with an error boundary. */
function guardContribution<T extends { Component: Parameters<typeof guarded>[0] }>(item: T, pluginId: string): T {
  const descriptors = Object.getOwnPropertyDescriptors(item)
  descriptors.Component = { ...descriptors.Component, value: guarded(item.Component, pluginId) }
  return Object.defineProperties({}, descriptors) as T
}
