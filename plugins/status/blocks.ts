import type { BlockKind } from '@resource-manager/plugin-api/blocks'

export const STATUS_OPTIONS = ['待处理', '进行中', '已完成', '搁置']

/**
 * 状态块：单值字段。放入"状态为某值"的视图时是"改成"，素材会离开原来那个状态的视图
 * （设计文档 10.7）；看板的每一列就是这样一个视图。
 */
export const statusBlock: BlockKind = {
  id: 'status',
  plugin: 'status',
  title: '状态',
  rebuildable: false,
  version: 1,
  fields: {
    value: { type: 'enum', title: '状态', options: STATUS_OPTIONS, index: true }
  }
}

/** 本插件的全部静态定义，由核心和界面共同登记。 */
export const blocks: BlockKind[] = [statusBlock]
