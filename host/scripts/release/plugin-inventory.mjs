// 从交付快照的 manifest 与发行描述生成同一份人读／机器读清单，不执行插件代码。
const label = value => String(value ?? '').replaceAll('|', '\\|').replace(/[\r\n]+/g, ' ')
export function pluginInventory(readJson, paths) {
  const ids = readJson('host/packaging/source-profile.json').plugins
  const bundled = new Map(paths.filter(p => /^host\/packaging\/plugins\/[^/]+\/plugin.json$/.test(p)).map(p => {
    const manifest = readJson(p), distribution = readJson(p.replace('plugin.json', 'distribution.json'))
    return [manifest.id, { manifest, distribution }]
  }))
  const internal = paths.filter(p => /^host\/src\/plugins\/[^/]+\/plugin.json$/.test(p)).sort().map(p => {
    const m = readJson(p), d = p.replace('plugin.json', 'distribution.json')
    return { id: m.id, title: m.title, description: m.description, usage: m.catalog?.usage ?? '', requires: m.requires ?? [], application: m.scope === 'application', required: !!m.required, defaultEnabled: paths.includes(d) ? readJson(d).defaultEnabled : !!m.required }
  })
  const plugins = ids.map(id => {
    if (!/^[a-z][a-z0-9-]*$/.test(id)) throw new Error('交付插件 ID 无效')
    const m = readJson(`plugins/${id}/plugin.json`), policy = bundled.get(id)
    if (m.id !== id || typeof m.version !== 'string') throw new Error(`插件来源身份／版本不符：${id}`)
    if (policy && (policy.manifest.title !== m.title || JSON.stringify([...(policy.manifest.requires ?? [])].sort()) !== JSON.stringify([...(m.requires ?? [])].sort()))) throw new Error(`附带描述与源码不一致：${id}`)
    return { id, title: m.title ?? id, version: m.version, description: m.description ?? '', usage: m.catalog?.usage ?? '', requires: m.requires ?? [], optional: m.optional ?? [], bundled: !!policy, defaultEnabled: !!policy?.distribution.defaultEnabled }
  })
  const all = [...internal, ...plugins], known = new Set(all.map(p => p.id)), enabled = new Set(all.filter(p => p.defaultEnabled).map(p => p.id))
  if (known.size !== all.length || [...bundled.keys()].some(id => !ids.includes(id))) throw new Error('交付插件重复或附带包缺少源码')
  for (const p of all) for (const id of p.requires) {
    if (!known.has(id)) throw new Error(`缺少依赖：${p.id} → ${id}`)
    if (p.defaultEnabled && !enabled.has(id)) throw new Error(`默认组合没有启用依赖：${p.id} → ${id}`)
  }
  return { format: 1, hostVersion: readJson('host/package.json').version, internal, plugins }
}
export function inventoryMarkdown(inventory) {
  const lines = ['# 插件功能清单', '', `应用版本：${inventory.hostVersion}。本清单由插件声明和发行策略生成，与本版源码对应。`, '',
    '宿主直接提供仓库、文件空间、搜索筛选、工作台布局、插件管理、预设和操作历史机制。下表列出内部模块及外部插件；MCP 授权由使用者配置。', '',
    '默认启用只作用于新仓库，不改已有仓库的选择。附带外部包仍可停用、卸载；停用保留数据。可选包先在应用设置安装，再在目标仓库勾选并统一应用。', '', '## 内部能力', '', '| 名称 | 说明与入口 | 使用方式 |', '| --- | --- | --- |']
  for (const p of inventory.internal) lines.push(`| ${label(p.title)} (${p.id}) | ${label(p.description)} ${label(p.usage)} | ${p.application ? '应用设置授权，初始未授权' : p.required ? '核心，始终启用' : p.defaultEnabled ? '内部可关闭，默认启用' : '内部可关闭，默认关闭'} |`)
  for (const [title, items] of [['附带并默认启用', inventory.plugins.filter(p => p.bundled && p.defaultEnabled)], ['附带，按需启用', inventory.plugins.filter(p => p.bundled && !p.defaultEnabled)], ['独立可选安装包', inventory.plugins.filter(p => !p.bundled)]]) {
    lines.push('', `## ${title}（${items.length}）`, '', '| 名称／版本 | 能做什么 | 从哪里使用 | 必需依赖 |', '| --- | --- | --- | --- |')
    for (const p of items) lines.push(`| ${label(p.title)} · ${p.version}<br>${p.id} | ${label(p.description)} | ${label(p.usage)} | ${p.requires.map(label).join('、') || '无额外前置'} |`)
  }
  lines.push('', '必需依赖按插件 ID 标注；内部模块可在上表查找。可选协作不强制启用，例如组可配合标签、笔记、来源与字段。完整 optional 声明见同目录 plugins.json；仅出现功能名不代表已经授权 MCP 或配置了模型接口。', '', '## 数据与使用边界', '', '- 仓库保存素材和数据块，文件空间保存原件与版本；备份需保留两层。', '- 外部插件是可信代码，只安装信任的来源。源码、安装包和实际启用是三个不同层次。', '- 平台验证结果见交付记录；功能清单不替代 Windows 实机验收。', '')
  return lines.join('\n')
}
