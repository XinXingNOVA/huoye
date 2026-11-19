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
  const catalog = catalogOf(info, DISTRIBUTION)
  const dependencies = (ids: string[]) => ids.map(id => <span className="plugin-dependency" key={id}>{title(id)}{plan && <span className={plan.enabled.has(id) ? 'muted' : 'plugin-warn'}>{plan.enabled.has(id) ? '已勾选' : plan.off.get(id) === '已停用' ? '未勾选' : '不可用'}</span>}</span>)
  return <details className="plugin-details">
    <summary aria-label={`${info.title}${version ? ` ${version}` : ''}的详情`}>详情</summary>
    <div className="plugin-details-body">
      <p>{info.description}</p>
      <dl>
        {catalog.usage && <><dt>使用入口</dt><dd>{catalog.usage}</dd></>}
        {!!info.requires?.length && <><dt>必需依赖</dt><dd>{dependencies(info.requires)}</dd></>}
        {!!info.optional?.length && <><dt>可选配合</dt><dd>{dependencies(info.optional)}<small className="muted">未启用时，仅缺少对应的协作功能。</small></dd></>}
        {!!usedBy?.length && <><dt>依赖它的功能</dt><dd>{usedBy.join('、')}</dd></>}
        <dt>分类</dt><dd>{pluginCategories.find(c => c.id === catalog.category)?.title}{catalog.role === 'support' ? ' · 支持组件' : ''}</dd>
        <dt>来源</dt><dd>{source}{author ? ` · 作者声明：${author}` : ''}</dd>
        <dt>标识{version ? ' / 版本' : ''}</dt><dd>{info.id}{version ? ` · ${version}` : ''}</dd>
        {!info.required && <><dt>停用之后</dt><dd>已有素材、原文件和仓库数据保留；相关使用入口随插件关闭。</dd></>}
      </dl>
    </div>
  </details>
}
