// 媒体插件的公共协作入口；记录属于仓库，播放器只负责报告实际播放行为。
import { useEffect, type RefObject } from 'react'
export interface PlaybackSample { position: number; finished: boolean; lastPlayed: number; session: string; sessionStarted: number }
export interface PlaybackRecorder {
  position?: number
  save(sample: PlaybackSample): Promise<unknown>
  onError(): void
}

/** 播放中每隔多久记一次位置：播放进度块不保留历史，可以写得勤一些，意外退出也不丢太多。 */
const SAVE_EVERY = 10_000

/**
 * 播放记录：从上次的位置继续；暂停、看完、离开时，以及播放中定时，把位置写进播放进度块。
 * 只有真的播放过才记，单纯打开不算一次播放。
 * 调用方要让媒体元素按身份换元素（key），离开时旧元素还留着它的位置。
 */
export function usePlaybackRecord(ref: RefObject<HTMLMediaElement | null>, identity: string, source: unknown, recorder: PlaybackRecorder, options?: { restore?: boolean }): void {
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const session = crypto.randomUUID()
    let sessionStarted = 0
    let played = false
    let savedAt = 0
    let savedSignature: string | undefined
    const save = (finished: boolean) => {
      if (!played || !Number.isFinite(el.duration) || el.duration <= 0) return
      const position = finished ? 0 : el.currentTime
      const completed = finished || el.currentTime / el.duration > 0.95
      const signature = `${position}:${completed}`
      // 暂停后关闭/重载不再写同一个位置，也避免后台旧播放器覆盖较新的试听记录。
      if (signature === savedSignature) return
      savedSignature = signature
      savedAt = Math.max(Date.now(), savedAt + 1)
      void recorder.save({
        position,
        finished: completed,
        session, sessionStarted,
        lastPlayed: savedAt
      }).catch(() => {
        if (savedSignature === signature) savedSignature = undefined
        recorder.onError()
      })
    }
    const onLoaded = () => {
      const pos = Number(recorder.position ?? 0)
      if (options?.restore !== false && pos > 0 && pos < el.duration - 1) el.currentTime = pos
    }
    const onPlay = () => {
      // 定时保存从开始播放算起
      if (!played) savedAt = Date.now()
      // 重新按播放是新的有效活动；保留会话 ID，不让旧暂停回调冒充本次恢复。
      sessionStarted = Math.max(Date.now(), savedAt + 1)
      played = true
    }
    const onPause = () => {
      if (!el.ended) save(false)
    }
    const onEnded = () => save(true)
    const onTime = () => {
      if (!el.paused && Date.now() - savedAt > SAVE_EVERY) save(false)
    }
    // 这里监听所属会话退出，不随显示文档重绑，以免移窗重置播放次数／恢复位置。
    // 正常关闭内容小窗会先卸载组件，走下面的保存清理。
    const onUnload = () => {
      if (!el.ended) save(false)
    }
    if (el.readyState >= 1) onLoaded()
    el.addEventListener('loadedmetadata', onLoaded)
    el.addEventListener('play', onPlay)
    el.addEventListener('pause', onPause)
    el.addEventListener('ended', onEnded)
    el.addEventListener('timeupdate', onTime)
    window.addEventListener('beforeunload', onUnload)
    return () => {
      window.removeEventListener('beforeunload', onUnload)
      el.removeEventListener('loadedmetadata', onLoaded)
      el.removeEventListener('play', onPlay)
      el.removeEventListener('pause', onPause)
      el.removeEventListener('ended', onEnded)
      el.removeEventListener('timeupdate', onTime)
      if (!el.ended) save(false)
    }
    // 只在换了素材或换了来源（转码完成）时重新绑定
  }, [identity, source, options?.restore])
}
