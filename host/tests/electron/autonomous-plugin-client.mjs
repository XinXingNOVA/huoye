// 独立进程只持有客户端配置。工程位置由公开 MCP 返回，源码由编码客户端写入。
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const [dir, phase] = process.argv.slice(2), file = join(dir, 'project-result.json')
const params = JSON.parse(readFileSync(join(dir, 'client-config.json'), 'utf8')).mcpServers['huoye']
const client = new Client({ name: 'independent-plugin-developer', version: '1' })
const transport = new StdioClientTransport({ ...params, stderr: 'pipe' })
const call = async (name, args = {}) => {
  const result = await client.callTool({ name, arguments: args })
  assert(!result.isError, name + ' ' + JSON.stringify(result.content))
  return result.structuredContent
}
const until = async (check, label) => {
  const end = Date.now() + 60000
  while (Date.now() < end) {
    const value = await check()
    if (value) return value
    await new Promise(r => setTimeout(r, 150))
  }
  throw new Error('等待超时：' + label)
}
try {
  await client.connect(transport)
  const projectInput = { pluginId: 'visual-caption', title: '素材题签', requestId: 'create-visual-caption' }
  const { libraryId } = await call('create_library', { name: '从零开发库', requestId: 'autonomous-vault' })
  await call('open_library', { libraryId })
  await until(async () => (await call('get_library_status', { libraryId, sections: ['workbench'] })).workbench?.state === 'ready', '工作台')
  assert.equal((await call('list_ecosystem_catalog', { libraryId })).target.permissions.autonomousDevelopment, true)
  const status = () => call('get_development_status', { libraryId })
  if (phase === 'first') assert.deepEqual((await status()).sources, [])
  const project = await call('create_development_project', { libraryId, ...projectInput })
  const read = async id => (await call('read_content', { libraryId, id, kind: 'visual-caption', field: 'text' })).text
  if (phase === 'resume') {
    const old = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(project.sourceId, old.sourceId)
    const resumed = await status()
    assert.equal(resumed.sources.find(s => s.sourceId === old.sourceId).appliedHash, old.v2)
    assert(resumed.runtime.plugins.some(p => p.id === 'poster-layout' && p.enabled))
    assert((await read(old.item)).includes('第2版：海报'))
  } else {
    for (const [input, code] of [
      [{ ...projectInput, pluginId: 'other-caption' }, 'REQUEST_CONFLICT'],
      [{ ...projectInput, requestId: 'duplicate-plugin-id' }, 'PLUGIN_ID_CONFLICT'],
      [{ ...projectInput, pluginId: 'text', requestId: 'built-in-collision' }, 'PLUGIN_ID_CONFLICT']
    ]) {
      const result = await client.callTool({ name: 'create_development_project', arguments: { libraryId, ...input } })
      assert(result.isError && JSON.stringify(result.content).includes(code), JSON.stringify(result))
    }
    const manifest = JSON.parse(readFileSync(join(project.source, 'plugin.json'), 'utf8'))
    manifest.entries.blocks = './blocks.ts'
    writeFileSync(join(project.source, 'plugin.json'), JSON.stringify(manifest))
    writeFileSync(join(project.source, 'blocks.ts'), `import type { BlockKind } from '@resource-manager/plugin-api/blocks'
export const blocks: BlockKind[] = [{ id: 'visual-caption', plugin: 'visual-caption', title: '素材题签', version: 1,
  content: true, rebuildable: false, fields: { text: { type: 'longtext', title: '题签', search: true } } }]
`)
    const fresh = join(dir, '新海报说明.txt')
    writeFileSync(fresh, '海报参考资料')
    const imported = await call('import_to_library', { libraryId, files: [{ path: fresh }], requestId: 'autonomous-import' })
    assert.deepEqual(imported.errors, [])
    const item = imported.items[0].id
    const versions = []
    for (const version of [1, 2]) {
      const source = `import type { CorePlugin } from '@resource-manager/plugin-api/core/contracts'
import { parseInput } from '@resource-manager/plugin-api/operations'
import { z } from 'zod'
import { blocks } from './blocks'
const input = z.object({ id: z.string(), title: z.string() }).strict()
export const plugin: CorePlugin = { id: 'visual-caption', version: ${version}, blocks,
  commands: { caption(ctx, args) {
    const { id, title } = parseInput(input, args)
    ctx.put(id, 'visual-caption', { text: '第${version}版：' + title })
    return { label: '填写题签', result: { id } }
  } },
  operations: [{ name: 'write_visual_caption', title: '填写题签', description: '给素材填写题签', command: 'caption', effect: 'data', input }]
}
`
      writeFileSync(join(project.source, 'core.ts'), source)
      assert.equal((await call('create_development_project', { libraryId, ...projectInput })).source, project.source)
      assert.equal(readFileSync(join(project.source, 'core.ts'), 'utf8'), source, '重试建工程保留编辑')
      await call('prepare_development_build', { libraryId, sourceIds: [project.sourceId] })
      const snapshot = await until(async () => {
        const s = await status(), row = s.sources.find(r => r.sourceId === project.sourceId)
        assert(!row.problem && row.build?.state !== 'error', JSON.stringify(row))
        return row.build?.state === 'ready' && row.availableHash !== versions.at(-1) && s
      }, '第' + version + '版构建')
      const hash = snapshot.sources[0].availableHash, requestId = 'apply-caption-' + version
      await call('apply_development_build', { libraryId, requestId, session: snapshot.session, revision: snapshot.revision, selection: [{ sourceId: project.sourceId, hash }] })
      await until(async () => {
        const s = await call('get_development_status', { libraryId, requestId })
        if (s.request.running) return false
        assert.equal(s.request.state, 'completed', JSON.stringify(s.request))
        return s.sources[0].appliedHash === hash && s.runtime.workbench?.state === 'ready'
      }, '第' + version + '版加载')
      assert((await call('describe_library', { libraryId })).operations.some(op => op.name === 'write_visual_caption'))
      await call('execute_operation', { libraryId, operation: 'write_visual_caption', requestId: 'caption-v' + version, args: { id: item, title: '海报' } })
      assert((await read(item)).includes('第' + version + '版：海报'))
      versions.push(hash)
    }
    const second = await call('create_development_project', { libraryId, pluginId: 'poster-layout', title: '海报版式', requestId: 'second-plugin-project' })
    assert.notEqual(project.sourceId, second.sourceId)
    await call('prepare_development_build', { libraryId, sourceIds: [project.sourceId, second.sourceId] })
    const together = await until(async () => {
      const s = await status()
      assert(!s.sources.some(row => row.problem || row.build?.state === 'error'), JSON.stringify(s.sources))
      return s.sources.length === 2 && s.sources.every(row => row.build?.state === 'ready' && row.availableHash) && s
    }, '同一授权下第二个独立工程')
    const requestId = 'apply-both-projects'
    await call('apply_development_build', { libraryId, session: together.session, revision: together.revision, requestId,
      selection: together.sources.map(row => ({ sourceId: row.sourceId, hash: row.availableHash })) })
    await until(async () => {
      const s = await call('get_development_status', { libraryId, requestId })
      if (s.request.running) return false
      assert.equal(s.request.state, 'completed', JSON.stringify(s.request))
      return s.runtime.plugins?.some(p => p.id === 'poster-layout' && p.enabled)
    }, '同时加载两个插件')
    assert((await read(item)).includes('第2版：海报'))
    writeFileSync(file, JSON.stringify({ libraryId, item, sourceId: project.sourceId, v1: versions[0], v2: versions[1], secondProject: second.sourceId }))
  }
} finally { await client.close(); await transport.close() }
