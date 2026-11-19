import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Host, type HostOptions } from '../../src/core/host'
import type { CorePlugin } from '../../src/core/plugin'
import { legacyCorePlugins, legacyManifest } from './legacy-plugins'
import { randomUUID } from 'node:crypto'

export function tempDir(prefix = 'rm-'): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

export function openHost(plugins: CorePlugin[] = legacyCorePlugins, opts?: HostOptions, root = tempDir('rm-lib-')) {
  const events: { event: string; payload: unknown }[] = []
  const host = new Host(root, plugins, (event, payload) => events.push({ event, payload }), { manifest: legacyManifest, ...opts })
  return {
    host,
    root,
    events,
    cleanup: () => {
      host.close()
      rmSync(root, { recursive: true, force: true })
    }
  }
}

/** 准备媒体测试的新版文件内容；不再借用旧 file.replace 命令。 */
export async function saveTextFile(host: Host, id: string, text: string) {
  const preview = await host.api.prepareFileEdit({ id, destination: { mode: 'publish' }, content: { type: 'text', text }, requestId: randomUUID() })
  const result = await host.api.commitFileEdit({ editId: preview.editId, previewToken: preview.previewToken, requestId: randomUUID() })
  if (result.library.state !== 'accepted') throw new Error(result.library.error)
  return result
}
