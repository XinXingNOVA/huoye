import type { BlockKind } from '@resource-manager/plugin-api/blocks'

export const blocks: BlockKind[] = [
  {
    id: 'musicLyricSource', plugin: 'music', title: '歌词文件索引', version: 1, rebuildable: true,
    display: { summary: 'text' },
    fields: {
      title: { type: 'text', title: '曲名', search: true, index: true },
      artist: { type: 'text', title: '歌手', search: true, index: true },
      album: { type: 'text', title: '专辑', search: true },
      duration: { type: 'number', title: '歌词标注时长', format: 'duration' },
      tagged: { type: 'boolean', title: '含曲名标记' },
      text: { type: 'longtext', title: '歌词原文', search: true },
      hash: { type: 'text', title: '原文件指纹' },
      name: { type: 'text', title: '原文件名' },
      error: { type: 'text', title: '读取问题' }
    }
  },
  {
    id: 'musicPlaylist', plugin: 'music', title: '歌单', version: 1, rebuildable: false,
    standalone: true, management: {}, display: { title: 'title' },
    fields: {
      title: { type: 'text', title: '名称', search: true },
      tracks: { type: 'ref', list: true, ref: 'link', title: '歌曲顺序', index: true }
    }
  },
  {
    id: 'musicLyrics', plugin: 'music', title: '歌词', version: 1, rebuildable: false, captured: true,
    display: { summary: 'text' },
    fields: {
      text: { type: 'longtext', title: '原始歌词', search: true },
      offset: { type: 'number', title: '时间偏移（秒）', min: -600, max: 600 },
      source: { type: 'text', title: '导入文件名' }
    }
  },
  {
    id: 'musicTrack', plugin: 'music', title: '歌曲信息修正', version: 1, rebuildable: false, captured: true,
    fields: {
      title: { type: 'text', title: '曲名', search: true, index: true },
      artist: { type: 'text', title: '艺术家', search: true, index: true },
      album: { type: 'text', title: '专辑', search: true, index: true }
    }
  }
]
