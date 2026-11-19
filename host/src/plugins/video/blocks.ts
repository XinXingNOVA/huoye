import type { BlockKind } from '../../shared/blocks'

/** 视频块：时长、尺寸、编码等，从文件读出，可重建。宽高已按旋转换算成显示时的方向。 */
export const videoBlock: BlockKind = {
  id: 'video',
  plugin: 'video',
  title: '视频',
  rebuildable: true,
  version: 1,
  fields: {
    duration: { type: 'number', title: '时长', index: true, format: 'duration' },
    width: { type: 'number', title: '宽', index: true, format: 'px' },
    height: { type: 'number', title: '高', index: true, format: 'px' },
    fps: { type: 'number', title: '帧率' },
    codec: { type: 'text', title: '视频编码', index: true },
    audio: { type: 'text', title: '音频编码', index: true },
    rotation: { type: 'number', title: '旋转' },
    playable: { type: 'boolean', title: '可直接播放', index: true }
  }
}

/** 预览帧块：均匀取 count 帧，横向拼成一张图，供悬停滑动预览。 */
export const framesBlock: BlockKind = {
  id: 'frames',
  plugin: 'video',
  title: '预览帧',
  rebuildable: true,
  version: 1,
  fields: {
    path: { type: 'text', title: '缓存路径', file: true },
    count: { type: 'number', title: '帧数' },
    tileWidth: { type: 'number', title: '每帧宽', format: 'px' },
    tileHeight: { type: 'number', title: '每帧高', format: 'px' },
    source: { type: 'number', title: '来源序号' }
  }
}

/** 代理块：不能直接播放时转出的 MP4。按需生成。 */
export const proxyBlock: BlockKind = {
  id: 'proxy',
  plugin: 'video',
  title: '播放代理',
  rebuildable: true,
  version: 1,
  fields: {
    path: { type: 'text', title: '缓存路径', file: true },
    mode: { type: 'enum', title: '方式', options: ['remux', 'transcode'] },
    source: { type: 'number', title: '来源序号' }
  }
}

export const VIDEO_EXTS = new Set(['mp4', 'm4v', 'mov', 'mkv', 'webm', 'avi', 'wmv', 'flv', 'mpg', 'mpeg', '3gp', 'ts', 'mts', 'm2ts', 'ogv'])

/** 本插件的全部静态定义，由核心和界面共同登记。 */
export const videoPlaybackBlock: BlockKind = {
  id: 'videoPlayback',
  plugin: 'video',
  title: '视频播放记录',
  rebuildable: false,
  history: false,
  version: 1,
  fields: {
    session: { type: 'text', title: '最近播放会话' },
    sessionStarted: { type: 'number', title: '会话开始时间' },
    position: { type: 'number', title: '上次位置', format: 'duration' },
    finished: { type: 'boolean', title: '已播完', index: true },
    plays: { type: 'number', title: '播放次数', index: true },
    lastPlayed: { type: 'date', title: '最后播放', index: true }
  }
}

/** 本插件的全部静态定义，由核心和界面共同登记。 */
export const blocks: BlockKind[] = [videoBlock, framesBlock, proxyBlock, videoPlaybackBlock]
