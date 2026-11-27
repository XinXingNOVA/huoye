import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const [source, dir] = process.argv.slice(2)
if (!source || !dir) throw Error('Usage: node tests/electron/prepare-media-editions.mjs <runnable FFmpeg runtime source> <new capture directory>')
await mkdir(dir)
const bundled = join(dir, 'bundled')
await cp(source, bundled, { recursive: true })
const meta = JSON.parse(await readFile(join(bundled, 'runtime.json'), 'utf8'))
const pack = fileURLToPath(new URL('../../scripts/release/pack-runtime.ts', import.meta.url))
for (const version of ['a','b']) {
  await writeFile(join(bundled, 'runtime.json'), JSON.stringify({ ...meta, version: 'test-' + version }))
  execFileSync(process.execPath, [pack, resolve(bundled), join(dir, 'packages', version + '.hyruntime')], { stdio: 'inherit' })
}
