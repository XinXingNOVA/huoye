import { pluginMessages as packageMessages, useLocale as useUiLocale } from '@resource-manager/plugin-api/ui/locale'
import './style.css'
import type { UiPlugin, ViewProps } from '@resource-manager/plugin-api/ui/contracts'
import { STATUS_OPTIONS } from './blocks'

const uiText = packageMessages('status')


export const STATUS_COLORS: Record<string, string> = {
  待处理: '#5b7bb5',
  进行中: '#c98a2b',
  已完成: '#3f9a5c',
  搁置: '#6b6d75'
}

function StatusSection({ view, host }: ViewProps) {
  useUiLocale()
  const current = view.blocks.status?.data.value as string | undefined
  return (
    <div className="status-options">
      {STATUS_OPTIONS.map((s) => (
        <button
          key={s}
          className={`status-option${s === current ? ' active' : ''}`}
          style={s === current ? { background: STATUS_COLORS[s], borderColor: STATUS_COLORS[s] } : undefined}
          title={s === current ? uiText("再点一次清除状态") : uiText("设为{s}", { s: uiText(s) })}
          onClick={() => {
            if (s === current) host.core.remove(view.id, 'status')
            else host.core.put(view.id, 'status', { value: s })
          }}
        >
          {uiText(s)}
        </button>
      ))}
    </div>
  )
}

export const statusUi: UiPlugin = {
  id: 'status',
  // 状态分区始终显示：点一下就挂上状态块
  sections: [{ id: 'status', get title() { return uiText("状态") }, order: 35, kinds: ['status'], match: () => true, Component: StatusSection }],
  facets: [{ get title() { return uiText("状态") }, kind: 'status', field: 'value', order: 5 }],
  badges: [
    {
      order: 10,
      get: (v) => {
        const s = v.blocks.status?.data.value as string | undefined
        return s ? { text: uiText(s), color: STATUS_COLORS[s] } : undefined
      }
    }
  ]
}

export { statusUi as plugin }
