import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Host } from '../../src/core/host'
import { filePlugin } from '../../src/plugins/file/core'
import { textPlugin } from '../../src/plugins/text/core'
import type { CorePlugin } from '../../src/plugin-api/core/contracts'
import { SpaceVersions, setVersionPermission } from '../../src/storage/space-versions'

// 只验证版本用例保留业务块；不借用整套旧业务插件或验证笔记插件实现。
const metadata: CorePlugin = { id: 'version-test', version: 1, blocks: [{ id: 'note', plugin: 'version-test', title: '测试业务内容',
  version: 1, rebuildable: false, fields: { text: { type: 'text', title: '内容' } } }] }
const plugins = [filePlugin, textPlugin, metadata]

export function versionHost(cleanups: (() => void)[], root?: string, selected: CorePlugin[] = plugins) {
  const directory = root ?? mkdtempSync(join(tmpdir(), 'rm-version-library-'))
  const host = new Host(directory, selected, () => {}, { manifest: [] })
  cleanups.push(() => { host.close(); if (!root) rmSync(directory, { recursive: true, force: true }) })
  return host
}
export async function sharedVersionFile(cleanups: (() => void)[], initial = '# version-one', name = 'document.md') {
  const dir = mkdtempSync(join(tmpdir(), 'rm-version-files-')); cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const versions = SpaceVersions.create(join(dir, 'shared'), 'shared'); cleanups.push(() => versions.space.close())
  const a = versionHost(cleanups), b = versionHost(cleanups), spaceId = versions.space.id, source = join(dir, name)
  writeFileSync(source, initial)
  a.api.linkFileSpace(versions.space.root); b.api.linkFileSpace(versions.space.root)
  setVersionPermission(versions.space, a.lib.id, 'revise', true, versions.space.info().revision)
  const saved = await a.api.importToLibrary([{ type: 'file', path: source }], { spaceId, requestId: randomUUID() })
  const ai = saved.items[0].id, file = (await a.api.listSpaceFiles({ spaceId })).items[0]
  const adopted = await b.api.adoptSpaceFiles({ spaceId, files: [{ id: file.id, revision: file.revision }], requestId: randomUUID() })
  const bi = (adopted.result as { items: { id: string }[] }).items[0].id
  await Promise.all([a.scheduler.idle(), b.scheduler.idle()])
  return { a, b, ai, bi, source, versions, spaceId, fileId: file.id, dir }
}
export async function prepareVersionEdit(host: Host, id: string, source: string) {
  const p = await host.api.prepareFileEdit({ id, content: { type: 'file', path: source }, destination: { mode: 'publish' }, requestId: randomUUID() })
  return { editId: p.editId, previewToken: p.previewToken, requestId: randomUUID() }
}
