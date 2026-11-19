import { strict as assert } from 'node:assert'
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import type { BrowserWindow } from 'electron'
import { openLibraries } from '../../src/main/libraries'
import { callCore } from '../../src/main/core-client'
import { SpaceVersions } from '../../src/storage/space-versions'
import { FileSpace } from '../../src/storage/file-space'

export async function spaceVersionsFlow(win: BrowserWindow, dir: string) {
  const lib = openLibraries().find(row => row.win === win)
  assert(lib, '测试仓库未打开')
  const js = (text: string) => win.webContents.executeJavaScript(text)
  const until = async (check: () => Promise<unknown>, label: string) => {
    for (let i = 0; i < 200; i++) { if (await check()) return; await new Promise(r => setTimeout(r, 100)) }
    throw new Error(label)
  }
  const source = join(dir, '新版本文档.md'), png = join(dir, '版本验证.png')
  writeFileSync(source, '# 初版\n\nversion-one-needle')
  await sharp({ create: { width: 280, height: 180, channels: 3, background: '#67a39c' } }).png().toFile(png)
  const ids = await callCore(lib.core, 'ingest', [{ type: 'file', path: source }, { type: 'file', path: png }])
  await until(async () => { const rows = await callCore(lib.core, 'get', ids); return rows[0]?.blocks.body && rows[1]?.blocks.image }, '真实 utilityProcess 新文件加工失败')
  let versions = SpaceVersions.create(join(dir, '独立版本空间'), 'shared')
  try {
    const spaceId = versions.space.id, stage = await versions.stage({ spaceId, source, requestId: randomUUID() })
    const first = await versions.commit({ spaceId, draftId: stage.draft.id, previewToken: versions.preview(stage.draft.id).previewToken, requestId: randomUUID() })
    writeFileSync(source, '# 新版\n\nversion-two-needle')
    const target = { fileId: first.fileId, revision: first.revision }
    const a = await versions.stage({ spaceId, source, target, requestId: randomUUID() })
    const b = await versions.stage({ spaceId, source: png, target, requestId: randomUUID() })
    const request = { spaceId, draftId: a.draft.id, previewToken: versions.preview(a.draft.id).previewToken, requestId: randomUUID() }
    const latest = await versions.commit(request)
    assert.throws(() => versions.preview(b.draft.id), /VERSION_CONFLICT/)
    assert.equal(versions.getDraft(b.draft.id).state, 'ready')
    assert.match(readFileSync(versions.read(first.fileId, first.contentVersion), 'utf8'), /version-one-needle/)
    const versionPath = versions.read(first.fileId, latest.contentVersion)
    const [updated] = await callCore(lib.core, 'ingest', [{ type: 'file', path: versionPath }])
    await until(async () => String((await callCore(lib.core, 'get', [updated]))[0]?.blocks.body?.data.content ?? '').includes('version-two-needle'), '新版实际文件未通过 utilityProcess 加工')
    versions.space.close(); versions = new SpaceVersions(new FileSpace(join(dir, '独立版本空间')))
    assert.equal((await versions.commit(request)).replayed, true)
    assert.equal(versions.changes().length, 2)
    assert.equal(await callCore(lib.core, 'linkFileSpace', versions.space.root), spaceId)
    const spaces = await callCore(lib.core, 'listFileSpaces'), embedded = spaces.find(row => row.embedded)!
    const report = await js(`window.bridge.spaces.versionReadiness(${JSON.stringify(embedded.root)},${JSON.stringify(embedded.id)})`)
    assert.equal(report.readyForWarehouseWrites, false)
    assert.equal(report.storage, 'legacy')
    await js(`Array.from(document.querySelectorAll('.nav-item')).find(e=>e.textContent.trim()==='文件空间').click()`)
    await until(() => js(`!!document.querySelector('.space-tabs')`), '空间面板未打开')
    await js(`Array.from(document.querySelectorAll('.space-tabs button')).find(e=>e.textContent==='空间设置').click()`)
    await js(`Array.from(document.querySelectorAll('button')).find(e=>e.textContent==='检查版本迁移条件').click()`)
    await until(() => js(`!!document.querySelector('.space-version-readiness')`), '版本迁移检查未显示')
    writeFileSync(join(dir, 'space-version-readiness.png'), (await win.webContents.capturePage()).toPNG())
    win.setSize(860, 900)
    await new Promise(r => setTimeout(r, 150))
    assert(await js(`document.documentElement.scrollWidth <= window.innerWidth`), '窄窗口出现页面横向溢出')
    writeFileSync(join(dir, 'space-version-readiness-narrow.png'), (await win.webContents.capturePage()).toPNG())
    writeFileSync(join(dir, 'space-versions-result.json'), JSON.stringify({ ok: true, imported: ids, versionFile: first.fileId,
      versions: versions.versions(first.fileId), checks: ['新 PNG/Markdown 实际 utilityProcess 加工', '独立空间发布 V1/V2 并读取旧内容', '过期编辑保留草稿', '版本字节经真实导入加工', '重开空间回执重放', '旧仓库关联保护', '迁移检查 IPC 与 UI'] }, null, 2))
  } finally { versions.space.close() }
}
