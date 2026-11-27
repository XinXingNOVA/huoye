// 仅开发构建使用；缓存通过内容指纹及包摘要校验，发布命令始终执行完整打包。
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { version as esbuildVersion } from 'esbuild'
import ts from 'typescript'
import { decodePackage } from '../../src/plugin-packages/archive.ts'
import { packPlugin } from './pack.ts'

const host = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const digest = (data: string | Buffer) => createHash('sha256').update(data).digest('hex')
const fileDigest = (path: string) => digest(readFileSync(path))
const inputDigest = (path: string) => existsSync(path) ? digest(JSON.stringify([realpathSync(path), fileDigest(path)])) : 'missing'

function dependencyReceipt(inputs: string[]): Receipt['inputs'] {
  const paths = new Set(inputs)
  // 包入口、类型入口或 exports 可以仅修改 package.json；也记录之前不存在的边界。
  for (const input of inputs) {
    for (let dir = dirname(input); ; dir = dirname(dir)) {
      paths.add(join(dir, 'package.json'))
      if (dirname(dir) === dir) break
    }
  }
  return [...paths].sort().map(path => ({ path, hash: inputDigest(path) }))
}

/** 包括新增、删除和同长度修改；不靠 mtime 判断。链接本身变化也会让缓存失效。 */
function treeDigest(root: string): string {
  const hash = createHash('sha256')
  const visit = (path: string, name: string) => {
    hash.update(JSON.stringify(name))
    if (!existsSync(path)) { hash.update('missing'); return }
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) { hash.update(`link:${readlinkSync(path)}`); return }
    if (stat.isDirectory()) {
      hash.update('directory')
      for (const child of readdirSync(path).sort()) {
        // 仅忽略源码根部的依赖和 Git；assets 内同名目录也是包的真实内容。
        if (!name && ['node_modules', '.git'].includes(child)) continue
        visit(join(path, child), `${name}/${child}`)
      }
    } else if (stat.isFile()) hash.update(fileDigest(path))
  }
  visit(root, '')
  return hash.digest('hex')
}

/** 公共契约、打包规则、依赖锁和工具环境变化时，所有附带包重新检查。 */
function commonFingerprint(): string {
  const paths = ['src/plugin-api', 'packages/provider-sdk', 'src/shared', 'src/plugin-packages/archive.ts', 'scripts', 'package.json', 'package-lock.json', 'node_modules/.package-lock.json']
  return digest(JSON.stringify({ version: 1, host, cwd: process.cwd(), node: process.version, platform: process.platform, arch: process.arch,
    typescript: ts.version, esbuild: esbuildVersion, nodeEnv: process.env.NODE_ENV, nodePath: process.env.NODE_PATH,
    files: paths.map(path => [path, treeDigest(join(host, path))]) }))
}

interface Receipt { version: 1; fingerprint: string; hash: string; inputs: { path: string; hash: string }[] }
function atomicWrite(path: string, bytes: string | Buffer) {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  try { writeFileSync(temporary, bytes); renameSync(temporary, path) }
  finally { rmSync(temporary, { force: true }) }
}

export class PluginBuildCache {
  private readonly common = commonFingerprint()
  private readonly directory: string
  constructor(directory: string) { this.directory = directory }

  async pack(source: string, output: string): Promise<'cached' | 'built'> {
    const root = realpathSync(source)
    const sourceFingerprint = treeDigest(root)
    const fingerprint = digest(JSON.stringify([root, sourceFingerprint, this.common]))
    const key = `${basename(root)}-${digest(root).slice(0, 12)}`
    const receiptPath = join(this.directory, `${key}.json`), packagePath = join(this.directory, `${key}.rmplugin`)
    try {
      const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as Receipt
      if (receipt.version === 1 && receipt.fingerprint === fingerprint && Array.isArray(receipt.inputs) && receipt.inputs.length &&
        receipt.inputs.every(input => typeof input.path === 'string' && inputDigest(input.path) === input.hash)) {
        const bytes = readFileSync(packagePath), pack = decodePackage(bytes)
        if (pack.hash === receipt.hash) {
          mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, bytes)
          return 'cached'
        }
      }
    } catch { /* 缺失、损坏或依赖消失均按缓存未命中处理；绝不退回旧包。 */ }

    let inputs: string[] = []
    await packPlugin(root, output, files => { inputs = files })
    // 打包时恰有源码编辑，交给下一轮重新检查，不为不一致的快照建立缓存。
    if (treeDigest(root) === sourceFingerprint) {
      try {
        const bytes = readFileSync(output), pack = decodePackage(bytes)
        const receipt: Receipt = { version: 1, fingerprint, hash: pack.hash, inputs: dependencyReceipt(inputs) }
        atomicWrite(packagePath, bytes)
        atomicWrite(receiptPath, JSON.stringify(receipt))
      } catch (error) { console.warn('插件包已构建，但未保存开发缓存：', error instanceof Error ? error.message : String(error)) }
    }
    return 'built'
  }
}
