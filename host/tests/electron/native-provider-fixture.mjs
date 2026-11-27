import { execFileSync } from 'node:child_process'
import { findProgram, programDirectories } from '../../src/platform/programs.ts'
import { runtimePath } from '../../src/shared/provider-runtimes.ts'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { zipSync } from 'fflate'
import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import sharp from 'sharp'
import { packPlugin } from '../../scripts/plugins/pack.ts'

export async function prepareNativeProviders(dir, project) {
  const pages = 'sample/comic.pages@1', page = 'sample/comic.page@1'
  const contracts = [
    { id: pages, source: 'file', input: {}, output: { pages: { type: 'records', fields: { name: 'text', index: 'number' } } } },
    { id: page, source: 'file', input: { name: 'text' }, output: {}, artifact: 'png' }
  ]
  const caps = { version: 2, contracts }
  const consumer = project('comic-test', { blocks: './blocks.ts', core: './core.ts' }, { ...caps, consumes: [pages, page] }, {
    'blocks.ts': `import type { BlockKind } from '@resource-manager/plugin-api/blocks'
export const blocks: BlockKind[] = [{ id: 'comic-test.page', title: '漫画测试', plugin: 'comic-test', version: 1, rebuildable: true,
      fields: { pages: { type: 'json', title: '目录' }, path: { type: 'text', title: '缓存', file: true }, source: { type: 'number', title: '版本' } } }]`,
    'core.ts': `import type { CorePlugin } from '@resource-manager/plugin-api/core/contracts'
import { blocks } from './blocks'
export const plugin: CorePlugin = { id: 'comic-test', version: 1, blocks, systems: [{
  id: 'comic-test.extract', priority: 1, has: ['file'], inputs: ['file.hash'], outputs: ['comic-test.page'],
  requires: { capabilities: ['${pages}', '${page}'] }, async run(ctx, id, b) {
    const source = { id, fileSeq: b.file.seq }
    const list = await ctx.capabilities.run('${pages}', { ...source, params: {} })
    const pages = list.pages as { index: number; name: string }[]
    if (pages[0]?.name === 'empty.png') return { 'comic-test.page': null }
    const image = await ctx.capabilities.run('${page}', { ...source, params: { name: pages[pages.length - 1].name } })
    return { 'comic-test.page': { pages, ...image } }
  }
}] }`
  })
  const target = process.platform + '-' + process.arch
  const program = 'huoye-test-unpack'
  if (findProgram(program, programDirectories())) throw Error('测试要求系统中没有同名解包程序')
  const engine = project('comic-native', { provider: './provider.ts' }, {
    ...caps, provides: [pages, page], runtimes: [{ program, targets: [target] }], implementations: [
      { id: pages, execution: 'local', programs: [program] }, { id: page, execution: 'local', programs: [program] }
    ]
  }, {
    'provider.ts': `import type { CapabilityProvider } from '@huoye/provider-sdk'
export const plugin: CapabilityProvider = { id: 'comic-native', handlers: {
      '${pages}': async (input, ctx) => {
        if (Object.keys(input).length) throw Error('unexpected list parameters')
        const bytes = await ctx.run('${program}', ['list', ctx.sourcePath!])
        const names = new TextDecoder().decode(bytes).trim().split(/\\r?\\n/)
        return { pages: names.map((name, index) => ({ name, index })) }
      },
      '${page}': async (input, ctx) => {
        if (Object.keys(input).join() !== 'name') throw Error('unexpected page parameters')
        if (input.name === 'hold.png') {
          await ctx.run('${program}', ['wait', ${JSON.stringify(join(dir, 'native.pid'))}])
        }
        if (!/^\\d{3}\\.png$/.test(String(input.name))) throw Error('[COMIC_INVALID_PAGE] not a numbered page')
        return ctx.run('${program}', ['page', ctx.sourcePath!, String(input.name)])
      }
    } }`
  })
  const binary = join(engine, runtimePath(program, target))
  mkdirSync(dirname(binary), { recursive: true })
  const source = fileURLToPath(new URL('./fixtures/comic-engine.c', import.meta.url))
  const headers = [process.env.HUOYE_TEST_ARCHIVE_INCLUDE, '/opt/homebrew/opt/libarchive/include', '/usr/local/opt/libarchive/include']
    .find(dir => dir && existsSync(join(dir, 'archive.h')))
  execFileSync(process.env.CC || 'cc', [source, ...(headers ? ['-I', headers] : []), '-larchive', '-o', binary], { stdio: 'inherit' })
  await packPlugin(consumer, join(dir, 'comic-test.hyplugin'))
  await packPlugin(engine, join(dir, 'comic-native.hyplugin'))
  await sharp({ create: { width: 32, height: 32, channels: 3, background: '#fde8bc' } }).png().toFile(join(dir, '001.png'))
  const width = 1440, height = 1080
  await sharp(randomBytes(width * height * 3), { raw: { width, height, channels: 3 } }).png().toFile(join(dir, '002.png'))
  for (const name of ['hold', 'invalid', 'empty']) copyFileSync(join(dir, '001.png'), join(dir, name + '.png'))
  for (const [archive, entries] of [['sample', ['001.png', '002.png']], ['cancel', ['hold.png']], ['broken', ['invalid.png']], ['resume', ['001.png']], ['empty', ['empty.png']]]) {
    const files = Object.fromEntries(entries.map(name => [name, readFileSync(join(dir, name))]))
    writeFileSync(join(dir, archive + '.cbz'), zipSync(files))
  }
}
