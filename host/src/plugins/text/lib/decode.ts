// 文本文件的编码：先当 UTF-8 读，不是合法的 UTF-8 再按 GB18030（兼容 GBK、GB2312，中文旧文件常见）。

const UTF8_BOM = [0xef, 0xbb, 0xbf]

export function decodeText(buf: Buffer): { text: string; encoding: string } {
  if (buf.includes(0)) throw new Error('不是文本文件')
  const bom = UTF8_BOM.every((b, i) => buf[i] === b)
  const body = bom ? buf.subarray(3) : buf
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(body), encoding: 'UTF-8' }
  } catch {
    return { text: new TextDecoder('gb18030').decode(body), encoding: 'GB18030' }
  }
}
