import { hostLabel, uiText, useUiLocale } from '../../../shared/i18n/interface-display'
import type { PluginInfo, PluginPlan } from '../../../shared/plugin-plan'
import { catalogOf, pluginCategories } from '../../../shared/plugin-presentation'
import { DISTRIBUTION } from '../../../plugins/generated/distribution'

interface Props {
  info: PluginInfo
  version?: string
  author?: string
  source: string
  title(id: string): string
  plan?: PluginPlan
  usedBy?: string[]
}
export function PluginDetails({ info, version, author, source, title, plan, usedBy }: Props) {
  useUiLocale()
  const catalog = catalogOf(info, DISTRIBUTION)
  const dependencies = (ids: string[]) => ids.map(id => <span className="plugin-dependency" key={id}>{title(id)}{plan && <span className={plan.enabled.has(id) ? 'muted' : 'plugin-warn'}>{plan.enabled.has(id) ? uiText("已勾选") : plan.off.get(id) === '已停用' ? uiText("未勾选") : uiText("不可用")}</span>}</span>)
  return <div className="plugin-details">
    <div className="plugin-details-body">
      <p>{info.description}</p>
      <dl>
        {catalog.usage && <><dt>{uiText("使用入口")}</dt><dd>{catalog.usage}</dd></>}
        {!!info.requires?.length && <><dt>{uiText("必需依赖")}</dt><dd>{dependencies(info.requires)}</dd></>}
        {!!info.optional?.length && <><dt>{uiText("可选配合")}</dt><dd>{dependencies(info.optional)}<small className="muted">{uiText("未启用时，仅缺少对应的协作功能。")}</small></dd></>}
        {!!info.capabilities?.provides?.length && <><dt>{uiText('提供能力')}</dt><dd>{info.capabilities.provides.map(id => {
          const spec = info.capabilities?.implementations?.find(s => s.id === id)
          return <div key={id}><code>{id}</code>{spec && <small> · {[uiText('本地执行'), ...(spec.platforms ?? []), ...(spec.programs ?? [])].join(' · ')}</small>}</div>
        })}</dd></>}
        {!!info.capabilities?.runtimes?.length && <><dt>{uiText('随包程序')}</dt><dd>{info.capabilities.runtimes.map(r =>
          <div key={r.program}><code>{r.program}</code> <small className="muted">{r.targets.join(' · ')}</small></div>)}</dd></>}
        {!!info.capabilities?.optionalConsumes?.length && <><dt>{uiText('可选能力')}</dt><dd>{info.capabilities.optionalConsumes.map(id => <div key={id}><code>{id}</code></div>)}</dd></>}
        {!!info.capabilities?.consumes?.length && <><dt>{uiText('使用能力')}</dt><dd>{info.capabilities.consumes.map(id => <div key={id}><code>{id}</code></div>)}</dd></>}
        {!!usedBy?.length && <><dt>{uiText("依赖它的功能")}</dt><dd>{usedBy.join('、')}</dd></>}
        <dt>{uiText("分类")}</dt><dd>{hostLabel(pluginCategories.find(c => c.id === catalog.category)?.title ?? '')}{catalog.role === 'support' ? uiText(" · 支持组件") : ''}</dd>
        <dt>{uiText("来源")}</dt><dd>{source}{author ? uiText(" · 作者声明：{author}", { author }) : ''}</dd>
        <dt>{uiText("标识")}{version ? uiText(" / 版本") : ''}</dt><dd>{info.id}{version ? ` · ${version}` : ''}</dd>
        {!info.required && <><dt>{uiText("停用之后")}</dt><dd>{uiText("已有素材、原文件和仓库数据保留；相关使用入口随插件关闭。")}</dd></>}
      </dl>
    </div>
  </div>
}
