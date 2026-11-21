// 在全新的临时库写入一个提供附件字段的插件样本。正式窗口打开时该插件已停用。
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Host } from '../../src/core/host'
import { textPlugin } from '../../src/plugins/text/core'
import { DirectorySpaces } from '../../src/storage/directory-spaces'
import { directoryReference } from '../../src/storage/directory-reference'

async function prepare() {
  const dir = resolve(process.argv[2]), root = join(dir, 'sample.library'), source = join(dir, '项目资料')
  if (existsSync(root)) throw Error('请使用全新的临时目录')
  mkdirSync(source)
  writeFileSync(join(source, '项目原文.md'), '独立原件')
  const host = new Host(root, [textPlugin, { id: 'sample-attachment', version: 1, blocks: [{
    id: 'sample-attachment', plugin: 'sample-attachment', title: '附件', version: 1, rebuildable: false,
    fields: { files: { title: '附带原文', type: 'text', list: true, file: true } }
  }] }], () => {})
  try {
    const directories = new DirectorySpaces(join(dir, 'user-data', 'file-spaces'))
    const space = directories.attach(host.lib, source)
    const [entry] = (await directories.page(host.lib, space.id, null, 0, true)).items
    const verified = await directories.verify(host.lib, space.id, entry.id, entry.stamp)
    const ref = directoryReference(space.id, entry.id, verified.hash, entry.name)
    const note = await host.api.create({ text: { content: '项目复盘笔记' }, 'sample-attachment': { files: [ref] } })
    await host.scheduler.idle()
    writeFileSync(join(dir, 'fixture.json'), JSON.stringify({ space, note, ref }))
  } finally { host.close() }
}
void prepare().catch(error => { console.error(error); process.exitCode = 1 })
