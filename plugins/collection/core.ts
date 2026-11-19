import { z } from 'zod';
import type { CorePlugin, CommandContext } from '@resource-manager/plugin-api/core/contracts';
import { blocks, collectionV1, collectionV2 } from './blocks';
import { groupQuery, membersQuery, normalizeParents, wouldCycle } from './model';
import { queries } from './queries';

const id = z.string().min(1).max(200);
const title = z.string().trim().min(1).max(200);
const order = z.number().finite().min(0).max(Number.MAX_SAFE_INTEGER);
const ids = z.array(id).max(100).transform(values => [...new Set(values)]);

const create = z.object({
  title,
  order: order.optional(),
  ids: ids.default([]),
  cover: id.optional(),
  parent: id.nullable().optional()
}).strict();
const rename = z.object({ id, title }).strict();
const remove = z.object({ id }).strict();
const move = z.object({ ids: ids.refine(a => a.length > 0), group: id.nullable() }).strict();
const cover = z.object({ id, assetId: id.nullable() }).strict();
const reorder = z.object({ id, beforeId: id.nullable(), group: id.nullable() }).strict();
const setParent = z.object({ id, parent: id.nullable() }).strict();

function group(ctx: CommandContext, id: string) {
  if (!ctx.query({ ids: [id], has: ['collection'] }).ids.length)
    throw new Error('[NOT_FOUND] 组不存在或已在回收站');
  return ctx.blocksOf(id).collection.data;
}

function materials(ctx: CommandContext, ids: string[]) {
  if (ctx.query({ ids, lacks: ['collection'], role: 'material' }).ids.length !== ids.length)
    throw new Error('[INVALID_MEMBER] 成员必须是有效素材，不能是组、管理记录或回收站内容');
}

function moveTo(ctx: CommandContext, values: string[], target: string | null) {
  if (target)
    group(ctx, target);
  materials(ctx, values);
  values.forEach((id, index) => {
    const old = ctx.blocksOf(id).collectionMember?.data;
    if (target === null)
      ctx.remove(id, 'collectionMember');
    else if (old?.group !== target)
      ctx.put(id, 'collectionMember', { group: target, order: Date.now() + index });
  });
}

export const plugin: CorePlugin = {
  id: 'collection',
  version: 1,
  blocks,
  compatibleSchemas: [collectionV1, collectionV2],
  dataLifecycle: {
    version: 1,
    disposableRecords: ['collection'],
    retainedEffects: [
      '清理文件夹数据不会删除文件夹内的素材原件；素材仅解除文件夹归属并保留在仓库中。',
      '若文件夹记录上还挂有笔记、标签等其他插件数据，或仍被其他保留数据引用，该文件夹记录会保留。',
      '本机文件夹树展开／折叠状态可在“插件的本库本机数据”中单独重置。'
    ]
  },
  queries,
  commands: {
    create(ctx, args) {
      const input = create.parse(args);
      materials(ctx, input.ids);
      if (input.cover && !input.ids.includes(input.cover))
        throw new Error('初始封面必须在本次加入的成员中');
      if (input.parent)
        group(ctx, input.parent);
      const id = ctx.createEntity();
      ctx.put(id, 'collection', {
        title: input.title,
        order: input.order ?? Date.now(),
        ...(input.cover ? { cover: input.cover } : {}),
        ...(input.parent ? { parent: input.parent } : {})
      });
      moveTo(ctx, input.ids, id);
      return {
        label: input.parent ? '新建子文件夹' : '新建组',
        result: input.parent !== undefined ? { id, parent: input.parent } : { id }
      };
    },
    rename(ctx, args) {
      const input = rename.parse(args), data = group(ctx, input.id);
      ctx.put(input.id, 'collection', { ...data, title: input.title });
      return { label: '重命名组', result: { id: input.id } };
    },
    setParent(ctx, args) {
      const input = setParent.parse(args);
      const data = { ...group(ctx, input.id) };
      if (input.parent !== null) {
        group(ctx, input.parent);
        const activeIds = new Set(ctx.query(groupQuery).ids);
        const rawParents = new Map<string, string | null>();
        for (const gid of activeIds) {
          const p = ctx.blocksOf(gid).collection?.data.parent;
          rawParents.set(gid, typeof p === 'string' ? p : null);
        }
        const cleanParents = normalizeParents(rawParents, activeIds);
        if (wouldCycle(cleanParents, input.id, input.parent))
          throw new Error('[CYCLE] 不能将文件夹移动到自身或其子文件夹下');
        data.parent = input.parent;
      } else {
        delete data.parent;
      }
      ctx.put(input.id, 'collection', data);
      return { label: input.parent ? '移动文件夹层级' : '移到顶层目录', result: { id: input.id, parent: input.parent } };
    },
    delete(ctx, args) {
      const { id } = remove.parse(args);
      group(ctx, id);
      ctx.trash([id]);
      return { label: '删除组（成员保留）', result: { id } };
    },
    restore(ctx, args) {
      const { id } = remove.parse(args);
      if (!ctx.query({ scope: 'trash', ids: [id], has: ['collection'] }).ids.length && !ctx.query({ ids: [id], has: ['collection'] }).ids.length)
        throw new Error('[NOT_FOUND] 组不存在或已彻底删除');
      ctx.restore([id]);
      return { label: '恢复组', result: { id } };
    },
    move(ctx, args) {
      const { ids, group } = move.parse(args);
      moveTo(ctx, ids, group);
      return { label: group ? '移动到组' : '移出组', result: { ids, group } };
    },
    setCover(ctx, args) {
      const { id, assetId } = cover.parse(args), data = { ...group(ctx, id) };
      if (assetId) {
        materials(ctx, [assetId]);
        if (ctx.blocksOf(assetId).collectionMember?.data.group !== id)
          throw new Error('封面必须是本组成员');
        data.cover = assetId;
      } else {
        delete data.cover;
      }
      ctx.put(id, 'collection', data);
      return { label: assetId ? '设置组封面' : '恢复自动封面', result: { id } };
    },
    reorder(ctx, args) {
      const input = reorder.parse(args);
      if (input.group)
        group(ctx, input.group);
      const list = ctx.query(input.group ? membersQuery(input.group) : groupQuery).ids;
      if (!list.includes(input.id) || (input.beforeId && !list.includes(input.beforeId)))
        throw new Error('排序对象已不在当前列表，请刷新后重试');
      if (list.length > 10000)
        throw new Error('V1 暂不支持超过 10000 项的重排');
      if (input.beforeId === input.id)
        return { label: '排序未变', result: { id: input.id } };
      const next = list.filter(id => id !== input.id);
      next.splice(input.beforeId ? next.indexOf(input.beforeId) : next.length, 0, input.id);
      const kind = input.group ? 'collectionMember' : 'collection';
      next.forEach((id, index) => ctx.put(id, kind, { ...ctx.blocksOf(id)[kind].data, order: index + 1 }));
      return { label: input.group ? '调整组内顺序' : '调整组顺序', result: { id: input.id } };
    }
  },
  operations: [
    { name: 'collection_create', effect: 'structure', title: '新建组', description: '创建文件夹／素材组，可选 parent 指定上级文件夹，可选 ids 同时移动最多100项成员，cover 必须在 ids 中；组与成员标签互不继承。', command: 'create', input: create },
    { name: 'collection_rename', effect: 'structure', title: '重命名组', description: '修改组名，可撤销。', command: 'rename', input: rename },
    { name: 'collection_set_parent', effect: 'structure', title: '设置上级文件夹', description: '调整文件夹所在上级目录（parent:null 移回顶层根目录），自动拦截环路，可撤销。', command: 'setParent', input: setParent },
    { name: 'collection_delete', effect: 'structure', title: '删除组', description: '组移入回收站，link 成员及关系保留；恢复后成员归回。', command: 'delete', input: remove },
    { name: 'collection_restore', effect: 'structure', title: '恢复组', description: '从回收站恢复组，仍指向它的成员重新归组；已移动的成员不抢回。活跃组重复恢复不改变数据。', command: 'restore', input: remove },
    { name: 'collection_move', effect: 'data', title: '移动成员', description: '最多100项，显式覆盖原归属；group:null移出。同组重复加入保留顺序；成员必须是普通素材。', command: 'move', input: move },
    { name: 'collection_set_cover', effect: 'data', title: '设置组封面', description: '选择有效成员作封面；assetId:null恢复自动。无效手选引用保留，显示回退首个成员。', command: 'setCover', input: cover },
    { name: 'collection_reorder', effect: 'data', title: '调整顺序', description: 'group:null调整组列表，否则调整指定组成员；将id移到beforeId前，null表示末尾。', command: 'reorder', input: reorder }
  ],
  ingestMetadata: [{
    id: 'collection.join',
    title: '导入到组',
    description: '检查目标组后设置当前素材归属，显式覆盖旧组；可给order，不给则同组保留原顺序，新归属以当前时间赋序。',
    input: z.object({ group: id, order: order.optional() }).strict(),
    apply(ctx, input) {
      const target = ctx.readEntity(input.group as string, ['collection']), current = ctx.blocksOf();
      if (!target || target.deleted || !target.blocks.collection)
        throw new Error('目标组不存在或已在回收站');
      if (current.collection)
        throw new Error('组不能作为普通成员导入');
      const previous = current.collectionMember?.data, group = input.group as string;
      if (previous?.group === group && (input.order === undefined || previous.order === input.order))
        return { status: 'unchanged' };
      ctx.put('collectionMember', { group, order: input.order ?? (previous?.group === group ? previous.order : undefined) ?? Date.now() });
      return { status: 'applied' };
    }
  }],
  exportSections: [{
    id: 'collection.description',
    kind: 'collection',
    fields: ['title', 'order', 'cover', 'parent'],
    order: 5,
    render: data => ({ markdown: `# ${String(data.title ?? '组')}\n\n组记录；成员文件需另行选择导出。`, content: true })
  }]
};
