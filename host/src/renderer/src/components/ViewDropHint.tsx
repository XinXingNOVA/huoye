import { admissionDescription, type Query } from '../../../shared/query'
import { kindOf } from '../ui-registry'

/** 中央视图与导航入口复用同一份写入／检查说明。 */
export function ViewDropHint({ query, title, internal }: { query?: Query; title: string; internal: boolean }) {
  const hint = query && admissionDescription(query, kindOf)
  return <div className="drop-hint">
    <strong>{hint?.blocked ?? (query ? `放入「${title}」` : internal ? '此页面没有整理规则' : '按仓库设置导入')}</strong>
    {hint?.writes.map((s, i) => <p key={`w${i}`}>将{s}</p>)}
    {!!hint?.checks.length && <p className="drop-checks">需要满足：{hint.checks.join('；')}</p>}
    {internal ? <small>只执行上方规则，不移动原文件；其他视图会按各自条件更新。</small> : <small>有条件的视图先检查输入；未匹配或待确认的内容默认不收录，可在确认时额外选择。</small>}
  </div>
}
