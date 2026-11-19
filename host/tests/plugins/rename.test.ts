// 当前版本空间改名只改仓库显示名称；原件版本与路径保持，业务变更可撤销。

import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import sharp from 'sharp'
import { afterEach, describe, expect, it } from 'vitest'
import { planRenames, renamed, splitName } from '../../src/plugins/file/names'
import { openHost, tempDir } from '../helpers/helpers'

let cleanup: (() => void) | undefined
afterEach(() => {
  cleanup?.()
  cleanup = undefined
})

function setup() {
  const h = openHost()
  cleanup = h.cleanup
  return h
}

async function image(host: ReturnType<typeof openHost>['host'], name: string, color = '#3366cc') {
  const path = join(tempDir(), name)
  await sharp({ create: { width: 400, height: 300, channels: 3, background: color } }).png().toFile(path)
  return (await host.api.ingest([{ type: 'file', path }]))[0]
}

const fileOf = (h: ReturnType<typeof openHost>, id: string) => h.host.store.blocksOf(id).file.data as { name: string; path: string }

describe('文件名的规则', () => {
  it('扩展名不让改；/ \\ : 换掉；开头的点去掉；空的、太长的不行', () => {
    expect(splitName('海边.PNG')).toEqual({ base: '海边', ext: '.PNG' })
    expect(splitName('.gitignore')).toEqual({ base: '.gitignore', ext: '' })
    expect(splitName('README')).toEqual({ base: 'README', ext: '' })
    expect(renamed('海边.PNG', ' 日落 ')).toBe('日落.PNG')
    expect(renamed('海边.png', '日落.jpg')).toBe('日落.jpg.png')
    expect(renamed('a.png', 'x/y:z')).toBe('x_y_z.png')
    expect(renamed('a.png', '..隐藏')).toBe('隐藏.png')
    expect(() => renamed('a.png', '  ')).toThrow('名字不能是空的')
    expect(() => renamed('a.png', '字'.repeat(90))).toThrow('名字太长了')
  })

  it('统一命名加序号：位数按最大的补零；替换：全部出现的地方', () => {
    const items = Array.from({ length: 12 }, (_, i) => ({ id: String(i), name: `截屏 ${i}.png` }))
    const numbered = planRenames(items, { type: 'number', base: '海报', start: 1 })
    expect(numbered.map((p) => p.to).slice(0, 2)).toEqual(['海报_01.png', '海报_02.png'])
    expect(numbered[11].to).toBe('海报_12.png')
    expect(planRenames(items.slice(0, 2), { type: 'number', base: '', start: 99 }).map((p) => p.to)).toEqual(['099.png', '100.png'])
    const replaced = planRenames([{ id: 'a', name: '截屏 截屏.png' }], { type: 'replace', find: '截屏', with: '参考' })
    expect(replaced[0]).toEqual({ id: 'a', from: '截屏 截屏.png', to: '参考 参考.png', base: '参考 参考' })
    expect(planRenames([{ id: 'a', name: '截屏.png' }], { type: 'replace', find: '截屏', with: '' })[0].error).toBe('名字不能是空的')
  })
})

describe('改名', () => {
  it('改显示名称后可搜索；原件及代表图引用稳定；撤销重做只改仓库名称', async () => {
    const h = setup()
    const { host } = h
    const id = await image(host, '海边.png')
    await host.scheduler.idle()
    const before = fileOf(h, id)
    const imageSeq = host.store.blocksOf(id).image.seq

    expect(host.api.run('file', 'rename', { names: { [id]: '日落' } })).toEqual({ renamed: 1 })
    const after = fileOf(h, id)
    expect(after.name).toBe('日落.png')
    expect(after.path).toBe(before.path)
    const originalPath = host.lib.files.readable(before.path)
    expect(basename(originalPath)).toBe('海边.png')
    expect((host.api.query({ text: '日落' }) as { ids: string[] }).ids).toEqual([id])
    expect((host.api.query({ text: '海边' }) as { ids: string[] }).ids).toEqual([])

    await host.scheduler.idle()
    // 代表图和内容都不变；读尺寸只看内容，没有重做。
    expect(host.store.blocksOf(id).still.data.path).toBe(after.path)
    expect(existsSync(host.lib.files.readable(String(host.store.blocksOf(id).thumb.data.path)))).toBe(true)
    expect(host.store.blocksOf(id).image.seq).toBe(imageSeq)

    expect(host.api.undo()).toBe('重命名「海边.png」为「日落.png」')
    expect(fileOf(h, id)).toMatchObject({ name: '海边.png', path: before.path })
    expect(host.lib.files.readable(fileOf(h, id).path)).toBe(originalPath)
    expect(host.api.redo()).toBe('重命名「海边.png」为「日落.png」')
    expect(fileOf(h, id).name).toBe('日落.png')
    expect(host.lib.files.readable(fileOf(h, id).path)).toBe(originalPath)
  })

  it('一批：有一项不能用就整个不改，已经改了的文件换回去', async () => {
    const h = setup()
    const { host } = h
    const a = await image(host, 'a.png', '#111111')
    const b = await image(host, 'b.png', '#222222')
    expect(() => host.api.run('file', 'rename', { names: { [a]: '甲', [b]: '  ' } })).toThrow('「b.png」：名字不能是空的')
    expect(fileOf(h, a).name).toBe('a.png')
    expect(basename(host.lib.files.readable(fileOf(h, a).path))).toBe('a.png')

    host.api.run('file', 'rename', { names: { [a]: '同名', [b]: '同名' } })
    expect([fileOf(h, a).name, fileOf(h, b).name]).toEqual(['同名.png', '同名.png'])
    expect(host.api.undo()).toBe('重命名 2 项')
  })

  it('文档改名不重读正文；改名以后彻底删除，撤销不会把文件变回来', async () => {
    const h = openHost()
    cleanup = h.cleanup
    const { host } = h
    const doc = join(tempDir(), '读书笔记.md')
    writeFileSync(doc, '# 读书笔记\n\n留白')
    const [id] = await host.api.ingest([{ type: 'file', path: doc }])
    await host.scheduler.idle()
    const bodySeq = host.store.blocksOf(id).body.seq

    host.api.run('file', 'rename', { names: { [id]: '设计中的设计' } })
    await host.scheduler.idle()
    expect(host.store.blocksOf(id).body.seq).toBe(bodySeq)

    const originalPath = host.lib.files.readable(fileOf(h, id).path)
    host.api.trash([id])
    await host.api.purge([id])
    expect(readFileSync(originalPath, 'utf8')).toBe(readFileSync(doc, 'utf8'))
    // 移到回收站、改名都只关于它：撤销栈里没有了
    expect(host.api.undo()).toBe(null)
    expect(existsSync(originalPath)).toBe(true)
  })
})

const ffmpeg = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg'].find(existsSync)

describe.skipIf(!ffmpeg)('改名：视频', () => {
  it('截帧、预览帧只看内容：改名不重做', async () => {
    const h = setup()
    const { host } = h
    const mp4 = join(tempDir(), 'clip.mp4')
    execFileSync(ffmpeg!, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=10', '-t', '2', '-c:v', 'libx264', mp4])
    const [id] = await host.api.ingest([{ type: 'file', path: mp4 }])
    await host.scheduler.idle()
    const seqs = (['video', 'still', 'frames'] as const).map((k) => host.store.blocksOf(id)[k].seq)
    host.api.run('file', 'rename', { names: { [id]: '片段' } })
    await host.scheduler.idle()
    expect((['video', 'still', 'frames'] as const).map((k) => host.store.blocksOf(id)[k].seq)).toEqual(seqs)
  })
})
