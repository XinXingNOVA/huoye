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
import { initTheme } from './theme'
import './styles.css'

document.documentElement.dataset.platform = window.bridge.platform
initTheme()

async function start() {
  // 仓库管理窗口：不连核心进程
  if (location.hash === '#launcher') {
    createRoot(document.getElementById('root')!).render(<Launcher />)
    return
  }
  const core = await connectCore()
  const { root, libraryId, unavailable, assembly } = await core.info()
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
        <App core={core} root={root} libraryId={libraryId} unavailable={unavailable} />
      </CacheContext.Provider>
    </UiRuntimeContext.Provider>
  )
  await window.bridge.packages.ready()
}

start().catch((e) => {
  document.body.textContent = `启动失败：${e instanceof Error ? e.message : String(e)}`
})
