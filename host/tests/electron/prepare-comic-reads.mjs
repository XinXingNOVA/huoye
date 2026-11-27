import { mkdirSync, copyFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import { zipSync } from 'fflate'

const [dir, pack] = process.argv.slice(2)
if (!dir || !pack) throw Error('用法：prepare-comic-reads.mjs <临时目录> <comic.hyplugin>')
mkdirSync(dir, { recursive: true })
copyFileSync(pack, join(dir, 'comic.hyplugin'))
const pages = {}
for (const [index, [name, format]] of [['01.png', 'png'], ['02.jpg', 'jpeg'], ['03.webp', 'webp']].entries()) {
  const bytes = await sharp({ create: { width: 680 + index * 10, height: 900, channels: 3,
    background: ['#398888', '#774499', '#778899'][index] } })[format]().toBuffer()
  pages[name] = bytes
  writeFileSync(join(dir, name), bytes)
}
writeFileSync(join(dir, 'mixed.cbz'), zipSync(pages))
