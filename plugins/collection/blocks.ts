import type { BlockKind } from '@resource-manager/plugin-api/blocks';

export const collectionV1: BlockKind = {
  id: 'collection', plugin: 'collection', title: '组', version: 1, rebuildable: false, content: true, captured: true,
  display: { title: 'title', priority: 8 },
  fields: {
    title: { type: 'text', title: '组名', index: true, search: true },
    order: { type: 'number', title: '顺序', index: true },
    cover: { type: 'ref', ref: 'link', title: '封面素材' }
  }
};

export const collectionV2: BlockKind = {
  ...collectionV1,
  version: 2,
  fields: {
    ...collectionV1.fields,
    parent: { type: 'ref', ref: 'link', title: '上级组', index: true }
  }
};

export const collectionBlock: BlockKind = { ...collectionV2, version: 3, container: true };

export const collectionMemberBlock: BlockKind = {
  id: 'collectionMember', plugin: 'collection', title: '所在组', version: 1, rebuildable: false, captured: true,
  fields: {
    group: { type: 'ref', ref: 'link', title: '组', index: true },
    order: { type: 'number', title: '组内顺序', index: true }
  }
};

export const blocks: BlockKind[] = [collectionBlock, collectionMemberBlock];
