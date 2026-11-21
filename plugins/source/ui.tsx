// 来源插件的界面：检查器里的来源（点网址在浏览器里打开）、卡片角标、侧栏按网站筛选。

import type { UiPlugin, ViewProps } from '@resource-manager/plugin-api/ui/contracts'

import { pluginMessages, useLocale } from '@resource-manager/plugin-api/ui/locale'

const msg = pluginMessages('source')

function SourceSection({ view, host }: ViewProps) {
  useLocale()
  const s = view.blocks.source.data
  const url = String(s.url ?? '')
  return (
    <dl className="props">
      {s.title ? (
        <>
          <dt>{msg('页面')}</dt>
          <dd>{String(s.title)}</dd>
        </>
      ) : null}
      <dt>{msg('网址')}</dt>
      <dd>
        <button className="link source-url" title={msg('在浏览器里打开')} onClick={() => host.openExternal(url)}>
          {url}
        </button>
      </dd>
    </dl>
  )
}

export const sourceUi: UiPlugin = {
  id: 'source',
  sections: [{ id: 'source', get title() { return msg("来源") }, order: 12, kinds: ['source'], Component: SourceSection }],
  badges: [{ order: 60, get: (v) => (v.blocks.source?.data.site ? { text: String(v.blocks.source.data.site) } : undefined) }],
  facets: [{ get title() { return msg("来源网站") }, kind: 'source', field: 'site', order: 30 }]
}

export { sourceUi as plugin }
