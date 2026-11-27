import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, open, type FileHandle } from 'node:fs/promises'
import { dirname, join, posix } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { z } from 'zod'
import { runtimeTargets } from '../shared/provider-runtimes.ts'

const magic = Buffer.from('HUOYE-RUNTIME/1\n')
const headerSize = magic.length + 4
const maxHeader = 256 * 1024
const maxBytes = 1024 ** 3
const name = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/).refine(s => !Object.hasOwn(Object.prototype, s))
const path = z.string().max(240).refine(s => {
  const parts = s.split('/')
  return parts.length >= 2 && ['bin', 'lib', 'licenses'].includes(parts[0]) && parts.every(p =>
    /^[a-zA-Z0-9_-][a-zA-Z0-9._+-]*$/.test(p) && !p.endsWith('.') && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))
})
const schema = z.strictObject({
  id: name, version: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9.+_-]{0,47}$/), target: z.enum(runtimeTargets),
  programs: z.array(z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/).refine(s => !Object.hasOwn(Object.prototype, s))).min(1).max(32),
  files: z.array(z.strictObject({ path, size: z.number().int().min(1).max(maxBytes), sha256: z.string().regex(/^[0-9a-f]{64}$/) })).min(1).max(512)
})
export type RuntimeManifest = z.infer<typeof schema>
export function executable(name: string, target: string) { return 'bin/' + name + (target.startsWith('win32-') ? '.exe' : '') }
export function checkManifest(input: unknown) {
  const m = schema.parse(input)
  const files = new Set(m.files.map(f => f.path.toLowerCase()))
  const dirs = new Map<string, string>()
  for (const file of m.files) {
    for (let prefix = posix.dirname(file.path); prefix !== '.'; prefix = posix.dirname(prefix)) {
      const lower = prefix.toLowerCase()
      if (files.has(lower) || (dirs.has(lower) && dirs.get(lower) !== prefix)) throw Error('运行包路径冲突')
      dirs.set(lower, prefix)
    }
  }
  const bytes = m.files.reduce((n, f) => n + f.size, 0)
  if (bytes > maxBytes || files.size !== m.files.length || new Set(m.programs).size !== m.programs.length ||
      m.programs.some(p => !m.files.some(f => f.path === executable(p, m.target)))) throw Error('运行包文件清单不完整或超过限制')
  return m
}
export function misplacedDll(target: string, path: string) {
  return target.startsWith('win32-') && /\.dll$/i.test(path) && posix.dirname(path) !== 'bin'
}
function checkLayout(m: RuntimeManifest) {
  const bad = m.files.find(f => misplacedDll(m.target, f.path))
  if (bad) throw Error('Windows 运行包的 DLL 须与可执行程序同放在 bin/：' + bad.path)
  return m
}
export function encodeHeader(manifest: RuntimeManifest) {
  const data = Buffer.from(JSON.stringify(checkLayout(checkManifest(manifest))))
  if (data.length > maxHeader) throw Error('运行包清单太大')
  const header = Buffer.alloc(headerSize)
  magic.copy(header)
  header.writeUInt32BE(data.length, magic.length)
  return Buffer.concat([header, data])
}
async function readAt(file: FileHandle, length: number, offset: number) {
  const out = Buffer.alloc(length)
  for (let n = 0; n < length;) {
    const read = await file.read(out, n, length - n, offset + n)
    if (!read.bytesRead) throw Error('运行包不完整')
    n += read.bytesRead
  }
  return out
}
async function inspect(file: FileHandle) {
  const stat = await file.stat()
  if (!stat.isFile()) throw Error('请选择运行包文件')
  const header = await readAt(file, headerSize, 0)
  const length = header.readUInt32BE(magic.length)
  if (!header.subarray(0, magic.length).equals(magic) || length > maxHeader) throw Error('运行包格式无效')
  const data = await readAt(file, length, headerSize)
  const manifest = checkLayout(checkManifest(JSON.parse(data.toString('utf8'))))
  const offset = headerSize + length
  if (manifest.target !== process.platform + '-' + process.arch) throw Error('运行包与当前系统或架构不符')
  const bytes = manifest.files.reduce((n, f) => n + f.size, 0)
  if (offset + bytes !== stat.size) throw Error('运行包长度不符')
  return { manifest, metadata: data, digest: createHash('sha256').update(data).digest('hex'), offset, bytes }
}
export async function inspectRuntime(path: string) {
  const file = await open(path, 'r')
  try { return await inspect(file) } finally { await file.close() }
}
export async function extractRuntime(path: string, digest: string, directory: string) {
  const file = await open(path, 'r')
  try {
    const item = await inspect(file)
    if (item.digest !== digest) throw Error('运行包已变化，请重新选择')
    let start = item.offset
    for (const f of item.manifest.files) {
      const dest = join(directory, f.path)
      await mkdir(dirname(dest), { recursive: true })
      const hash = createHash('sha256')
      const end = start + f.size - 1
      const reader = createReadStream(path, { fd: file.fd, autoClose: false, start, end })
      const hashing = new Transform({ transform(chunk, _, next) { hash.update(chunk); next(null, chunk) } })
      await pipeline(reader, hashing, createWriteStream(dest, { flags: 'wx', mode: item.manifest.programs.some(p => executable(p, item.manifest.target) === f.path) ? 0o700 : 0o600 }))
      if (hash.digest('hex') !== f.sha256) throw Error('运行包文件摘要不符：' + f.path)
      start = end + 1
    }
    return item
  } finally { await file.close() }
}
