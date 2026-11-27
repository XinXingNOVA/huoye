import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import { packPlugin } from '../../scripts/plugins/pack.ts'

const dir = resolve(process.argv[2])
const source = join(dir, 'studio-fixture')
const provider = join(dir, 'studio-engine')
mkdirSync(provider, { recursive: true })
mkdirSync(source, { recursive: true })
const value = 'studio/text.measure@1', image = 'studio/image.sample@1'
const base = {version:'1.0.0', apiVersion:1, author:'test', description:''}
const contracts = [{ id: value, source: 'none', input: { text: 'text' }, output: { count: 'number' } },
  { id: image, source: 'file', input: {}, output: {}, artifact: 'image', interactive: true }]
writeFileSync(join(source,'plugin.json'),JSON.stringify({ ...base, id:'studio-fixture', title:'Studio fixture', entries:{ui:'./ui.tsx'},
  uiFeatures:['tool-placement-v1','floating-page-v1','preset-layout-v1','region-tools-v1','transient-drop-v1','interactive-values-v1','tool-image-reads-v1'],
  capabilities:{version:2, contracts, optionalConsumes:[value], consumes:[image]} }))
writeFileSync(join(provider,'plugin.json'),JSON.stringify({ ...base, id:'studio-engine', title:'Studio engine', servicePrograms:['studio-probe'],
  entries:{service:'./service.ts', provider:'./provider.ts'}, capabilities:{version:2, provides:[value,image],contracts,
    implementations:[{id:value,execution:'local',workload:'light',via:'service'},{id:image,execution:'local'}]} }))
writeFileSync(join(provider, 'service.ts'), `import type { LocalServicePlugin } from '@resource-manager/plugin-api/local-service'
import {readFile} from 'node:fs/promises'
export const plugin: LocalServicePlugin = { id: 'studio-engine', start(ctx) { return { async compute(_id, params) {
  const program = ctx.resolveProgram('studio-probe')
  if (!program || (await readFile(program,'utf8')) !== 'selected' || ctx.resolveProgram('undeclared-probe')) throw Error('Unexpected shared runtime')
  if (params.text === 'bad-output') return undefined as any
  return { count: String(params.text).length }
} } } }`)
writeFileSync(join(provider, 'provider.ts'), `import { readFile } from 'node:fs/promises'
import type { CapabilityProvider } from '@huoye/provider-sdk'
export const plugin: CapabilityProvider = { id: 'studio-engine', handlers: {
  '${image}': async (_, ctx) => new Uint8Array(await readFile(ctx.sourcePath!))
} }`)
writeFileSync(join(source, 'ui.tsx'), `import { useState } from 'react'
import type { UiPlugin, TabProps } from '@resource-manager/plugin-api/ui/contracts'
import { ReceiveSurface } from '@resource-manager/plugin-api/ui/receive'
function Page({host, capabilities}: TabProps) {
  const [message, set] = useState('')
  return <ReceiveSurface mode="transient"><section data-probe="drop" onDrop={e=>{e.stopPropagation();set(e.dataTransfer.files[0]?.name ?? 'empty')}}>
    <button data-probe="compute" onClick={()=>void capabilities!.run('${value}', {text:'hello'}).then(v=>set(String(v.count)), e=>set(String(e)))}>Compute</button>
    <button data-probe="bad-value" onClick={()=>void capabilities!.run('${value}', {text:'bad-output'}).then(()=>set('unexpected success'), e=>set(String(e)))}>Invalid result</button>
    <button data-probe="float" onClick={()=>host.openTab('studio-fixture.page',{}, {window:{kind:'floating',width:500,height:420}})}>Float</button>
    <button data-probe="viewer" onClick={async()=>{const { ids }=await host.core.query({has:['image']});host.openTab('image.viewer',{id:ids[0],list:{orderedIds:ids}})}}>Viewer</button>
    <button data-probe="hide" onClick={()=>host.showView('host.inspector')}>Inspector</button><button data-probe="tool"  onClick={()=>host.showView('studio-fixture.panel')}>Tool</button><output data-probe="result">{message}</output></section></ReceiveSurface>
}
export const plugin: UiPlugin = { id:'studio-fixture', tabTypes:[{id:'studio-fixture.page',Title:()=> <>Studio</>,Component: Page}],
 views:[{id:'studio-fixture.wall',title:'Studio Wall', layout:'studio-fixture.layout', options:{size:'large'},query:{scope:'content'},order:0},
 {id:'studio-fixture.page-view',title:'Studio Page',tab:'studio-fixture.page',query:{scope:'content'},order:1}],
 layouts:[{id:'studio-fixture.layout',title:'Studio layout',Component:({options})=><output data-probe="layout">{String(options.size)}</output>}],
 overlays:[{id:'studio-fixture.first',title:'First tool',space:'region',order:10,interaction:'tool',Component:()=> <span data-probe="first"/>},
 {id:'studio-fixture.second',title:'Second tool',space:'region',order:11,interaction:'tool',Toolbar:()=> <span data-probe="toolbar"/>,Component:()=> <span data-probe="second"/>},
 {id:'studio-fixture.passive',space:'region',order:12,interaction:'passive',Component:()=> <span data-probe="passive"/>}],
 toolViews:[{id:'studio-fixture.panel',title:'Studio panel',order:5,placement:{regions:['right'],default:{region:'right',group:'host.inspector'}},Component:({host,imageReads})=>{
 const [url,set] = useState(''); return <><button data-probe="read" onClick={async()=>{
 const item=(await host.core.get((await host.core.query({has:['image']})).ids))[0]
 try { const lease=await imageReads!.image('${image}',{id:item.id,fileSeq:item.blocks.file.seq,params:{}},{maxEdge:32});set(lease.url) } catch(e){set(String(e))}
 }}>Read</button><img data-probe="image" src={url || undefined}/></> }}]
}`)
await packPlugin(provider, join(dir, 'engine.hyplugin'))
await packPlugin(source, join(dir, 'studio.hyplugin'))
await sharp({create:{width:80,height:60,channels:3,background:'#30ab92'}}).png().toFile(join(dir,'sample.png'))
await sharp({create:{width:90,height:60,channels:3,background:'#303850'}}).png().toFile(join(dir,'second.png'))
await sharp({create:{width:45,height:28,channels:3,background:'#607431'}}).png().toFile(join(dir,'clipboard.png'))
