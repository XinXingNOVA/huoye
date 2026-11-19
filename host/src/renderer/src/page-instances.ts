import type { TabType } from '../../plugin-api/ui/contracts'
import type { TabEntry } from './workspace'
import { chooseContentInstance, sameInstanceContent, type ContentInstance, type ContentInstanceRule, type InstanceRequest } from './content-instances'

type Rule = Pick<TabType, 'key' | 'instances'>
export const allowsNewView = (rule: Rule | undefined) => !!rule?.instances && rule.instances.max !== 1

function pageInstance(entry: TabEntry, rule: Rule): ContentInstance {
  return { id: entry.id, typeId: entry.type, contentKey: rule.key?.(entry.params) }
}
function pageRule(rule: Rule): ContentInstanceRule {
  return {
    reuse: rule.key ? 'content' : rule.instances?.scope === 'type' ? 'type' : 'none',
    allowNew: allowsNewView(rule),
    limit: { scope: rule.instances?.scope ?? 'content', max: rule.instances?.max ?? (rule.instances ? Infinity : rule.key ? 1 : Infinity) }
  }
}
export function sameContent(rule: Rule, a: TabEntry, b: TabEntry): boolean {
  return a.type === b.type && sameInstanceContent(pageInstance(a, rule), pageInstance(b, rule))
}

/** 页面声明适配到公共实例决策；生命周期与布局提交仍归工作区控制器。 */
export function choosePage(tabs: TabEntry[], entry: TabEntry, rule: Rule, options: InstanceRequest = {}): { existing?: string; blocked?: string } {
  const candidate = pageInstance(entry, rule)
  if (rule.instances?.scope === 'content' && typeof candidate.contentKey !== 'string') return { blocked: '页面缺少有效的内容身份，无法检查视图数量' }
  const decision = chooseContentInstance(tabs.filter(t => t.type === entry.type && t.id !== options.omit).map(t => pageInstance(t, rule)), candidate, pageRule(rule), options)
  if (decision.action === 'reuse') return { existing: decision.id }
  if (decision.action === 'reject') return { blocked: decision.reason === 'new-not-allowed'
    ? '此页面尚未开放独立多视图，请使用打开或移动标签页'
    : `${rule.instances?.scope === 'type' ? '此页面类型' : '同一内容'}最多打开 ${rule.instances?.max ?? 1} 个视图，请先关闭一个` }
  return {}
}

/** 快照脱离运行中的对象；已关闭页面不再参与仲裁，跨内容不泄露状态。 */
export function otherPageViews(tabs: TabEntry[], entry: TabEntry, rule: Rule) {
  return tabs.filter(t => t.id !== entry.id && sameContent(rule, entry, t))
    .map(t => structuredClone({ id: t.id, params: t.params, saved: t.state }))
}
