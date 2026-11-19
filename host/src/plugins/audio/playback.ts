import type { RefObject } from 'react'
import type { EntityView } from '../../shared/blocks'
import type { UiHost } from '../../plugin-api/ui/contracts'
import { usePlaybackRecord } from '../../plugin-api/ui/playback'

export function useAudioPlayback(ref: RefObject<HTMLMediaElement | null>, view: EntityView, host: UiHost, source: unknown) {
  usePlaybackRecord(ref, view.id, source, {
    position: Number(view.blocks.audioPlayback?.data.position ?? 0),
    save: sample => host.core.run('audio', 'recordPlayback', { id: view.id, hash: view.blocks.file?.data.hash, ...sample }),
    onError: () => host.notify('播放进度保存失败')
  })
}
