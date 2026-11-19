import { afterEach, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { openHost } from '../helpers/helpers'
import { filePlugin } from '../../src/plugins/file/core'
import { coreFeaturesSchema } from '../../src/shared/external-plugins'
import type { CorePlugin } from '../../src/core/plugin'

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).reverse().forEach(fn => fn()))
async function sample(plugins?: CorePlugin[]) {
  const h = openHost(plugins); cleanups.push(h.cleanup)
  const [id] = await h.host.api.ingest([{ type: 'bytes', name: 'source.md', bytes: new TextEncoder().encode('# original') }])
  await h.host.scheduler.idle()
  return { ...h, id, before: h.host.store.blocksOf(id).file.data }
}

it('不再提供同步文件命令和上下文；失败回滚业务记录', async () => {
  let keys: string[] = []
  const probe: CorePlugin = { id: 'probe', version: 1, commands: { check(ctx) {
    keys = Object.keys(ctx)
    const id = ctx.createEntity()
    ctx.put(id, 'note', { text: 'must roll back' })
    ;(ctx as any).writeFile('files/unsafe.md', 'bad')
    return { label: '旧插件调用' }
  } }, blocks: [{ id: 'note', plugin: 'probe', title: '笔记', version: 1, rebuildable: false, fields: { text: { type: 'text', title: '内容' } } }] }
  const h = await sample([filePlugin, probe]), before = (await h.host.api.query({})).ids
  expect(() => h.host.api.run('file', 'replace', { id: h.id, content: 'bad' })).toThrow('没有命令')
  expect(() => h.host.api.preview('file', 'replace', { id: h.id, content: 'bad' })).toThrow('没有命令')
  expect(() => h.host.api.run('probe', 'check', {})).toThrow()
  for (const key of ['writeFile', 'renameFile', 'ensureLocalFile', 'isSharedFile']) expect(keys).not.toContain(key)
  expect((await h.host.api.query({})).ids).toEqual(before)
  expect(readFileSync(h.host.lib.files.readable(String(h.before.path)), 'utf8')).toBe('# original')
  expect(existsSync(join(h.root, 'cache/undo'))).toBe(false)
})

it('旧能力声明被拒绝，当前异步文件编辑能力不受影响', () => {
  expect(coreFeaturesSchema.safeParse(['file-copy-on-write-v1']).success).toBe(false)
  expect(coreFeaturesSchema.safeParse(['ingest-metadata-v1']).success).toBe(true)
})
