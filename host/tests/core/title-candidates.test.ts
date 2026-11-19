import { afterEach, expect, it } from 'vitest'
import { titleCandidates, summaryTitle } from '../../src/shared/title'
import { corePlugins } from '../../src/plugins/core'
import { plugin as note } from '@test-plugins/note/core'
import { openHost } from '../helpers/helpers'
import type { BlockKind, Blocks } from '../../src/shared/blocks'
let current:ReturnType<typeof openHost>|undefined
afterEach(()=>{current?.cleanup();current=undefined})
it('根据 display 声明提供有界名称候选，保留旧 title 行为与 kinds 过滤',async()=>{
  const h=(current=openHost([...corePlugins,note])).host
  const id=await h.api.create({text:{content:'正文名称'},note:{text:'采集批次 demo1\n更多笔记'}})
  const found=(await h.api.searchPage({query:{ids:[id]}})).items[0]
  expect(found.title).toBe('采集批次 demo1')
  expect(found.titleCandidates).toEqual([{kind:'note',field:'text',text:'采集批次 demo1',truncated:true},{kind:'text',field:'content',text:'正文名称',truncated:false}])
  expect((await h.api.readItem({id,kinds:['text']})).titleCandidates).toEqual([found.titleCandidates[1]])
  expect((await h.api.readItem({id,kinds:[]})).titleCandidates).toEqual([])
})
it('新插件声明自动参与，无标题声明与非字符串略过，数量与长字段有上限',()=>{
  const definitions:BlockKind[]=Array.from({length:10},(_,i)=>({id:`custom.${i}`,plugin:'custom',title:'名称',version:1,rebuildable:false,display:{title:'name',priority:i},fields:{name:{type:'text',title:'名称'}}}))
  const blocks:Blocks=Object.fromEntries(definitions.map(d=>[d.id,{data:{name:'字'.repeat(5000)},seq:1,ver:1}]))
  const kind=(id:string)=>definitions.find(d=>d.id===id)
  const before=summaryTitle(blocks,kind),values=titleCandidates(blocks,kind)
  expect(values).toHaveLength(8);expect(values.every(v=>v.text.length===300&&v.truncated)).toBe(true)
  expect(summaryTitle(blocks,kind)).toBe(before)
  expect(titleCandidates({...blocks,'custom.0':{data:{name:42},seq:1,ver:1}},kind)[0].kind).toBe('custom.1')
})
