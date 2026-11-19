import type { BlockKind } from '../../shared/blocks'

export const audioBlock: BlockKind = {
  id: 'audio', plugin: 'audio', title: '音频', rebuildable: true, version: 1,
  display: { summary: 'title' },
  fields: {
    duration: { type: 'number', title: '时长', index: true, format: 'duration' },
    codec: { type: 'text', title: '编码', index: true },
    sampleRate: { type: 'number', title: '采样率（Hz）', index: true },
    channels: { type: 'number', title: '声道数', index: true },
    bitRate: { type: 'number', title: '码率（bit/s）' },
    title: { type: 'text', title: '曲名', search: true, index: true },
    artist: { type: 'text', title: '艺术家', search: true, index: true },
    album: { type: 'text', title: '专辑', search: true, index: true },
    playable: { type: 'boolean', title: '可直接播放', index: true }
  }
}

export const audioProxyBlock: BlockKind = {
  id: 'audioProxy', plugin: 'audio', title: '音频播放副本', rebuildable: true, version: 1,
  fields: {
    path: { type: 'text', title: '路径', file: true },
    source: { type: 'text', title: '原文件内容指纹' }
  }
}

export const audioPlaybackBlock: BlockKind = {
  id: 'audioPlayback',
  plugin: 'audio',
  title: '音频播放记录',
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
export const blocks = [audioBlock, audioProxyBlock, audioPlaybackBlock]
export const AUDIO_EXTS = new Set(['mp3', 'wav', 'flac', 'm4a', 'm4b', 'ogg', 'opus', 'aac', 'aif', 'aiff', 'wma', 'ape'])
