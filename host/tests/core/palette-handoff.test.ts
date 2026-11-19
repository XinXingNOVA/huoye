import { it, expect } from 'vitest'
import { Host } from '../../src/core/host'
import { previewPlugin } from '../../src/plugins/preview/core'
import { tempDir } from '../helpers/helpers'
import { rmSync } from 'node:fs'
import { handoffPalette } from '../../src/core/palette-handoff'
import { checkPackageKinds } from '../../src/core/external-plugins'
import type { BlockKind } from '../../src/shared/blocks'
it('旧色板保留值并交接休眠归属与清理责任，重复打开及清理后不复活', async () => {
  const root=tempDir(), block:BlockKind={id:'palette',plugin:'preview',title:'色板',version:1,rebuildable:true,fields:{colors:{type:'color',title:'颜色',list:true},weights:{type:'number',title:'占比',list:true}}}
  const manifest=[{id:'preview',title:'预览',description:''}]
  let h=new Host(root,[{...previewPlugin,blocks:[...previewPlugin.blocks!,block],systems:[{id:'preview.palette',priority:60,has:['thumb'],outputs:['palette'],async run(){return {palette:{colors:['#123456'],weights:[1]}}}}]}],()=>{},{manifest})
  try {
    const id=h.store.createEntity();h.store.put(id,'palette',{colors:['#123456'],weights:[1]})
    h.close();h=new Host(root,[previewPlugin],()=>{},{manifest})
    expect(h.reg.kind('palette')).toMatchObject({plugin:'palette',dormant:true})
    expect(h.store.blocksOf(id).palette.data.colors).toEqual(['#123456'])
    expect(()=>checkPackageKinds(h.lib,'palette',[{...block,plugin:'palette'}])).not.toThrow()
    handoffPalette(h.lib.db)
    const old=JSON.parse(h.lib.db.prepare("SELECT value FROM config WHERE key='pluginData:preview'").pluck().get() as string)
    expect(old.systems.map((s:{id:string})=>s.id)).not.toContain('preview.palette')
    const p=await h.api.previewPluginDataCleanup({pluginId:'palette',mode:'all'})
    expect(p.blocked).toEqual([])
    await h.api.cleanupPluginData({pluginId:'palette',mode:'all',token:p.token})
    expect(h.store.exists(id)).toBe(true);expect(h.store.blocksOf(id).palette).toBeUndefined()
    h.close();h=new Host(root,[previewPlugin],()=>{},{manifest})
    expect(h.reg.kind('palette')).toBeUndefined()
  } finally {h.close();rmSync(root,{recursive:true,force:true})}
})
