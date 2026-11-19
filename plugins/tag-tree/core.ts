import { z } from 'zod'
import { parseInput } from '@resource-manager/plugin-api/operations'
import type { CorePlugin, CommandContext } from '@resource-manager/plugin-api/core/contracts'
import type { Query } from '@resource-manager/plugin-api/query'
import { blocks, nodeKind } from './blocks'
import { branchCondition, descendants, type TagNode } from './model'
const name = z.string().trim().min(1).max(200)
const parentInput = z.object({ tag: name, parent: name.nullable() }).strict()
const removeInput = z.object({ tag: name }).strict()
const load = (ctx: CommandContext): TagNode[] => ctx.query({ scope: 'all', has: [nodeKind] }).ids.map(id => ({ id, ...ctx.blocksOf(id)[nodeKind].data } as TagNode))
export const plugin: CorePlugin = {
  id: 'tag-tree', version: 1, blocks,
  dataLifecycle: { version: 1, disposableRecords: [nodeKind], retainedEffects: ['素材上的基础标签、分组关系和保存视图保留；层级目录清空后，原分支筛选不再包含旧后代。', '本机层级折叠状态单独在本库本机数据中重置。'] },
  commands: {
    setParent(ctx, input) {
      const { tag, parent } = parseInput(parentInput, input), nodes = load(ctx)
      if (parent !== null && descendants(nodes, tag).has(parent)) throw new Error('不能把标签移到自身或后代下面')
      const needed = [tag, ...(parent ? [parent] : [])].filter(t => !nodes.some(n => n.tag === t))
      if (nodes.length + needed.length > 500) throw new Error('第一版层级目录最多支持 500 个节点')
      const own = nodes.find(n => n.tag === tag)
      if (parent && !nodes.some(n => n.tag === parent)) ctx.put(ctx.createEntity(), nodeKind, { tag: parent })
      ctx.put(own?.id ?? ctx.createEntity(), nodeKind, { tag, ...(parent ? { parent } : {}) })
      return { label: `调整标签「${tag}」的层级`, result: { tag, parent } }
    },
    remove(ctx, input) {
      const { tag } = parseInput(removeInput, input), nodes = load(ctx), node = nodes.find(n => n.tag === tag)
      if (!node) throw new Error('层级节点不存在')
      for (const child of nodes.filter(n => n.parent === tag)) ctx.put(child.id, nodeKind, { tag: child.tag, ...(node.parent ? { parent: node.parent } : {}) })
      ctx.deleteRecord(node.id)
      return { label: `移除「${tag}」的层级节点（保留素材标签）`, result: { tag } }
    }
  },
  operations: [{ name: 'tag_tree_set_parent', effect: 'structure', title: '设置标签母子关系', command: 'setParent', input: parentInput,
    description: 'tag 和 parent 是共享标签文字键。parent=null 放到根层；新名称登记为空节点。移动整条分支，禁止循环；不改变分组或素材打标，可撤销。' },
    { name: 'tag_tree_remove', effect: 'structure', title: '移除标签层级节点', command: 'remove', input: removeInput,
    description: '仅移除此节点，子标签提升一级；保留全部素材标签和分组，不递归删除。可撤销。' }],
  queries: [{
    name: 'list_nodes', title: '读取标签层级目录', description: '每批最多 50 个节点，含空节点。将返回的 nextCursor 放回 args.cursor 继续读取。这里只返回层级关系；精确标签计数使用 tags.list_tags。',
    input: z.object({ cursor: z.string().max(2000).optional() }).strict(),
    output: z.object({ nodes: z.array(z.object({ id: z.string(), tag: z.string(), parent: z.string().nullable() })), nextCursor: z.string().nullable() }),
    run(ctx, args) {
      const page = ctx.search({ query: { scope: 'all', role: 'management', has: [nodeKind], dir: 'asc' }, limit: 50, ...(args.cursor ? { cursor: String(args.cursor) } : {}) })
      return { nodes: page.items.map(item => { const b = ctx.blocksOf(item.id, [nodeKind])[nodeKind].data; return { id: item.id, tag: String(b.tag), parent: typeof b.parent === 'string' ? b.parent : null } }), nextCursor: page.nextCursor }
    }
  }, {
    name: 'branch', title: '查询标签分支', description: '返回动态分支查询及去重素材数。可将 query 交给 search_items 或保存视图；后代变化时自动按当前关系解析。scope 可限定当前视图，省略为全库素材。',
    input: z.object({ tag: name, scope: z.record(z.string(), z.unknown()).optional() }).strict(),
    output: z.object({ query: z.record(z.string(), z.unknown()), count: z.number().int().nonnegative() }),
    run(ctx, args) {
      const scope = (args.scope ?? { scope: 'all', role: 'material' }) as Query
      const query = { ...scope, where: [...scope.where ?? [], branchCondition(String(args.tag))] }
      return { query, count: ctx.count(query) }
    }
  }]
}
