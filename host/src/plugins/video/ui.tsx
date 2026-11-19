import { useVideoPlayback } from './playback'
// 视频插件的界面：检查器分区、空格预览里的简易播放、播放器标签页（双击打开）。
// 也为批注插件的时间段锚点服务：空格预览一个片段 = 循环播放这一段。
// 被嵌进文字里（![[…]]，设计文档 11.9）：视频是一个小播放器，片段只播那一段。

import { useEffect, useRef, type RefObject } from 'react'
import { useEntity } from '../../plugin-api/ui/data'
import { useKeys } from '../../plugin-api/ui/hooks'
import type { PreviewProps, UiHost, UiPlugin, ViewProps } from '../../plugin-api/ui/contracts'
import { formatDuration } from '../../plugin-api/ui/widgets'
import { playableSource, useProxy } from './hooks'
import { playerTabType } from './player'

function VideoSection({ view, host }: ViewProps) {
  const v = view.blocks.video.data
  const pb = view.blocks.videoPlayback?.data
  return (
    <dl className="props">
      <dt>时长</dt>
      <dd>{formatDuration(Number(v.duration))}</dd>
      <dt>尺寸</dt>
      <dd>
        {String(v.width)} × {String(v.height)}
      </dd>
      <dt>编码</dt>
      <dd>
        {String(v.codec)}
        {v.audio ? ` / ${String(v.audio)}` : '（无声音）'}
      </dd>
      {v.fps ? (
        <>
          <dt>帧率</dt>
          <dd>{String(v.fps)}</dd>
        </>
      ) : null}
      <dt>播放</dt>
      <dd>{v.playable ? '可直接播放' : view.blocks.proxy ? '已转换格式' : '播放前需要转换格式'}</dd>
      {pb && (
        <>
          <dt>进度</dt>
          <dd>{pb.finished ? '已看完' : `上次看到 ${formatDuration(Number(pb.position))}`}</dd>
        </>
      )}
      <dt />
      <dd>
        <button className="small" onClick={() => host.open(view.id)}>
          在播放器中打开
        </button>
      </dd>
    </dl>
  )
}

/** 简易播放：能直接播的用原文件；不能的请求按需转码，显示进度。完整的播放器是标签页（player.tsx）。 */
function VideoPreview({ view, host, registerKeys }: PreviewProps) {
  const src = playableSource(view)
  const { progress, error } = useProxy(host, view, !src)
  const ref = useRef<HTMLVideoElement>(null)
  useVideoPlayback(ref, view, host, src?.seq)

  // 预览浮层里的按键：空格播放 / 暂停，左右方向键前后 5 秒；Esc 仍由宿主关闭预览
  useKeys(registerKeys, (e) => {
    const el = ref.current
    if (!el) return false
    if (e.key === ' ') {
      if (el.paused) void el.play()
      else el.pause()
      return true
    }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      el.currentTime = Math.max(0, Math.min(el.duration || 0, el.currentTime + (e.key === 'ArrowLeft' ? -5 : 5)))
      return true
    }
    return false
  })

  if (!src) {
    return (
      <div className="preview-status" onMouseDown={(e) => e.stopPropagation()}>
        {error ? `无法播放：${error}` : `正在转换格式… ${progress !== undefined ? Math.round(progress * 100) + '%' : ''}`}
      </div>
    )
  }
  return (
    <video
      key={view.id}
      ref={ref}
      className="preview-video"
      src={host.url(String(src.data.path), src.seq)}
      controls
      autoPlay
      onMouseDown={(e) => e.stopPropagation()}
    />
  )
}

/**
 * 只播一段：读好后跳到起点；到终点时回到起点，loop 时接着放，否则停下。
 * 只是看一眼，不记播放进度。
 */
function useSegment(ref: RefObject<HTMLVideoElement | null>, view: ViewProps['view'], loop: boolean) {
  const a = view.blocks.anchor.data
  const start = Number(a.start) || 0
  const end = Number(a.end) || 0
  const target = useEntity(String(a.target))
  const src = target && playableSource(target)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const toStart = () => {
      el.currentTime = start
    }
    const onTime = () => {
      if (end <= start || el.currentTime < end) return
      if (!loop) el.pause()
      toStart()
    }
    if (el.readyState >= 1) toStart()
    el.addEventListener('loadedmetadata', toStart)
    el.addEventListener('timeupdate', onTime)
    return () => {
      el.removeEventListener('loadedmetadata', toStart)
      el.removeEventListener('timeupdate', onTime)
    }
  }, [ref, start, end, loop, src?.seq])
  return { target, src }
}

/** 片段（时间段锚点）的空格预览：循环播原视频的这一段。 */
function SegmentPreview({ view, host, registerKeys }: PreviewProps) {
  const ref = useRef<HTMLVideoElement>(null)
  const { target, src } = useSegment(ref, view, true)

  useKeys(registerKeys, (e) => {
    const el = ref.current
    if (!el || e.key !== ' ') return false
    if (el.paused) void el.play()
    else el.pause()
    return true
  })

  if (!target) return null
  if (!src) return <div className="preview-status">原视频还没有可以播放的文件，在播放器里打开它会先转换格式</div>
  return (
    <video
      ref={ref}
      className="preview-video"
      src={host.url(String(src.data.path), src.seq)}
      controls
      autoPlay
      onMouseDown={(e) => e.stopPropagation()}
    />
  )
}

const posterOf = (view: ViewProps['view'], host: UiHost) => {
  const s = view.blocks.still
  return s ? host.url(String(s.data.path), s.seq) : undefined
}

/** 嵌在文字里的视频：一个小播放器，不自动播放。不能直接播放的显示代表图，点了去播放器（那里会转换格式）。 */
function VideoEmbed({ view, host }: ViewProps) {
  const src = playableSource(view)
  if (!src) {
    return (
      <span className="embed-video-poster" title="在播放器中打开" onClick={() => host.open(view.id)}>
        {posterOf(view, host) && <img src={posterOf(view, host)} alt="" />}
        <span className="embed-play">▶</span>
      </span>
    )
  }
  return <video className="embed-video" src={host.url(String(src.data.path), src.seq)} poster={posterOf(view, host)} controls preload="metadata" />
}

/** 嵌在文字里的片段：只播这一段，到终点停下。 */
function SegmentEmbed({ view, host }: ViewProps) {
  const ref = useRef<HTMLVideoElement>(null)
  const { src } = useSegment(ref, view, false)
  if (!src) return <img className="embed-img" src={posterOf(view, host)} alt="" onClick={() => host.open(view.id)} />
  return <video ref={ref} className="embed-video" src={host.url(String(src.data.path), src.seq)} poster={posterOf(view, host)} controls preload="metadata" />
}

export const videoUi: UiPlugin = {
  id: 'video',
  views: [
    { id: 'videos', title: '视频', query: { has: ['video'] }, defaultVisible: false, order: 20 },
    {
      id: 'unfinished',
      title: '没看完的',
      query: { has: ['video', 'videoPlayback'], where: [{ op: 'eq', kind: 'videoPlayback', field: 'finished', value: false }] },
      defaultVisible: false,
      order: 21
    }
  ],
  embeds: [
    { priority: 10, match: (v) => !!v.blocks.video && !!v.blocks.file, Component: VideoEmbed },
    { priority: 10, match: (v) => v.blocks.anchor?.data.type === '时间段', Component: SegmentEmbed }
  ],
  previews: [
    { priority: 10, match: (v) => !!v.blocks.video && !!v.blocks.file, Component: VideoPreview },
    { priority: 10, match: (v) => v.blocks.anchor?.data.type === '时间段', Component: SegmentPreview }
  ],
  tabTypes: [playerTabType],
  // 双击视频：在播放器标签页里打开，带上打开它的列表
  opens: [{ id: 'video.player', title: '视频播放器', priority: 10, match: (v) => !!v.blocks.video && !!v.blocks.file, tab: 'video.player', params: (v, from) => ({ id: v.id, list: from }) }],
  badges: [{ order: 50, get: (v) => (v.blocks.video ? { text: formatDuration(Number(v.blocks.video.data.duration)) } : undefined) }],
  sections: [{ id: 'video', title: '视频', order: 20, kinds: ['video', 'frames', 'proxy', 'videoPlayback'], match: (v) => !!v.blocks.video, Component: VideoSection }]
}

export { videoUi as plugin }
