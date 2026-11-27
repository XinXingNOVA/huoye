import { uiText } from '../../shared/i18n/interface-display'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { Launcher } from './Launcher'
import { connectCore } from './core-client'
import { CacheContext, EntityCache } from './entity-cache'
import { allKinds, subscribeKinds, initUi, setDefinedKinds } from './ui-registry'
import { UiRuntimeContext, type UiRuntime } from '../../plugin-api/ui/internal/runtime'
import { CollectionSurface } from './components/ResourceCollection'
import { Card } from './components/Card'
import { ResourceCover } from './components/ResourceCover'
import { Embed } from './embed'
import { loadExternalUi } from './external-plugins'
import type { ReactNode } from 'react'
import { IconThemeContext } from '../../plugin-api/ui/internal/kit-icons'
import { activeTheme, initTheme, useThemeSettings } from './theme'
import { initLanguage } from './language'
import './styles.css'

document.documentElement.dataset.platform = window.bridge.platform
const applyFullscreen = (fullscreen: boolean) => {
  if (fullscreen) document.documentElement.dataset.fullscreen = 'true'
  else delete document.documentElement.dataset.fullscreen
}
void window.bridge.fullscreen.get().then(applyFullscreen).catch(() => {})
window.bridge.fullscreen.onChanged(applyFullscreen)

function ThemedIcons({ libraryId, children }: { libraryId?: string; children: ReactNode }) {
  const { prefs } = useThemeSettings(libraryId)
  return <IconThemeContext.Provider value={activeTheme(prefs).icons}>{children}</IconThemeContext.Provider>
}

async function start() {
  await initLanguage()
  // 仓库管理窗口：不连核心进程
  if (location.hash === '#launcher') {
    await initTheme()
    createRoot(document.getElementById('root')!).render(<ThemedIcons><Launcher /></ThemedIcons>)
    return
  }
  const core = await connectCore()
  const { root, libraryId, unavailable, assembly } = await core.info()
  await initTheme(libraryId)
  // 只用这个仓库启用了的插件（设计文档 8.4）
  const external = await loadExternalUi()
  if (!external) return
  initUi(assembly, external.plugins, external.manifest)
  // 用户用模板定义的数据块：先取一次，模板变了再取
  setDefinedKinds(await core.kinds())
  const offKinds = core.on('kinds', () => void core.kinds().then(setDefinedKinds))
  const cache = new EntityCache(core)
  const runtime: UiRuntime = {
    openExternal: (url) => void window.bridge.openExternal(url),
    entities: cache,
    definitions: { all: allKinds, subscribe: subscribeKinds },
    components: { Collection: CollectionSurface, Card, Cover: ResourceCover, Embed }
  }
  window.addEventListener('unload', () => { offKinds(); cache.dispose() }, { once: true })
  createRoot(document.getElementById('root')!).render(
    <UiRuntimeContext.Provider value={runtime}>
      <CacheContext.Provider value={cache}>
        <ThemedIcons libraryId={libraryId}><App core={core} root={root} libraryId={libraryId} unavailable={unavailable} /></ThemedIcons>
      </CacheContext.Provider>
    </UiRuntimeContext.Provider>
  )
  await window.bridge.packages.ready()
}

start().catch((e) => {
  document.body.textContent = uiText("启动失败：{value1}", { value1: String(e instanceof Error ? e.message : String(e)) })
})
