import type Database from 'better-sqlite3'
import { constants, type BigIntStats } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { basename, isAbsolute, join, sep } from 'node:path'
import { createHash } from 'node:crypto'
import type { CatalogEntry } from './directory-identity'
import { moveKey } from './directory-identity'
import { directoryStamp } from './directory-reference'

type Identity = { device: string; inode: string; root: string }
const same = (s: BigIntStats, old: Identity) => s.isDirectory() && String(s.dev) === old.device && String(s.ino) === old.inode
const missing = (e: unknown) => ['ENOENT', 'ENOTDIR'].includes((e as NodeJS.ErrnoException).code ?? '')

async function hashAt(path: string, observed: BigIntStats) {
  const f = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  try {
    const stamp = directoryStamp(observed)
    if (directoryStamp(await f.stat({ bigint: true })) !== stamp) throw new Error('核对期间文件已变化')
    const hash = createHash('sha256')
    for await (const bytes of f.createReadStream({ autoClose: false })) hash.update(bytes)
    if (directoryStamp(await lstat(path, { bigint: true })) !== stamp) throw new Error('核对期间文件已变化')
    return hash.digest('hex')
  } finally { await f.close() }
}

/** 由已关联仓库显式选择替代根目录。整棵树验证完才提交新的来源位置。 */
export async function relocateDirectory(db: Database.Database, source: Identity, target: string, ensureFree: () => void) {
  const version = db.pragma('data_version', { simple: true })
  const root = await realpath(target), rootStat = await lstat(root, { bigint: true })
  if (!rootStat.isDirectory()) throw new Error('请选择目录')
  const sameRoot = same(rootStat, source)
  const rows = db.prepare(`SELECT e.*,v.hash FROM entries e LEFT JOIN verified_files v ON v.id=e.id WHERE e.parent IS NOT NULL ORDER BY length(e.path)`).all() as (CatalogEntry & { hash?: string })[]
  const keep = new Map<string, { stamp: string; diskKey: string | null }>()
  const drop: string[] = []
  let matched = 0
  if (!sameRoot) {
    const prior = await lstat(source.root, { bigint: true }).catch(e => { if (!missing(e)) throw e })
    if (prior && same(prior, source)) throw new Error('原目录仍在原位置，无法将这个空间指向另一份副本')
    for (const row of rows) {
      if (!row.folder && !row.hash) { drop.push(row.id); continue }
      if (isAbsolute(row.path) || row.path.split(sep).includes('..')) throw new Error('登记路径无效')
      const path = join(root, row.path)
      const canonical = await realpath(path).catch(e => { if (!missing(e)) throw e })
      if (!canonical && row.folder) { drop.push(row.id); continue }
      if (canonical !== path) throw new Error('新位置缺少可验证的同路径原件：' + row.path)
      const st = await lstat(path, { bigint: true })
      if (row.folder && st.isDirectory()) keep.set(row.id, { stamp: [st.dev, st.ino].join(':'), diskKey: null })
      else if (!row.folder && st.isFile() && Number(st.size) === row.size && await hashAt(path, st) === row.hash) {
        keep.set(row.id, { stamp: directoryStamp(st), diskKey: moveKey(st) }); matched++
      } else throw new Error('新位置与已登记内容不符：' + row.path)
    }
    if (!matched) throw new Error('没有可证明同一来源的已核对文件。请先在原目录核对至少一个文件')
    for (const row of rows) {
      const observed = keep.get(row.id)
      if (!observed) continue
      const path = join(root, row.path), st = await lstat(path, { bigint: true })
      if (await realpath(path) !== path || (row.folder ? [st.dev, st.ino].join(':') : directoryStamp(st)) !== observed.stamp)
        throw new Error('核对期间位置或内容已变化：' + row.path)
    }
  }
  if (directoryStamp(await lstat(root, { bigint: true })) !== directoryStamp(rootStat)) throw new Error('新目录在核对期间已变化')
  ensureFree()
  db.transaction(() => {
    if (db.pragma('data_version', { simple: true }) !== version) throw new Error('核对期间登记已变化，请重试')
    if (!sameRoot) {
      const remove = db.prepare('DELETE FROM entries WHERE id=?')
      for (const id of drop) remove.run(id)
      const update = db.prepare('UPDATE entries SET stamp=?,diskKey=? WHERE id=?')
      const verified = db.prepare('UPDATE verified_files SET stamp=? WHERE id=?')
      for (const [id, item] of keep) { update.run(item.stamp, item.diskKey, id); verified.run(item.stamp, id) }
      db.exec('UPDATE missing_files SET diskKey=NULL; UPDATE entries SET checkedAt=NULL WHERE folder=1')
    }
    db.prepare('UPDATE source SET root=?,name=?,device=?,inode=?').run(root, basename(root) || root, String(rootStat.dev), String(rootStat.ino))
  }).immediate()
  return { sameRoot, matched }
}
