// 一个组织记录容纳全部分组：移动标签只修改这份记录，不重写素材，也不会留下双重归属。
// 每次从核心读取最新记录再修改，连续操作不会用界面旧快照覆盖别人刚做的整理。
import { ulid } from 'ulid'
import { parseInput } from '../../../../src/plugin-api/operations'
import { updateTagsSchema } from './input'
import type { Command, CommandContext } from '../../../../src/plugin-api/core/contracts'
import type { TagGroup } from '../blocks'

function load(ctx: CommandContext) {
  const id = ctx.query({ scope: 'all', has: ['tagGroups'], dir: 'asc' }).ids[0]
  const groups = id ? ctx.blocksOf(id).tagGroups.data.groups as TagGroup[] : []
  return { id, groups: groups.map((g) => ({ ...g, tags: [...g.tags] })) }
}

function titleOf(value: unknown, groups: TagGroup[], except?: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('请输入分组名称')
  const title = value.trim()
  if (title === '未分组') throw new Error('“未分组”保留给还没有归组的标签')
  if (groups.some((g) => g.id !== except && g.title === title)) throw new Error('已经有同名分组')
  return title
}

function groupOf(groups: TagGroup[], id: unknown): TagGroup {
  const group = groups.find((g) => g.id === id)
  if (!group) throw new Error('分组已经不存在，请重新选择')
  return group
}

const save = (ctx: CommandContext, id: string | undefined, groups: TagGroup[]) => {
  if (groups.length) ctx.put(id ?? ctx.createEntity(), 'tagGroups', { groups })
  else if (id) ctx.deleteRecord(id)
}

export const commands: Record<string, Command> = {
  deleteGroupsRecord(ctx, { id }) {
    if (typeof id !== 'string' || !ctx.blocksOf(id).tagGroups) throw new Error('分组记录不存在')
    ctx.deleteRecord(id)
    return { label: '删除旧分组记录（保留标签）' }
  },
  update(ctx, input) {
    const { ids: rawIds, add, remove } = parseInput(updateTagsSchema, input)
    const ids = [...new Set(rawIds)]
    const live = new Set(ctx.query({ ids }).ids)
    const missing = ids.filter(id => !live.has(id))
    if (missing.length) throw new Error(`[NOT_FOUND] 素材不存在或已在回收站：${missing.join(', ')}`)
    const changed: string[] = [], unchanged: string[] = []
    for (const id of ids) {
      const previous = (ctx.blocksOf(id).tags?.data.values ?? []) as string[]
      const next = [...new Set([...previous.filter(t => !remove.includes(t)), ...add])]
      if (JSON.stringify(previous) === JSON.stringify(next)) { unchanged.push(id); continue }
      if (next.length) ctx.put(id, 'tags', { values: next })
      else ctx.remove(id, 'tags')
      changed.push(id)
    }
    return { label: `更新标签（${changed.length} 项）`, result: { changed, unchanged, added: [...new Set(add)], removed: [...new Set(remove)] } }
  },
  createGroup(ctx, { title, tag }) {
    const { id, groups } = load(ctx)
    const group: TagGroup = { id: ulid(), title: titleOf(title, groups), tags: [] }
    if (tag !== undefined) {
      if (typeof tag !== 'string' || !tag.trim()) throw new Error('标签不能为空')
      for (const g of groups) g.tags = g.tags.filter((t) => t !== tag)
      group.tags.push(tag)
    }
    save(ctx, id, [...groups, group])
    return { label: `新建标签分组「${group.title}」`, result: group.id }
  },
  renameGroup(ctx, { group: target, title }) {
    const { id, groups } = load(ctx)
    const group = groupOf(groups, target)
    group.title = titleOf(title, groups, group.id)
    save(ctx, id, groups)
    return { label: `重命名标签分组为「${group.title}」` }
  },
  deleteGroup(ctx, { group: target }) {
    const { id, groups } = load(ctx)
    const group = groupOf(groups, target)
    save(ctx, id, groups.filter((g) => g !== group))
    return { label: `删除标签分组「${group.title}」（保留标签）` }
  },
  moveTag(ctx, { tag, group: target }) {
    if (typeof tag !== 'string' || !tag.trim()) throw new Error('标签不能为空')
    const { id, groups } = load(ctx)
    const destination = target === null ? undefined : groupOf(groups, target)
    for (const g of groups) g.tags = g.tags.filter((t) => t !== tag)
    destination?.tags.push(tag)
    if (id) save(ctx, id, groups)
    return { label: `把标签「${tag}」移到「${destination?.title ?? '未分组'}」` }
  }
}
