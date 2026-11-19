// 磁盘事实与版本基线分开：快速检查只复用已核对的 stat，完整检查始终读字节。
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat } from 'node:fs/promises'
import type { Stats } from 'node:fs'
import type { DiskFingerprint, DiskObservation } from '../shared/space-disk'
export const fingerprint = (s: Stats): DiskFingerprint => ({ size: s.size, mtime: s.mtimeMs, ctime: s.ctimeMs, ino: s.ino, dev: s.dev })
export const sameFingerprint = (a: DiskFingerprint | undefined, b: DiskFingerprint | undefined) => JSON.stringify(a) === JSON.stringify(b)
export const diskDigest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export async function observeFile(path: string, expectedHash: string, signal?: AbortSignal, previous?: DiskObservation): Promise<DiskObservation> {
  try {
    signal?.throwIfAborted()
    const before = await lstat(path)
    if (!before.isFile() || before.isSymbolicLink()) throw new Error('登记位置不是普通文件，不能自动采用')
    const mark = fingerprint(before)
    if (previous?.path === path && previous.hash && sameFingerprint(previous.fingerprint, mark)) return previous
    const hash = createHash('sha256')
    for await (const bytes of createReadStream(path, { signal })) hash.update(bytes)
    const after = fingerprint(await lstat(path))
    if (!sameFingerprint(mark, after)) return { path, state: 'unstable', error: '检查期间文件变化，请待外部保存完成后重试' }
    const value = hash.digest('hex')
    return { path, state: value === expectedHash ? 'unchanged' : 'modified', hash: value, fingerprint: mark }
  } catch (e) {
    signal?.throwIfAborted()
    return { path, state: (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable', error: e instanceof Error ? e.message : String(e) }
  }
}
