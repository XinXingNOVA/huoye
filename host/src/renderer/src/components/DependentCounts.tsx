import { uiText } from '../../../shared/i18n/interface-display'

export function DependentCounts({ total, owned = 0 }: { total: number; owned?: number }) {
  return <>
    {owned > 0 && <li>{uiText("作品内的子记录：{count}", { count: owned })}</li>}
    {total > owned && <li>{uiText("其他附属内容（如批注）：{count}", { count: total - owned })}</li>}
  </>
}
