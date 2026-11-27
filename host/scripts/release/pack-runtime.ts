import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { link, lstat, mkdir, mkdtemp, open, readFile, readdir, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { encodeHeader, type RuntimeManifest } from '../../src/platform/runtime-package.ts'

async function pack(dir: string, out: string) {
  const meta = JSON.parse(await readFile(join(dir, 'runtime.json'), 'utf8'))
  const files: RuntimeManifest['files'] = []
  async function visit(path: string) {
    const stat = await lstat(join(dir, path))
    if (stat.isDirectory()) {
      for (const child of (await readdir(join(dir, path))).sort()) await visit(path + '/' + child)
    } else if (stat.isFile()) {
      const hash = createHash('sha256')
      for await (const chunk of createReadStream(join(dir, path))) hash.update(chunk)
      files.push({ path, size: stat.size, sha256: hash.digest('hex') })
    } else throw Error('运行包只能包含普通文件：' + path)
  }
  const dirs = await readdir(dir)
  for (const name of ['bin', 'lib', 'licenses']) if (dirs.includes(name)) await visit(name)
  const header = encodeHeader({ ...meta, files })
  await mkdir(dirname(out), { recursive: true })
  const stage = await mkdtemp(join(dirname(out), '.runtime-'))
  try {
    const temp = join(stage, 'package')
    const dest = await open(temp, 'wx', 0o600)
    try {
      await dest.writeFile(header)
      for (const f of files) {
        const contents = createReadStream(join(dir, f.path))
        const hash = createHash('sha256')
        for await (const chunk of contents) { hash.update(chunk); await dest.writeFile(chunk) }
        if (hash.digest('hex') !== f.sha256) throw Error('打包期间文件已变化：' + f.path)
      }
    } finally { await dest.close() }
    await link(temp, out)
  } finally { await rm(stage, { recursive: true, force: true }) }
}
const [dir, output] = process.argv.slice(2)
if (!dir || !output) throw Error('Usage: npm run runtime:pack -- <directory> <output.hyruntime>')
void pack(resolve(dir), resolve(output)).catch(error => { console.error(error.message); process.exitCode = 1 })
