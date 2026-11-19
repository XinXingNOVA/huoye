// 自动验收样本：每次生成新的带封面音频，不依赖用户歌曲或预制仓库。
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'

export async function audioCoverFixtures(dir: string, ffmpeg: string) {
  const front = join(dir, 'front.jpg'), back = join(dir, 'back.png')
  await sharp(Buffer.from('<svg width="900" height="900"><rect width="900" height="900" fill="#bc3d30"/><circle cx="450" cy="450" r="260" fill="#edbe73"/><circle cx="450" cy="450" r="110" fill="#bc3d30"/></svg>')).jpeg().toFile(front)
  await sharp({ create: { width: 480, height: 720, channels: 3, background: '#246eb5' } }).png().toFile(back)
  const command = (args: string[]) => execFileSync(ffmpeg, ['-v', 'error', '-y', ...args], { windowsHide: true })
  const covered = ['mp3', 'flac', 'm4a'].map(ext => join(dir, `带封面 ${ext}.${ext}`))
  for (const [i, output] of covered.entries()) command([
    '-f', 'lavfi', '-i', `sine=frequency=${440 + i * 80}:duration=5`, '-i', front,
    '-map', '0:a', '-map', '1:v', '-c:a', ['libmp3lame', 'flac', 'aac'][i], '-c:v', 'copy', '-disposition:v', 'attached_pic',
    '-metadata:s:v', 'title=Album cover', '-metadata:s:v', 'comment=Cover (front)',
    '-metadata', `title=日落唱片 ${i + 1}`, '-metadata', 'artist=封面测试', output
  ])
  const multi = join(dir, '多图 正面优先.mp3')
  command(['-i', covered[0], '-i', back, '-i', front, '-map', '0:a', '-map', '1:v', '-map', '2:v', '-c', 'copy',
    '-disposition:v', 'attached_pic', '-metadata:s:v:0', 'comment=Cover (back)', '-metadata:s:v:1', 'comment=Cover (front)', multi])
  const plain = join(dir, '无封面.wav')
  command(['-f', 'lavfi', '-i', 'sine=frequency=300:duration=3', plain])
  const broken = join(dir, '封面损坏.mp3'), bytes = readFileSync(covered[0]), jpg = readFileSync(front), at = bytes.indexOf(jpg)
  if (at < 0) throw new Error('测试样本的内嵌图未保持原始 JPEG 字节')
  bytes.fill(0, at, at + jpg.length); writeFileSync(broken, bytes)
  return { covered, multi, plain, broken }
}
