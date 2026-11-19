import { createHash } from 'node:crypto'
import { openSync, readSync, closeSync } from 'node:fs'

/** 有界内存校验；不依赖仓库、分享登记或版本协议。 */
export function hashFile(path: string): string {
  const hash = createHash('sha256'), fd = openSync(path, 'r'), buffer = Buffer.allocUnsafe(1024 * 1024)
  try { for (;;) { const size = readSync(fd, buffer, 0, buffer.length, null); if (!size) break; hash.update(buffer.subarray(0, size)) } }
  finally { closeSync(fd) }
  return hash.digest('hex')
}
