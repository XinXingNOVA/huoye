import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { serveLibraryFile } from '../../src/main/lib-protocol'
import { tempDir } from '../helpers/helpers'

const root = tempDir('rm-proto-')
mkdirSync(join(root, 'cache', 'x'), { recursive: true })
afterAll(() => rmSync(root, { recursive: true, force: true }))
const data = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256))
writeFileSync(join(root, 'cache', 'x', '视频 1.mp4'), data)

const get = (path: string, range?: string) =>
  serveLibraryFile(root, new Request(`lib://library/${path}`, { headers: range ? { Range: range } : {} }))

describe('lib:// 协议', () => {
  it('没有 Range：整份返回 200，带类型和长度', async () => {
    const res = await get('cache/x/%E8%A7%86%E9%A2%91%201.mp4')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('video/mp4')
    expect(res.headers.get('accept-ranges')).toBe('bytes')
    expect(Buffer.from(await res.arrayBuffer())).toEqual(data)
  })

  it('Range：返回 206 和对应的字节', async () => {
    const res = await get('cache/x/%E8%A7%86%E9%A2%91%201.mp4', 'bytes=100-199')
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe('bytes 100-199/1000')
    expect(Buffer.from(await res.arrayBuffer())).toEqual(data.subarray(100, 200))
  })

  it('开放区间与末尾区间', async () => {
    const open = await get('cache/x/%E8%A7%86%E9%A2%91%201.mp4', 'bytes=990-')
    expect(open.headers.get('content-range')).toBe('bytes 990-999/1000')
    expect((await open.arrayBuffer()).byteLength).toBe(10)
    const tail = await get('cache/x/%E8%A7%86%E9%A2%91%201.mp4', 'bytes=-5')
    expect(Buffer.from(await tail.arrayBuffer())).toEqual(data.subarray(995))
  })

  it('越界返回 416；不存在返回 404；不能访问库外的文件', async () => {
    expect((await get('cache/x/%E8%A7%86%E9%A2%91%201.mp4', 'bytes=2000-')).status).toBe(416)
    expect((await get('cache/x/nope.mp4')).status).toBe(404)
    expect((await get('..%2F..%2Fetc%2Fpasswd')).status).toBe(403)
    expect((await get('..%5C..%5Cetc%5Cpasswd')).status).toBe(403)
  })

  it('反斜杠缓存路径仍然能读到同一文件', async () => {
    const res = await get(encodeURIComponent('cache\\x\\视频 1.mp4'))
    expect(res.status).toBe(200)
    expect(Buffer.from(await res.arrayBuffer())).toEqual(data)
  })
})
