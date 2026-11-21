// 一份空间只保留最后一轮完整核对的凭据。中断、失败或被后一轮取代的扫描不能发布清理依据。
import type Database from 'better-sqlite3'
import { createHash, randomUUID } from 'node:crypto'
import { accessSync, constants, lstatSync, realpathSync } from 'node:fs'
import { join } from 'node:path'

export const missingCheckSchema = 'CREATE TABLE missing_check (slot INTEGER PRIMARY KEY CHECK(slot=1), run TEXT NOT NULL, proof TEXT)'
export function startMissingCheck(db: Database.Database) {
  const run = randomUUID()
  db.prepare('INSERT OR REPLACE INTO missing_check(slot,run,proof) VALUES (1,?,NULL)').run(run)
  return run
}
export function finishMissingCheck(db: Database.Database, run: string, proof: string) {
  db.prepare('UPDATE missing_check SET proof=? WHERE slot=1 AND run=?').run(proof, run)
}
export function checkedProof(db: Database.Database) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='missing_check'").get()) return undefined
  return db.prepare('SELECT proof FROM missing_check WHERE slot=1').pluck().get() as string | null | undefined
}
export function directoryProof(root: string, folders: Map<string, string>) {
  const hash = createHash('sha256').update(JSON.stringify(root))
  for (const path of [...folders.keys()].sort()) hash.update(JSON.stringify([path, folders.get(path)]))
  return hash.digest('hex')
}
export function readableFolder(path: string) {
  if (realpathSync(path) !== path) throw new Error('目录位置已变化，请重新核对')
  const stat = lstatSync(path, { bigint: true })
  if (!stat.isDirectory()) throw new Error('文件空间目录不可用')
  accessSync(path, constants.R_OK | constants.X_OK)
  return stat
}
export function managedAreaProof(root: string) {
  const canonical = realpathSync(root)
  return [canonical, join(canonical, 'files')].map(path => {
    const s = readableFolder(path)
    return [s.dev, s.ino, s.birthtimeNs].join(':')
  }).join('/')
}
