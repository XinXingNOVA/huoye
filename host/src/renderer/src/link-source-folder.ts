import type { UiHost } from './plugin'

export async function linkSourceFolder(host: UiHost) {
  try {
    const space = await window.bridge.spaces.directories.pick()
    if (space) host.openTab('file-spaces', { spaceId: space.id, collect: true })
  } catch (e) { host.notify(e instanceof Error ? e.message : String(e)) }
}
