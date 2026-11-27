import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..'), out = join(root, 'artifacts/releases', process.argv.includes('--lite') ? 'lite' : '')
await mkdir(out, { recursive: true })
// Optional plugins are shipped through the selected bundle catalog.
await copyFile(join(root, 'docs/user/Windows试用说明.md'), join(out, 'Windows试用说明.md'))
const sums = []
for (const file of (await readdir(out)).filter(f => /\.(exe|zip|hyplugin|rmplugin|hyruntime)$/.test(f)).sort()) {
  const hash = createHash('sha256'); for await (const chunk of createReadStream(join(out, file))) hash.update(chunk)
  sums.push(`${hash.digest('hex')}  ${file}`)
}
await writeFile(join(out, 'SHA256SUMS.txt'), sums.join('\n') + '\n')
console.log(`分享文件已整理到 ${out}；版本 ${JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version}`)
