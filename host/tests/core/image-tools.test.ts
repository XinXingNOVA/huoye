import { afterEach, expect, it } from 'vitest'
import { mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import { imageTools } from '../../src/core/images'
import { tempDir } from '../helpers/helpers'
const roots:string[]=[]
const temp=()=>{const p=tempDir('rm-crop-');roots.push(p);return p}
afterEach(()=>roots.splice(0).forEach(p=>rmSync(p,{recursive:true,force:true})))
const options={source:'cache/source.jpg',destination:'cache/crops/region.jpg',region:{x:0,y:0,w:.5,h:1},maxSide:100,quality:90}
it('按 EXIF 转正后的比例裁剪并限制尺寸，保留来源字节',async()=>{
  const root=temp();mkdirSync(join(root,'cache'))
  await sharp({create:{width:400,height:200,channels:3,background:'#ff0000'}}).withMetadata({orientation:6}).jpeg().toFile(join(root,'cache/source.jpg'))
  const bytes=readFileSync(join(root,'cache/source.jpg'))
  expect(await imageTools(root).crop(options,new AbortController().signal)).toEqual({width:25,height:100})
  expect(await sharp(join(root,options.destination)).metadata()).toMatchObject({width:25,height:100,format:'jpeg'})
  expect(readFileSync(join(root,'cache/source.jpg'))).toEqual(bytes)
})
it('拒绝路径越界、外部符号链接和非法区域，取消与解码失败不替换缓存',async()=>{
  const root=temp(),outside=temp(),tools=imageTools(root),signal=new AbortController().signal
  mkdirSync(join(root,'cache/crops'),{recursive:true});writeFileSync(join(root,options.destination),'原缓存')
  writeFileSync(join(outside,'source.jpg'),'不是图片');symlinkSync(join(outside,'source.jpg'),join(root,'cache/linked.jpg'))
  symlinkSync(outside,join(root,'cache/external'))
  await sharp({create:{width:2,height:2,channels:3,background:'#ff0000'}}).jpeg().toFile(join(root,'cache/source.jpg'))
  for(const change of [{source:'../source.jpg'},{source:'cache/linked.jpg'},{destination:'cache/external/new/out.jpg'},{destination:'original.jpg'},{region:{x:.9,y:0,w:.5,h:1}},{maxSide:0}]) {
    await expect(tools.crop({...options,...change},signal)).rejects.toThrow()
  }
  expect(readdirSync(outside)).toEqual(['source.jpg'])
  writeFileSync(join(root,'cache/broken.jpg'),'无效图像')
  await expect(tools.crop({...options,source:'cache/broken.jpg'},signal)).rejects.toThrow()
  const controller=new AbortController();controller.abort()
  await expect(tools.crop(options,controller.signal)).rejects.toThrow()
  expect(readFileSync(join(root,options.destination),'utf8')).toBe('原缓存')
  expect(readdirSync(join(root,'cache/crops'))).toEqual(['region.jpg'])
})

it('读取反斜杠缓存路径，输出仍使用统一相对路径',async()=>{
  const root=temp();mkdirSync(join(root,'cache'))
  await sharp({create:{width:10,height:10,channels:3,background:'#ffffff'}}).png().toFile(join(root,'cache','old.png'))
  expect(await imageTools(root).crop({...options,source:'cache\\old.png'},new AbortController().signal)).toEqual({width:5,height:10})
})
