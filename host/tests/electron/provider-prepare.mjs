import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { packPlugin } from '../../scripts/plugins/pack.ts'

const dir = resolve(process.argv[2])
const id = 'sample/file.measure@1'
const contracts = [{ id, source: 'file', input: {}, output: { bytes: 'number', engine: 'text' } }]
function project(plugin, entries, capabilities, files) {
  const root = join(dir, plugin)
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'plugin.json'), JSON.stringify({
    id: plugin, version: '1.0.0', apiVersion: 1, title: plugin, description: '', author: 'Huoye tests',
    entries, capabilities: { version: 1, contracts, ...capabilities }
  }))
  for (const [name, contents] of Object.entries(files)) writeFileSync(join(root, name), contents)
  return root
}
if (process.argv[3] === 'native') {
  const { prepareNativeProviders } = await import('./native-provider-fixture.mjs')
  await prepareNativeProviders(dir, project)
} else {
  await prepareLegacy()
}

async function prepareLegacy() {
  const consumer = project('measure-test', { blocks: './blocks.ts', core: './core.ts' }, { consumes: [id] }, {
    'blocks.ts': `import type { BlockKind } from '@resource-manager/plugin-api/blocks'
export const blocks: BlockKind[] = [{ id: 'measure-test.result', title: '结果', plugin: 'measure-test', version: 1,
  rebuildable: true, fields: { bytes: { type: 'number', title: '长度' }, engine: { type: 'text', title: '引擎' } } }]`,
    'core.ts': `import type { CorePlugin } from '@resource-manager/plugin-api/core/contracts'
import { blocks } from './blocks'
export const plugin: CorePlugin = { id: 'measure-test', version: 1, blocks, systems: [{
  id: 'measure-test.inspect', priority: 1, has: ['file'], inputs: ['file.hash'], outputs: ['measure-test.result'],
  requires: { capabilities: ['sample/file.measure@1'] },
  async run(ctx, id, b) {
    return { 'measure-test.result': await ctx.capabilities.run('sample/file.measure@1', { id, fileSeq: b.file.seq, params: {} }) }
  }
}] }`
  })
  await packPlugin(consumer, join(dir, 'consumer.hyplugin'))
  for (const plugin of ['engine-a', 'engine-b']) {
    const root = project(plugin, { provider: './provider.ts', ui: './ui.tsx' }, { provides: [id] }, {
      'provider.ts': `import type { CapabilityProvider } from '@huoye/provider-sdk'
import { stat } from 'node:fs/promises'
export const plugin: CapabilityProvider = { id: '${plugin}', handlers: {
  'sample/file.measure@1': async (_input, ctx) => ({ bytes: (await stat(ctx.sourcePath!)).size, engine: '${plugin}-v1' })
} }`,
      'ui.tsx': `import type { UiPlugin } from '@resource-manager/plugin-api/ui/contracts'
export const plugin: UiPlugin = { id: '${plugin}', settingsSections: [{ id: '${plugin}.settings', scope: 'library', order: 100, Component: () => <p>Engine controls</p> }] }`
    })
    if (plugin === 'engine-a') await packPlugin(root, join(dir, 'engine-a.hyplugin'))
  }
}
