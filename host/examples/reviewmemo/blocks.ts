// 将本目录复制到 src/plugins/reviewmemo 后，路径即可使用。
import type { BlockKind } from '../../shared/blocks'

export const blocks: BlockKind[] = [{
  id: 'reviewmemo',
  plugin: 'reviewmemo',
  title: '复看备忘',
  rebuildable: false,
  version: 1,
  fields: { text: { type: 'longtext', title: '备忘', search: true } }
}]
