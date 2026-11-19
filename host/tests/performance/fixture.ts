// 合成容量夹具，不计入操作耗时。真实 v4 目录/文件/引用；通过真实加工器生成缓存。
// 禁止传入已有仓库：只接受 runner 创建的全新临时目录。
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import { Host } from '../../src/core/host'
import { openLibrary } from '../../src/core/library'
import { loadExternalCore, setBinding } from '../../src/core/external-plugins'
import { corePlugins } from '../../src/plugins/core'
import { PLUGINS } from '../../src/plugins/manifest'
import { DISTRIBUTION } from '../../src/plugins/generated/distribution'
import { PackageManager } from '../../src/plugin-packages/manager'
import { FileSpace } from '../../src/storage/file-space'
import { spaceReference } from '../../src/storage/space-reference'

function pngLabel(png: Buffer, label: string) {
  const text = Buffer.from('benchmark\0' + label), chunk = Buffer.concat([Buffer.from('tEXt'), text])
  let crc = 0xffffffff
  for (const byte of chunk) { crc ^= byte; for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1 }
  const length = Buffer.alloc(4), end = Buffer.alloc(4); length.writeUInt32BE(text.length); end.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
  return Buffer.concat([png.subarray(0, -12), length, chunk, end, png.subarray(-12)])
}
export interface PerformanceFixture {
  format: 1; root: string; userData: string; count: number; spaceCount: number; ids: string[]
  spaces: { id: string; root: string }[]; noteMatches: number; setupMs: number; uniqueBytes: number
  pluginVersions: { id: string; version: string }[]
}
async function prepare() {
  const dir = resolve(process.argv[2]), count = Number(process.argv[3]), spaceCount = Number(process.argv[4])
  if (!existsSync(join(dir, 'benchmark-owned.json')) || !Number.isInteger(count) || count < 40 || count > 100000 || ![1, 3].includes(spaceCount)) throw new Error('仅支持 runner 新建的基准目录与有效规模')
  const start = performance.now(), root = join(dir, 'benchmark.library'), userData = join(dir, 'user-data')
  if (existsSync(root) || existsSync(userData)) throw new Error('夹具目标必须不存在')
  const lib = openLibrary(root), packages = new PackageManager(userData, PLUGINS.map(p => p.id))
  const catalog: { file: string }[] = JSON.parse(readFileSync(resolve('out/main/plugins/catalog.json'), 'utf8'))
  for (const item of catalog) {
    const ref = packages.install(readFileSync(resolve('out/main/plugins', item.file)))
    packages.grant(root, ref.hash); setBinding(lib, { ...ref, enabled: true }, PLUGINS)
  }
  const assembly = await loadExternalCore(lib, PLUGINS, corePlugins, packages.begin(root), DISTRIBUTION)
  const host = new Host(root, assembly.plugins, () => {}, { library: lib, manifest: assembly.manifest })
  try {
    const spaces = [lib.files.bindings!.default().space]
    for (let i = 1; i < spaceCount; i++) {
      const info = FileSpace.create(join(dir, 'shared-' + i), 'shared')
      await host.api.linkFileSpace(info.root); spaces.push(lib.files.bindings!.open(info.id))
    }
    const png = await sharp({ create: { width: 256, height: 160, channels: 3, background: '#63889d' } }).png().toBuffer()
    const ids: string[] = []; let uniqueBytes = 0, noteMatches = 0
    for (let offset = 0; offset < count; offset += 250) {
      host.store.batch(() => {
        // 夹具生成使用短批事务，不把 setup 的直接登记误当作真实导入速度。
        const seed = (index: number) => {
          const space = spaces[index % spaceCount], fileId = randomUUID(), version = randomUUID(), name = `bench-${String(index).padStart(6, '0')}.png`
          const path = `files/.versions/${fileId}/${version}/${name}`, bytes = pngLabel(png, String(index))
          mkdirSync(join(space.root, 'files/.versions', fileId, version), { recursive: true }); writeFileSync(join(space.root, path), bytes)
          const hash = createHash('sha256').update(bytes).digest('hex'), mtime = statSync(join(space.root, path)).mtimeMs
          space.db.prepare('INSERT INTO files VALUES (?,?,?,?,?,1,?)').run(fileId, path, hash, bytes.length, mtime, 'available')
          space.db.prepare('INSERT INTO file_versions VALUES (?,?,?,?,?,?,1,?,?)').run(version, fileId, name, hash, bytes.length, 1700000000000 + index, path, mtime)
          space.db.prepare('INSERT INTO file_heads VALUES (?,?)').run(fileId, version)
          space.db.prepare("INSERT INTO space_changes(fileId,contentVersion,revision,type,createdAt) VALUES (?,?,1,'added',?)").run(fileId, version, 1700000000000 + index)
          const id = host.store.createEntity(1700000000000 + index); ids.push(id); uniqueBytes += bytes.length
          host.store.put(id, 'file', { name, ext: 'png', mime: 'image/png', path: spaceReference(space.id, fileId, name, version), hash, size: bytes.length })
          host.store.put(id, 'tags', { values: ['组' + index % 20, '基准'] })
          if (index % 10 === 0) { host.store.put(id, 'note', { text: `perfneedle 光影与构图参考，第 ${index} 项` }); noteMatches++ }
          lib.db.prepare('INSERT INTO main.space_adoptions VALUES (?,?,?)').run(space.id, fileId, id)
        }
        // 各空间事务属于合成 setup；测量阶段始终调用生产 API。
        const chunk = () => { for (let i = offset; i < Math.min(count, offset + 250); i++) seed(i) }
        spaces.reduceRight<() => void>((fn, space) => () => space.db.transaction(fn)(), chunk)()
      })
      if (offset % 1000 === 0) console.log(`[prepare] ${count}/${spaceCount} spaces: ${Math.min(count, offset + 250)} records`)
    }
    console.log(`[prepare] processing ${count} real images`)
    await host.scheduler.idle()
    const processed = Number(lib.db.prepare("SELECT count(*) FROM derived.block WHERE kind='thumb'").pluck().get())
    if (processed !== count) throw new Error(`夹具加工不完整 ${processed}/${count}`)
    // 开启自动发现但预先完成首次扫描；测量的是已使用仓库的无变化检查。
    const policy = { defaultSpaceId: spaces[0].id, collect: true, spaces: spaces.map(s => ({ spaceId: s.id, automatic: true, updates: 'manual' })) }
    lib.db.prepare("INSERT INTO main.config(key,value) VALUES ('imports.v1',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(policy))
    await host.api.scanSpaceImports()
    const sample = await host.api.itemDisposalSnapshot(ids.slice(-10))
    if (sample.files.length !== 10) throw new Error('原件引用夹具不正确')
    packages.ready(root)
    const result: PerformanceFixture = { format: 1, root, userData, count, spaceCount, ids, spaces: spaces.map(s => ({ id: s.id, root: s.root })), noteMatches,
      uniqueBytes, setupMs: performance.now() - start, pluginVersions: packages.list().map(p => ({ id: p.manifest.id, version: p.manifest.version })) }
    writeFileSync(join(dir, 'fixture.json'), JSON.stringify(result))
    console.log(`[prepare] ready ${count}/${spaceCount}: ${(result.setupMs / 1000).toFixed(1)}s`)
  } finally { host.close() }
}
void prepare().catch(e => { console.error(e); process.exitCode = 1 })
