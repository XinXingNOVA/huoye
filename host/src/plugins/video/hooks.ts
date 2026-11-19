// 预览浮层与播放器标签页共用：播放记录、按需转码。

import { useEffect, useState } from 'react'
import type { EntityView } from '../../shared/blocks'
import type { UiHost } from '../../plugin-api/ui/contracts'


/** 不能直接播放、还没有代理时，请求按需转码，报告进度与失败原因。 */
export function useProxy(host: UiHost, view: EntityView, needed: boolean): { progress?: number; error?: string } {
  const [progress, setProgress] = useState<number>()
  const [error, setError] = useState<string>()
  useEffect(() => {
    if (!needed) return
    const off = host.core.on('job', (j) => {
      if (j.id === view.id && j.system === 'video.proxy') setProgress(j.progress)
    })
    host.core.demand(view.id, 'proxy').then((ok) => !ok && setError('没有可用的转码插件'))
    return off
  }, [host, view.id, needed])
  const failure = view.failures['video.proxy']
  return { progress, error: error ?? failure }
}

/** 视频当前可以播放的文件：能直接播的用原文件，否则用转码出来的代理。 */
export function playableSource(view: EntityView) {
  return view.blocks.video?.data.playable ? view.blocks.file : view.blocks.proxy
}
