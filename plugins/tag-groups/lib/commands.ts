// 一个组织记录容纳全部分组：移动标签只修改这份记录，不重写素材，也不会留下双重归属。
// 每次从核心读取最新记录再修改，连续操作不会用界面旧快照覆盖别人刚做的整理。
import { ulid } from 'ulid'
import { parseInput } from '@resource-manager/plugin-api/operations'
import { createGroupSchema, renameGroupSchema, deleteGroupSchema, moveTagSchema } from './input'
import type { Command, CommandContext } from '@resource-manager/plugin-api/core/contracts'
import type { TagGroup } from '../blocks'

function load(ctx: CommandContext) {
  const id = ctx.query({ scope: 'all', has: ['tag-groups.groups'], dir: 'asc' }).ids[0]
  const groups = id ? ctx.blocksOf(id)['tag-groups.groups'].data.groups as TagGroup[] : []
  return { id, groups: groups.map(g => ({ ...g, tags: [...g.tags] })) }
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
  ctx.put(id ?? ctx.createEntity(), 'tag-groups.groups', { groups })
}

export const commands: Record<string, Command> = {
  importLegacy(ctx) {
    if (load(ctx).id) throw new Error('已有独立分组记录，不能覆盖导入')
    const legacy = ctx.query({ scope: 'all', has: ['tagGroups'], dir: 'asc' }).ids[0]
    if (!legacy) throw new Error('没有旧分组可导入')
    const groups = ctx.blocksOf(legacy).tagGroups.data.groups as TagGroup[]
    save(ctx, undefined, groups.map(g => ({ ...g, tags: [...g.tags] })))
    return { label: '导入旧版标签分组（保留备份与素材标签）', result: { groups: groups.length } }
  },
  createGroup(ctx, input) {
    const { title, tag } = parseInput(createGroupSchema, input)
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
  renameGroup(ctx, input) {
    const { group: target, title } = parseInput(renameGroupSchema, input)
    const { id, groups } = load(ctx)
    const group = groupOf(groups, target)
    group.title = titleOf(title, groups, group.id)
    save(ctx, id, groups)
    return { label: `重命名标签分组为「${group.title}」` }
  },
  deleteGroup(ctx, input) {
    const { group: target } = parseInput(deleteGroupSchema, input)
    const { id, groups } = load(ctx)
    const group = groupOf(groups, target)
    save(ctx, id, groups.filter((g) => g !== group))
    return { label: `删除标签分组「${group.title}」（保留标签）` }
  },
  moveTag(ctx, input) {
    const { tag, group: target } = parseInput(moveTagSchema, input)
    if (typeof tag !== 'string' || !tag.trim()) throw new Error('标签不能为空')
    const { id, groups } = load(ctx)
    const destination = target === null ? undefined : groupOf(groups, target)
    for (const g of groups) g.tags = g.tags.filter((t) => t !== tag)
    destination?.tags.push(tag)
    save(ctx, id, groups)
    return { label: `把标签「${tag}」移到「${destination?.title ?? '未分组'}」` }
  }
}
