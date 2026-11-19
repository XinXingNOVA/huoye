import { openLibraries } from './libraries'
import { callCore } from './core-client'

export const refreshSpaceWindows = async (spaceId: string, fileIds?: string[]) => {
  await Promise.all(openLibraries().map(async lib => {
    try {
      if ((await callCore(lib.core, 'listFileSpaces')).some(s => s.id === spaceId && s.state === 'active')) await callCore(lib.core, 'refreshFileSpace', spaceId, fileIds)
    } catch (error) { console.warn('[file-space] 窗口刷新未完成', error) }
  }))
}
