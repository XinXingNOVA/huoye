import { expect, it, vi } from 'vitest'
import { navigationIds } from '../../src/plugin-api/ui/navigation'
import type { UiHost } from '../../src/plugin-api/ui/contracts'
import type { Query } from '../../src/shared/query'
const fixture=(run:(q:Query)=>string[])=>{
  const query=vi.fn(async(q:Query)=>({ids:run(q),aspects:[]}))
  return {query,host:{core:{query}} as unknown as Pick<UiHost,'core'>}
}
it('普通视图保留筛选排序并只读对应素材类型',async()=>{
  const {host,query}=fixture(()=>['b','a'])
  expect(await navigationIds(host,{has:['file'],text:'参考',sort:{kind:'file',field:'name'},dir:'desc'},['image'])).toEqual(['b','a'])
  expect(query).toHaveBeenCalledWith({has:['file','image'],text:'参考',sort:{kind:'file',field:'name'},dir:'desc'})
})
it('自定义视图显式顺序不被仓库默认排序覆盖，去重并排除不匹配项',async()=>{
  const {host,query}=fixture(()=>['a','b'])
  expect(await navigationIds(host,{orderedIds:['b','text','a','b'],text:'筛选'},['image'])).toEqual(['b','a'])
  expect(query).toHaveBeenCalledWith({ids:['b','text','a'],text:'筛选',has:['image']})
})
it('空快照不扩大到全库，指定 ids 仍限制范围，多类型保留来源顺序',async()=>{
  const {host,query}=fixture(q=>q.has?.includes('image')?['a']:q.has?.includes('pdf')?['b']:['b','x','a'])
  expect(await navigationIds(host,{orderedIds:[]},['image'])).toEqual([]);expect(query).not.toHaveBeenCalled()
  expect(await navigationIds(host,{orderedIds:['b','a'],ids:['a']},['image'])).toEqual(['a'])
  expect(query).toHaveBeenLastCalledWith({ids:['a'],has:['image']})
  expect(await navigationIds(host,{},['image','pdf'])).toEqual(['b','a'])
})
