import { join } from 'node:path'
import { renderJobImage } from '../../src/core/job-image'
import sharp from 'sharp'
import { expect, it } from 'vitest'
import type { CorePlugin } from '../../src/core/plugin'
import { openHost } from '../helpers/helpers'

it('贴边裁切受像素边界约束，镜像作用在已经裁出的区域', async () => {
  const {root, cleanup} = openHost([], { manifest: [] })
  try {
    const path = join(root, 'swatches.png')
    const data = Buffer.alloc(96 * 32 * 3)
    for (let y = 0; y < 32; y++) for (let x = 0; x < 96; x++) data[(y * 96 + x) * 3 + Math.floor(x / 32)] = 240
    await sharp(data, { raw: { width: 96, height: 32, channels: 3 } }).png().toFile(path)
    const tile = { source: path, x: 0, y: 0, width: 64, height: 32, flipX: true,
      crop: { x: 1 / 3, y: 0, width: 2 / 3 + Number.EPSILON, height: 1 } }
    const render = () => renderJobImage({ width: 64, height: 32, tiles: [tile] }, ref => ref, new AbortController().signal)
    const image = await render()
    const pixels = await sharp(image.bytes).removeAlpha().raw().toBuffer()
    expect(pixels[(16 * 64 + 12) * 3 + 2]).toBeGreaterThan(200)
    expect(pixels[(16 * 64 + 52) * 3 + 1]).toBeGreaterThan(200)
    tile.crop.width = 0.8
    await expect(render()).rejects.toThrow('裁切范围无效')
  } finally { cleanup() }
})

function latch() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { resolve, promise }
}

it('同一来源合并，旧成员和新成员都刷新；过期任务不能发布像素或加工记录', async () => {
  const started = latch(), release = latch()
  const latest = latch(), finish = latch()
  const runs: string[] = []
  let gate = false, stagedPath = ''
  const plugin: CorePlugin = {
    id: 'probe', version: 1,
    blocks: [
      { id: 'work', title: '作品', plugin: 'probe', content: true, rebuildable: false, version: 1, fields: {} },
      { id: 'paint', title: '颜色', plugin: 'probe', content: true, rebuildable: false, version: 1, fields: { width: { type:'number',title:'宽度' } } },
      { id: 'memo', title: '附注', plugin: 'probe', rebuildable: false, version: 1, fields: {} },
      { id: 'part', title: '成员', plugin: 'probe', standalone: true, ownedBy: 'work', rebuildable: false, version: 1,
        fields: { work: { type: 'ref', ref: 'attach', title:'作品' }, image: { type:'ref', ref:'link', title:'来源' } } },
      { id: 'poster', title:'封面', plugin:'probe', rebuildable:true, version:1,
        fields: { path:{ type:'text',file:true,title:'缓存' }, width:{type:'number',title:'宽度'} } }
    ],
    commands: {
      add(ctx, { work, image }) {
        const ids = [ctx.createEntity(),ctx.createEntity()]
        for (const id of ids) ctx.put(id,'part',{ work,image })
        return { label:'增加',result:ids }
      },
      transfer(ctx,{ id,work }) { ctx.put(String(id),'part',{ ...ctx.blocksOf(String(id)).part.data,work });return {label:'转入'} },
      remove(ctx,{ id }) { ctx.deleteRecord(String(id));return {label:'移除'} }
    },
    systems: [{
      id:'probe.poster', priority:1, has:['work'], inputs:[], outputs:['poster'],
      relatedInputs:{kind:'part',ownerField:'work',field:'image',sourceKinds:['paint']},
      async run(ctx,id) {
        const snapshot = ctx.related!
        const width = Number([...snapshot.sources.values()][0]?.paint.data.width ?? 8)
        runs.push(id)
        const result = await ctx.composeImage({ width,height:8,tiles:[] })
        if (gate && width===16) { stagedPath=result.path;started.resolve();await release.promise }
        if (gate && width===32) { latest.resolve();await finish.promise }
        return { poster:{ path:result.path,width } }
      }
    }]
  }
  const {host,root,cleanup} = openHost([plugin],{manifest:[]})
  try {
    const a=host.api.create({work:{}}) as string,b=host.api.create({work:{}}) as string
    const src=host.api.create({paint:{width:8}}) as string
    const ids=host.api.run('probe','add',{work:a,image:src}) as string[]
    await host.scheduler.idle()
    runs.length=0
    host.store.put(src,'memo',{})
    await host.scheduler.idle()
    expect(runs).toEqual([])
    const before=host.store.blocksOf(a).poster
    gate=true
    host.store.put(src,'paint',{width:16})
    await started.promise
    host.store.put(src,'paint',{width:32})
    release.resolve()
    await latest.promise
    expect(host.store.blocksOf(a).poster.seq).toBe(before.seq)
    expect((await sharp(join(root,stagedPath)).metadata()).width).toBe(8)
    finish.resolve()
    await host.scheduler.idle()
    expect(runs).toEqual([a,a])
    expect((await sharp(join(root,stagedPath)).metadata()).width).toBe(32)
    gate=false
    runs.length=0
    host.api.run('probe','transfer',{id:ids[0],work:b})
    await host.scheduler.idle()
    expect(runs.sort()).toEqual([a,b].sort())
    runs.length=0
    host.api.run('probe','remove',{id:ids[1]})
    await host.scheduler.idle()
    expect(runs).toEqual([a])
    expect(host.store.blocksOf(a).poster.data.width).toBe(8)
    await host.api.undo()
    await host.scheduler.idle()
    expect(host.store.blocksOf(a).poster.data.width).toBe(32)
    host.api.trash([src])
    await host.scheduler.idle()
    expect(host.store.blocksOf(b).poster.data.width).toBe(8)
    host.api.restore([src])
    await host.scheduler.idle()
    expect(host.store.blocksOf(b).poster.data.width).toBe(32)
  } finally { release.resolve();finish.resolve();cleanup() }
})
