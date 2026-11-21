import { uiText, useUiLocale } from '../../shared/i18n/interface-display'
// 嵌入（设计文档 11.9）：文字里的 ![[…]] 显示成被嵌入的那个素材。
// 怎么嵌入由认识它的插件提供（嵌入扩展点，按优先级仲裁）：图片给图，视频给播放器，局部给裁好的一块……
// 没有插件认得的，用封面 + 标题。嵌入的东西本身也能点开。

import { useEntity, useGone } from './entity-cache'
import type { UiHost } from './plugin'
import { coverFor, embedFor, titleFor } from './ui-registry'
import { GenericCover } from './components/DataDetails'

export function Embed({ id, host, fallback }: { id: string; host: UiHost; fallback?: string }) {
  useUiLocale()
  const view = useEntity(id)
  const gone = useGone(id)
  if (!view) return gone ? <span className="embed embed-missing">{uiText("找不到「")}{fallback || id}」</span> : <span className="embed embed-loading" />
  const provider = embedFor(view)
  const cover = coverFor(view)
  return (
    <span className={`embed${view.deletedAt ? ' trashed' : ''}`}>
      {provider ? (
        <provider.Component view={view} host={host} />
      ) : (
        <span className="embed-cover" onClick={() => host.open(view.id)}>
          {cover ? <cover.Component view={view} host={host} /> : <GenericCover view={view} host={host} />}
        </span>
      )}
      <span className="embed-caption" title={uiText("打开")} onClick={() => host.open(view.id)}>
        {titleFor(view)}
        {view.deletedAt ? uiText("（在回收站里）") : ''}
      </span>
    </span>
  )
}
