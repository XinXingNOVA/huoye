import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { BlockKind } from '@resource-manager/plugin-api/blocks'
import { availableColumns, columnKey, moveColumn, readColumns, resolveColumns } from '../columns.ts'
const file: BlockKind = {id:'file',plugin:'file',title:'文件',version:1,rebuildable:false,content:true,fields:{ext:{type:'text',title:'格式'},size:{type:'number',title:'大小'},path:{type:'text',title:'路径',file:true}}}
const template: BlockKind = {id:'tpl:one',template:'one',plugin:'fields',title:'阅读',version:1,rebuildable:false,fields:{f1:{type:'number',title:'评分'},f2:{type:'text',title:'作者'}}}
test('默认模板列跟随定义，自定义列跨块排序并独立于筛选，改名和休眠接续原身份',()=>{
  const kinds=[file,template]
  assert.deepEqual(resolveColumns({}, {has:[template.id]},kinds).map(c=>c.ref.field),['f1','f2'])
  const refs=[{kind:file.id,field:'ext'},{kind:template.id,field:'f2'}]
  const ordered=moveColumn(refs,1,0), options={columnMode:'custom',columns:ordered}
  assert.deepEqual(refs.map(r=>r.field),['ext','f2'])
  assert.deepEqual(resolveColumns(options,{},kinds).map(c=>c.ref),ordered)
  const renamed={...template,dormant:true,fields:{...template.fields,f2:{type:'text' as const,title:'作者姓名'}}}
  const columns=resolveColumns(options,{has:[file.id]},[file,renamed])
  assert.equal(columns[0].column?.def.title,'作者姓名')
  assert.equal(columns[0].column?.kind.dormant,true)
  assert.deepEqual(options.columns,ordered)
  assert.equal(availableColumns(kinds).some(c=>c.field==='path'),false)
})
test('缺失字段保留列位，恢复后接续；清空自定义列不会退回默认，异常配置不破坏原引用',()=>{
  const refs=[{kind:template.id,field:'f1'},{kind:'missing',field:'a.b'}], options={columnMode:'custom',columns:refs}
  assert.deepEqual(resolveColumns(options,{},[]),refs.map(ref=>({ref})))
  assert.equal(resolveColumns(options,{},[template])[0].column?.def.title,'评分')
  assert.equal(resolveColumns(options,{},[template])[1].column,undefined)
  assert.deepEqual(resolveColumns({columnMode:'custom',columns:[]},{has:[template.id]},[template]),[])
  assert.deepEqual(readColumns([null,{},refs[0],refs[0],refs[1],{kind:'a',field:3}]),refs)
  assert.notEqual(columnKey({kind:'a.b',field:'c'}),columnKey({kind:'a',field:'b.c'}))
  assert.equal(moveColumn(refs,-1,0),refs)
})
